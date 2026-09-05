import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  searchCommonsCandidates,
  type CommonsImageCandidate,
  type ImageProviderEventHandler,
} from "./real-images.js";
import { log } from "./log.js";

export interface ImageJudgeSection {
  sectionIndex: number;
  heading: string;
  body: string;
  audience: string;
  query: string;
  candidates: CommonsImageCandidate[];
}

export interface ImageJudgeDecision {
  sectionIndex: number;
  chosenCandidate: string | null;
  reason: string;
  fallbackQueries: [string, string];
}

export interface ImageJudgeResult {
  decisions: ImageJudgeDecision[];
  judgeCalls: number;
}

export interface ImageJudgeProgressOptions {
  onProviderEvent?: ImageProviderEventHandler;
  onProgress?: (message: string, completed: number, total: number) => void;
}

export type ImageJudgeProvider = (
  sections: ImageJudgeSection[],
) => Promise<ImageJudgeDecision[]>;

let injectedTestProvider: ImageJudgeProvider | null = null;

export function setImageJudgeProviderForTests(provider: ImageJudgeProvider | null): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Image-judge provider injection is test-only");
  injectedTestProvider = provider;
}

const decisionSchema = z.object({
  decisions: z.array(
    z.object({
      sectionIndex: z.number().int().nonnegative(),
      chosenCandidate: z.string().nullable(),
      reason: z.string().min(1).max(500),
      fallbackQueries: z.array(z.string().min(2).max(120)).length(2),
    }),
  ),
});

function sanitizeDecision(
  section: ImageJudgeSection,
  decision: z.infer<typeof decisionSchema>["decisions"][number] | undefined,
): ImageJudgeDecision {
  const candidateIds = new Set(section.candidates.map((candidate) => candidate.id));
  const chosen = decision?.chosenCandidate && candidateIds.has(decision.chosenCandidate)
    ? decision.chosenCandidate
    : null;
  const fallback = decision?.fallbackQueries ?? [section.heading, section.query];
  return {
    sectionIndex: section.sectionIndex,
    chosenCandidate: chosen,
    reason: decision?.reason?.trim() || (chosen
      ? "Chosen candidate is the best available topical match."
      : "No candidate met the qualitative relevance bar."),
    fallbackQueries: [
      fallback[0]?.trim() || section.heading,
      fallback[1]?.trim() || section.query,
    ],
  };
}

