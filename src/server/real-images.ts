import sharp from "sharp";

export interface RealImage {
  bytes: Buffer;
  extension: "jpg" | "png" | "webp";
  mime: string;
  width: number;
  height: number;
  title: string;
  creator: string;
  license: string;
  sourceUrl: string;
}

export interface CommonsImageCandidate {
  id: string;
  title: string;
  description: string;
  categories: string[];
  creator: string;
  license: string;
  width: number;
  height: number;
  thumbUrl: string;
  sourceUrl: string;
  query: string;
}

export interface CandidateRejection {
  candidateId: string;
  title: string;
  reason: string;
}

export interface ImageProviderEvent {
  type: "rate_limit" | "cooldown_wait" | "retry";
  status?: number;
  waitMs: number;
  attempt: number;
}
export type ImageProviderEventHandler = (event: ImageProviderEvent) => void;
export interface ImageProviderOptions {
  onEvent?: ImageProviderEventHandler;
}

const EXCLUDED_SUBJECT_RE =
  /\b(?:nude|naked|corpse|funeral|memorial|injury|blood|protest|riot|homeless|sleeping person|drunk|police|weapon|logo|flag|map|screenshot|scan|book cover)\b/i;
const ALLOWED_LICENSE_RE =
  /^(?:CC(?:\s|[-]?)(?:BY|BY-SA|BY-NC|BY-NC-SA|0)\b|CC0\b|Public domain\b|PD\b)/i;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.5;
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const PROVIDER_MAX_CONCURRENCY = 2;

let providerActive = 0;
const providerWaiters: Array<() => void> = [];
let commonsCooldownUntil = 0;
let commons429Streak = 0;

const text = (value: unknown) =>
  String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
class PermanentImageProviderError extends Error {}

async function acquireProviderSlot(): Promise<() => void> {
  if (providerActive >= PROVIDER_MAX_CONCURRENCY)
    await new Promise<void>((resolve) => providerWaiters.push(resolve));
  providerActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    providerActive = Math.max(0, providerActive - 1);
    providerWaiters.shift()?.();
  };
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - Date.now())) : 0;
}

async function waitForCommonsCooldown(onEvent: ImageProviderEventHandler | undefined, attempt: number): Promise<void> {
  const waitMs = Math.max(0, commonsCooldownUntil - Date.now());
  if (!waitMs) return;
  onEvent?.({ type: "cooldown_wait", waitMs, attempt });
  await sleep(waitMs);
}

async function fetchWithRetry(
  url: URL | string,
  init: RequestInit,
  options: { attempts?: number; timeoutMs?: number; onEvent?: ImageProviderEventHandler } = {},
): Promise<Response> {
  const attempts = options.attempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let last: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForCommonsCooldown(options.onEvent, attempt + 1);
    const release = await acquireProviderSlot();
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        commons429Streak = 0;
        return response;
      }
      if (!RETRYABLE_HTTP.has(response.status))
        throw new PermanentImageProviderError(`Image provider returned ${response.status}`);
      if (response.status === 429) {
        commons429Streak++;
        const waitMs = Math.max(
          retryAfterMs(response),
          Math.min(15_000, (process.env.NODE_ENV === "test" ? 25 : 3_000) * Math.max(1, commons429Streak)),
        );
        commonsCooldownUntil = Math.max(commonsCooldownUntil, Date.now() + waitMs);
        options.onEvent?.({ type: "rate_limit", status: 429, waitMs, attempt: attempt + 1 });
        last = new Error("Image provider temporarily unavailable (429)");
      } else {
        const waitMs = Math.min(4_000, 700 * 2 ** attempt);
        options.onEvent?.({ type: "retry", status: response.status, waitMs, attempt: attempt + 1 });
        last = new Error(`Image provider temporarily unavailable (${response.status})`);
        if (attempt < attempts - 1) await sleep(waitMs);
      }
    } catch (error) {
      if (error instanceof PermanentImageProviderError) throw error;
      last = error instanceof Error ? error : new Error("Image provider request failed");
      if (attempt < attempts - 1 && !/429/.test(last.message)) {
        const waitMs = Math.min(4_000, 700 * 2 ** attempt);
        options.onEvent?.({ type: "retry", waitMs, attempt: attempt + 1 });
        await sleep(waitMs);
      }
    } finally {
      release();
    }
  }
  throw last ?? new Error("Image provider request failed");
}

export function resetImageProviderStateForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Image provider reset is test-only");
  commonsCooldownUntil = 0;
  commons429Streak = 0;
}

export function imageCandidateRejectionReason(candidate: CommonsImageCandidate): string | null {
  if (!ALLOWED_LICENSE_RE.test(candidate.license))
    return `license '${candidate.license || "missing"}' is not CC/PD`;
  if (candidate.width < MIN_WIDTH || candidate.height < MIN_HEIGHT)
    return `dimensions ${candidate.width}×${candidate.height} are below ${MIN_WIDTH}×${MIN_HEIGHT}`;
  const aspect = candidate.height > 0 ? candidate.width / candidate.height : 0;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT)
    return `aspect ratio ${aspect.toFixed(2)} is outside ${MIN_ASPECT}–${MAX_ASPECT}`;
  const haystack = [candidate.title, candidate.description, ...candidate.categories].join(" ");
  if (EXCLUDED_SUBJECT_RE.test(haystack))
    return "metadata matches the classroom-safety exclusion list";
  return null;
}

