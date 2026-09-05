import type { ArtifactPlan, JobKind } from "../shared/contracts.js";

export interface ArtifactVisualPlanReceipt {
  targetSlots: number;
  explicitQueries: number;
  suppressedExplicitQueries: number;
  derivedQueries: number;
  plannedSlots: number;
  eligibleSections: number;
  skippedStructured: number;
  skippedActivities: number;
  disabledByPrompt: boolean;
}

const SOURCE_HEADING_RE = /^(sources|references|bibliography|works cited)$/i;
const NO_IMAGES_RE = /\b(?:no images?|no photos?|text[- ]only|without images?|sans images?|sin im[aá]genes?)\b/i;
const NO_ADDITIONAL_IMAGES_RE = /\b(?:no additional (?:images?|photos?)|do not add (?:additional )?(?:images?|photos?)|(?:use )?only (?:the )?(?:specified|requested|provided|explicit(?:ly)?(?: requested)?) (?:images?|photos?)|only (?:use )?(?:the )?(?:specified|requested|provided|explicit(?:ly)?(?: requested)?) (?:images?|photos?))\b/i;
const SUPPORT_HEADING_RE = /\b(?:directions?|language frames?|sentence frames?|round\s+\d+|continued\s+\d+|exit ticket|guided practice|independent practice|speed dating|four corners)\b/i;
const VISUAL_TOPIC_RE = /\b(?:culture|cultural|history|historic|heritage|city|country|region|place|site|architecture|building|food|cuisine|festival|art|artist|museum|landscape|geography|map|community|people|tradition|science|nature|environment|animal|plant|technology|industry|sport|travel|qu[eé]bec|francophon|montr[eé]al|paris|france|canada|espa[nñ]a|spain|valencia|madrid|barcelona|sevilla|seville|granada|c[oó]rdoba|cordoba)\b/i;
const STOP_WORDS = new Set([
  "about","after","again","also","avec","because","being","dans","des","each","from","have","into","just","more","pour","that","their","them","this","through","une","using","with","your","vous","nous","elle","elles","ils","les","the","and","for","are","was","were","aux","sur","par","que","qui","est","pas","plus","comme","mais","ses","son","sa","ces","dans","une","un","des","du","de","la","le","et","en","au","aux","à","a","an","of","to","in","on","is","it","as","or",
  "context","section","continued","finished","audience","facing","content","implications","implication","conclusion","result","results","overview","summary","language","frames","frame","support","supporting","complete","completed","production","ready","requested","artifact","validation","route",
]);
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

function normalizeWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLocaleLowerCase()));
}

function uniqueWords(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function derivedQuery(plan: ArtifactPlan, section: ArtifactPlan["sections"][number]): string {
  return uniqueWords(
    [...normalizeWords(section.heading), ...normalizeWords(plan.title), ...normalizeWords(section.body)],
    7,
  ).join(" ").trim();
}

function exactRequestedVisualCount(prompt: string): number | null {
  const match = prompt.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d{1,2})\s+(?:licensed\s+|relevant\s+|documentary\s+)?(?:images?|photos?|photographs?)\b/i,
  );
  if (!match || match.index === undefined) return null;
  const before = prompt.slice(Math.max(0, match.index - 28), match.index);
  const after = prompt.slice(match.index + match[0].length, match.index + match[0].length + 24);
  if (/\b(?:at least|minimum(?: of)?|no fewer than)\s*$/i.test(before)) return null;
  if (/^\s*(?:per|for each|on each)\b/i.test(after)) return null;
  const token = match[1]!.toLocaleLowerCase();
  const parsed = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
  return parsed && parsed > 0 ? Math.min(24, parsed) : null;
}

function targetFor(kind: JobKind, sectionCount: number, eligibleCount: number): number {
  if (!eligibleCount) return 0;
  if (kind === "website") return Math.min(12, eligibleCount, Math.max(6, Math.round(sectionCount * 0.7)));
  if (kind === "presentation") return Math.min(10, eligibleCount, Math.max(4, Math.round(sectionCount * 0.33)));
  if (kind === "research") return Math.min(8, eligibleCount, Math.max(3, Math.round(sectionCount * 0.4)));
  if (kind === "document") return Math.min(7, eligibleCount, Math.max(2, Math.round(sectionCount * 0.34)));
  if (kind === "analysis") return Math.min(3, eligibleCount, Math.max(1, Math.round(sectionCount * 0.18)));
  return 0;
}