async function openAiJudgePass(
  config: Config,
  sections: ImageJudgeSection[],
): Promise<ImageJudgeDecision[]> {
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const compact = sections.map((section) => ({
    sectionIndex: section.sectionIndex,
    heading: section.heading,
    body: section.body,
    audience: section.audience,
    query: section.query,
    candidates: section.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      categories: candidate.categories,
      license: candidate.license,
      width: candidate.width,
      height: candidate.height,
    })),
  }));

  const response = await client.responses.create({
    model: config.OPENAI_FAST_MODEL,
    reasoning: { effort: "low" },
    instructions: [
      "You are the single qualitative image-relevance judge for one educational artifact.",
      "Return one decision for every supplied sectionIndex.",
      "Use the supplied audience field; do not assume a particular grade level.",
      "Choose the best available candidate whenever at least one candidate is clearly relevant enough for the requested subject, place, culture, and audience; do not demand a perfect photograph.",
      "Reject text-heavy images, people in distress, demeaning imagery, wrong-country stock-photo clichés, or candidates whose metadata clearly contradicts the requested subject/place.",
      "Use chosenCandidate=null only when the available candidates are genuinely wrong, unsafe, or too ambiguous to use responsibly.",
      "For every section provide exactly two short fallback search queries grounded in the section heading/body and real location or subject.",
      "Do not infer visual facts that are absent from candidate metadata.",
    ].join("\n"),
    input: JSON.stringify(compact),
    text: { format: zodTextFormat(decisionSchema, "artifact_image_judgment") },
    store: false,
    safety_identifier: "agent-diaz-owner",
  } as any);

  let parsed: z.infer<typeof decisionSchema>;
  try {
    parsed = decisionSchema.parse(JSON.parse(response.output_text || "{}"));
  } catch (error) {
    throw new Error(
      `Image judge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return sections.map((section) =>
    sanitizeDecision(
      section,
      parsed.decisions.find((decision) => decision.sectionIndex === section.sectionIndex),
    ),
  );
}

async function judgePass(
  config: Config,
  sections: ImageJudgeSection[],
): Promise<{ decisions: ImageJudgeDecision[]; calls: number }> {
  if (!sections.length) return { decisions: [], calls: 0 };
  if (injectedTestProvider) {
    const raw = await injectedTestProvider(sections);
    return {
      decisions: sections.map((section) =>
        sanitizeDecision(
          section,
          raw.find((decision) => decision.sectionIndex === section.sectionIndex),
        ),
      ),
      calls: 1,
    };
  }
  if (config.NODE_ENV === "test") {
    return {
      decisions: sections.map((section) => ({
        sectionIndex: section.sectionIndex,
        chosenCandidate: section.candidates[0]?.id ?? null,
        reason: section.candidates[0]
          ? "Deterministic test-only candidate selection."
          : "No filtered candidate was available.",
        fallbackQueries: [section.heading, section.query],
      })),
      calls: 0,
    };
  }
  return { decisions: await openAiJudgePass(config, sections), calls: 1 };
}

export async function judgeImageCandidates(
  config: Config,
  sections: ImageJudgeSection[],
  options: ImageJudgeProgressOptions = {},
): Promise<ImageJudgeResult> {
  if (!sections.length) return { decisions: [], judgeCalls: 0 };

  options.onProgress?.("Judging image candidates", 0, sections.length);
  const first = await judgePass(config, sections);
  let judgeCalls = first.calls;
  const merged = new Map<number, ImageJudgeDecision>(
    first.decisions.map((decision) => [decision.sectionIndex, decision]),
  );
  options.onProgress?.("Judged initial image candidates", sections.length, sections.length);

  const fallbackSections: ImageJudgeSection[] = [];
  let fallbackCompleted = 0;
  const fallbackTotal = sections.filter(
    (section) => !merged.get(section.sectionIndex)?.chosenCandidate,
  ).length;

  for (const section of sections) {
    const decision = merged.get(section.sectionIndex);
    if (decision?.chosenCandidate) continue;

    const existingIds = new Set(section.candidates.map((candidate) => candidate.id));
    const newCandidates: CommonsImageCandidate[] = [];
    const fallbackQueries = decision?.fallbackQueries ?? [section.heading, section.query];
    options.onProgress?.(
      `Searching fallback visuals for ${section.heading}`,
      fallbackCompleted,
      Math.max(1, fallbackTotal),
    );

    for (const fallbackQuery of fallbackQueries) {
      if (section.candidates.length + newCandidates.length >= 8) break;
      try {
        const result = await searchCommonsCandidates(
          fallbackQuery,
          8 - section.candidates.length - newCandidates.length,
          { onEvent: options.onProviderEvent },
        );
        for (const candidate of result.candidates) {
          if (existingIds.has(candidate.id)) continue;
          existingIds.add(candidate.id);
          newCandidates.push(candidate);
          if (section.candidates.length + newCandidates.length >= 8) break;
        }
      } catch (error) {
        log("warn", "artifact.image_fallback_search_failed", {
          sectionIndex: section.sectionIndex,
          query: section.query,
          fallbackQuery,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    fallbackCompleted++;
    if (!newCandidates.length) {
      log("info", "artifact.image_fallback_search_exhausted", {
        sectionIndex: section.sectionIndex,
        query: section.query,
        fallbackQueries,
        existingCandidates: section.candidates.length,
      });
      options.onProgress?.(
        `Fallback visuals exhausted for ${section.heading}`,
        fallbackCompleted,
        Math.max(1, fallbackTotal),
      );
      continue;
    }

    section.candidates.push(...newCandidates);
    log("info", "artifact.image_fallback_candidates", {
      sectionIndex: section.sectionIndex,
      query: section.query,
      fallbackQueries,
      addedCandidates: newCandidates.length,
      totalCandidates: section.candidates.length,
    });
    fallbackSections.push(section);
    options.onProgress?.(
      `Found fallback candidates for ${section.heading}`,
      fallbackCompleted,
      Math.max(1, fallbackTotal),
    );
  }

  if (fallbackSections.length) {
    options.onProgress?.("Judging fallback image candidates", 0, fallbackSections.length);
    const second = await judgePass(config, fallbackSections);
    judgeCalls += second.calls;
    for (const decision of second.decisions) merged.set(decision.sectionIndex, decision);
    options.onProgress?.("Judged fallback image candidates", fallbackSections.length, fallbackSections.length);
  }

  return {
    decisions: sections.map((section) =>
      merged.get(section.sectionIndex) ?? {
        sectionIndex: section.sectionIndex,
        chosenCandidate: null,
        reason: "No candidate met the qualitative relevance bar after one bounded fallback search pass.",
        fallbackQueries: [section.heading, section.query],
      },
    ),
    judgeCalls,
  };
}