export async function normalizeLicensedImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Image exceeded 10 MB limit");
  if (bytes.length < 1000) throw new Error("Image download was unexpectedly small");
  return sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

function searchVariants(query: string): string[] {
  const normalized = text(query);
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2);
  return [normalized, tokens.slice(0, 7).join(" "), tokens.slice(0, 5).join(" ")].filter(
    (value, index, all) => Boolean(value) && all.indexOf(value) === index,
  );
}

export async function searchCommonsCandidates(
  query: string,
  limit = 8,
  options: ImageProviderOptions = {},
): Promise<{ candidates: CommonsImageCandidate[]; rejected: CandidateRejection[] }> {
  const accepted = new Map<string, CommonsImageCandidate>();
  const rejected = new Map<string, CandidateRejection>();

  for (const variant of searchVariants(query)) {
    if (accepted.size >= limit) break;
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.searchParams.set("action", "query");
    api.searchParams.set("generator", "search");
    api.searchParams.set("gsrsearch", `${variant} filetype:bitmap`);
    api.searchParams.set("gsrnamespace", "6");
    api.searchParams.set("gsrlimit", String(Math.max(limit, 8)));
    api.searchParams.set("prop", "imageinfo|categories");
    api.searchParams.set("iiprop", "url|size|extmetadata");
    api.searchParams.set("iiurlwidth", "1600");
    api.searchParams.set("cllimit", "max");
    api.searchParams.set("format", "json");
    api.searchParams.set("origin", "*");

    const response = await fetchWithRetry(
      api,
      { headers: { "User-Agent": "AgentDiaz/3.5 (licensed educational artifact builder)" } },
      { attempts: 2, timeoutMs: 15_000, onEvent: options.onEvent },
    );
    const json: any = await response.json();
    const pages = Object.values(json?.query?.pages ?? {}) as any[];

    for (const page of pages) {
      if (accepted.size >= limit) break;
      const ii = page.imageinfo?.[0];
      if (!ii?.thumburl || !/\.(?:jpe?g|png|webp)(?:[/?]|$)/i.test(String(ii.thumburl))) continue;
      const meta = ii.extmetadata ?? {};
      const candidate: CommonsImageCandidate = {
        id: String(page.pageid ?? page.title ?? ii.thumburl),
        title: text(meta.ObjectName?.value || page.title).slice(0, 220),
        description: text(meta.ImageDescription?.value).slice(0, 500),
        categories: (page.categories ?? [])
          .map((category: any) => text(category.title).replace(/^Category:/i, ""))
          .filter(Boolean)
          .slice(0, 24),
        creator: text(meta.Artist?.value || meta.Credit?.value || "Wikimedia Commons contributor").slice(0, 220),
        license: text(meta.LicenseShortName?.value || meta.UsageTerms?.value).slice(0, 120),
        width: Number(ii.width || 0),
        height: Number(ii.height || 0),
        thumbUrl: String(ii.thumburl),
        sourceUrl: String(meta.CanonicalPage?.value || ii.descriptionurl || ii.url),
        query,
      };
      const reason = imageCandidateRejectionReason(candidate);
      if (reason) {
        rejected.set(candidate.id, { candidateId: candidate.id, title: candidate.title, reason });
        continue;
      }
      if (!accepted.has(candidate.id)) accepted.set(candidate.id, candidate);
    }
  }

  return { candidates: [...accepted.values()].slice(0, limit), rejected: [...rejected.values()] };
}

export async function downloadCommonsCandidate(
  candidate: CommonsImageCandidate,
  options: ImageProviderOptions = {},
): Promise<RealImage> {
  const response = await fetchWithRetry(
    candidate.thumbUrl,
    { headers: { "User-Agent": "AgentDiaz/3.5" } },
    { attempts: 2, timeoutMs: 20_000, onEvent: options.onEvent },
  );
  const downloaded = Buffer.from(await response.arrayBuffer());
  const bytes = await normalizeLicensedImage(downloaded);
  const dimensions = await sharp(bytes).metadata();
  if (!dimensions.width || !dimensions.height) throw new Error("Normalized image has no dimensions");
  return {
    bytes,
    extension: "jpg",
    mime: "image/jpeg",
    width: dimensions.width,
    height: dimensions.height,
    title: candidate.title,
    creator: candidate.creator,
    license: candidate.license,
    sourceUrl: candidate.sourceUrl,
  };
}

export async function fetchCommonsImage(query: string): Promise<RealImage> {
  const { candidates } = await searchCommonsCandidates(query, 1);
  const candidate = candidates[0];
  if (!candidate) throw new Error(`No usable licensed image candidates found for '${query}'`);
  return downloadCommonsCandidate(candidate);
}