function scoreSection(kind: JobKind, section: ArtifactPlan["sections"][number], index: number): number {
  let score = 0;
  const text = `${section.heading} ${section.body}`;
  if (VISUAL_TOPIC_RE.test(text)) score += 8;
  if (section.layout === "gallery" || section.layout === "title") score += 5;
  if (section.body.length >= 90) score += 2;
  if (index === 0 && (kind === "website" || kind === "presentation")) score += 3;
  if (kind === "analysis" && !VISUAL_TOPIC_RE.test(text)) score -= 5;
  return score;
}

export function planArtifactVisuals(
  kind: JobKind,
  input: ArtifactPlan,
  prompt = "",
): { plan: ArtifactPlan; receipt: ArtifactVisualPlanReceipt } {
  const plan = structuredClone(input);
  const disabledByPrompt = NO_IMAGES_RE.test(prompt) || NO_ADDITIONAL_IMAGES_RE.test(prompt);
  let explicitQueries = 0;
  let skippedStructured = 0;
  let skippedActivities = 0;

  const eligible: Array<{ index: number; score: number; query: string; explicit: boolean }> = [];
  for (const [index, section] of plan.sections.entries()) {
    if (SOURCE_HEADING_RE.test(section.heading.trim())) continue;
    if (section.table || section.chart || section.diagram) {
      skippedStructured++;
      continue;
    }
    if (section.activity || SUPPORT_HEADING_RE.test(section.heading)) {
      skippedActivities++;
      continue;
    }
    const sectionText = `${section.heading} ${section.body}`;
    if (kind === "analysis" && !VISUAL_TOPIC_RE.test(sectionText)) continue;
    const explicitQuery = section.imageQuery?.trim();
    if (explicitQuery) explicitQueries++;
    const query = explicitQuery || derivedQuery(plan, section);
    if (!query) continue;
    eligible.push({
      index,
      score: scoreSection(kind, section, index),
      query,
      explicit: Boolean(explicitQuery),
    });
  }

  // Builder fixtures without a real user prompt preserve authored image queries.
  // In production, model-authored imageQuery fields are proposals, not permission
  // to launch an unbounded provider fan-out. An exact user-requested count may
  // override the normal budget; otherwise the deterministic budget wins.
  const mayDerive = Boolean(prompt.trim()) && !disabledByPrompt;
  const exactCount = mayDerive ? exactRequestedVisualCount(prompt) : null;
  const automaticTarget = targetFor(kind, plan.sections.length, eligible.length);
  const targetSlots = !prompt.trim() || disabledByPrompt
    ? explicitQueries
    : Math.min(
        eligible.length,
        exactCount === null ? automaticTarget : exactCount,
      );

  let suppressedExplicitQueries = 0;
  if (mayDerive && explicitQueries > targetSlots) {
    const keep = new Set(
      eligible
        .filter((item) => item.explicit)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, targetSlots)
        .map((item) => item.index),
    );
    for (const item of eligible.filter((candidate) => candidate.explicit)) {
      if (keep.has(item.index)) continue;
      plan.sections[item.index]!.imageQuery = undefined;
      item.explicit = false;
      suppressedExplicitQueries++;
    }
  }

  const retainedExplicit = plan.sections.filter((section) => Boolean(section.imageQuery?.trim())).length;
  const needed = Math.max(0, targetSlots - retainedExplicit);
  const usedQueries = new Set(
    plan.sections
      .map((section) => section.imageQuery?.trim().toLocaleLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  let derivedQueries = 0;
  if (mayDerive) {
    for (const candidate of eligible
      .filter((item) => !plan.sections[item.index]!.imageQuery)
      .sort((a, b) => b.score - a.score || a.index - b.index)) {
      if (derivedQueries >= needed) break;
      const key = candidate.query.toLocaleLowerCase();
      if (usedQueries.has(key)) continue;
      plan.sections[candidate.index]!.imageQuery = candidate.query;
      usedQueries.add(key);
      derivedQueries++;
    }
  }

  const plannedSlots = plan.sections.filter((section) => Boolean(section.imageQuery?.trim())).length;
  return {
    plan,
    receipt: {
      targetSlots,
      explicitQueries,
      suppressedExplicitQueries,
      derivedQueries,
      plannedSlots,
      eligibleSections: eligible.length,
      skippedStructured,
      skippedActivities,
      disabledByPrompt,
    },
  };
}
