import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { ArtifactNormalizationReceipt } from "./artifact-quality.js";

const MAX_PRESENTATION_BODY = 440;
const MAX_PRESENTATION_BULLETS = 5;
const MAX_HEADING = 92;

function chunks(value: string, maxChars: number): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + " " + word).length <= maxChars) current += " " + word;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function continuationHeading(base: string, index: number): string {
  const suffix = ` — continued ${index}`;
  const available = Math.max(12, MAX_HEADING - suffix.length);
  return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function labelledHeading(base: string, label: string): string {
  const suffix = ` — ${label}`;
  const available = Math.max(12, MAX_HEADING - suffix.length);
  return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function standardFragments(
  section: ArtifactPlan["sections"][number],
): ArtifactPlan["sections"] {
  const bodyChunks = chunks(section.body, MAX_PRESENTATION_BODY);
  const bulletGroups = Array.from(
    {
      length: Math.max(
        1,
        Math.ceil(section.bullets.length / MAX_PRESENTATION_BULLETS),
      ),
    },
    (_, index) =>
      section.bullets.slice(
        index * MAX_PRESENTATION_BULLETS,
        index * MAX_PRESENTATION_BULLETS + MAX_PRESENTATION_BULLETS,
      ),
  );
  const count = Math.max(bodyChunks.length, bulletGroups.length);
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(section),
    heading:
      index === 0
        ? section.heading
        : continuationHeading(section.heading, index + 1),
    body: bodyChunks[index] ?? "",
    bullets: bulletGroups[index] ?? [],
    imageQuery: index === 0 ? section.imageQuery : undefined,
  }));
}

function supportingFragments(
  section: ArtifactPlan["sections"][number],
  body: string,
  bullets: string[],
  label = "context",
): ArtifactPlan["sections"] {
  if (!body.trim() && bullets.length === 0) return [];
  const source = {
    ...structuredClone(section),
    heading: labelledHeading(section.heading, label),
    body: body.replace(/\s+/g, " ").trim(),
    bullets: [...bullets],
    layout: "standard" as const,
    activity: undefined,
    table: undefined,
    chart: undefined,
    diagram: undefined,
    imageQuery: undefined,
  };
  return standardFragments(source);
}

function activityLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Converts a semantic ArtifactPlan into a render-admissible plan before any PPTX
 * bytes are written. This stage owns pagination and renderer capability gaps.
 * Builders must not discover fit failures after serialization and must not delete
 * semantic content with slice()/ellipsis. Any audience-facing semantic copy that
 * a specialized template cannot render is materialized on deterministic context
 * slides instead.
 */
export function compileArtifactPlan(
  kind: JobKind,
  input: ArtifactPlan,
): { plan: ArtifactPlan; normalizations: ArtifactNormalizationReceipt[] } {
  if (kind !== "presentation")
    return { plan: structuredClone(input), normalizations: [] };

  const plan = structuredClone(input);
  const compiled: ArtifactPlan["sections"] = [];
  const normalizations: ArtifactNormalizationReceipt[] = [];

  for (const section of plan.sections) {
    const structured = Boolean(section.table || section.chart || section.diagram);
    if (structured) {
      const context = supportingFragments(
        section,
        section.body,
        section.bullets,
      );
      compiled.push(...context);
      if (context.length)
        normalizations.push({
          code: "presentation_content_reflowed",
          detail: `Materialized ${context.length} audience-context slide(s) for '${section.heading}' because its structured visual template does not render the full narrative and bullet fields.`,
        });
      const primary = structuredClone(section);
      // Table/chart/diagram content remains on the specialized slide. Original
      // audience narrative is already present exactly once in context above.
      primary.body = "";
      primary.bullets = [];
      compiled.push(primary);
      continue;
    }

    const activity = section.activity;
    if (!activity) {
      const fragments = standardFragments(section);
      compiled.push(...fragments);
      if (fragments.length > 1)
        normalizations.push({
          code: "presentation_content_paginated",
          detail: `Split '${section.heading}' into ${fragments.length} deterministic slides to preserve all audience-facing content.`,
        });
      continue;
    }

    // An already-compiled activity section has had verbose setup copy moved to
    // deterministic support slides. Original model plans cannot arrive in this
    // state because ArtifactActivitySchema requires at least two directions.
    // This makes the compiler idempotent when AgentRunner and buildArtifact both
    // invoke it.
    if (
      activity.directions.length === 0 &&
      activity.sentenceFrames.length === 0 &&
      section.bullets.length === 0
    ) {
      compiled.push(structuredClone(section));
      continue;
    }

    const context = supportingFragments(
      section,
      section.body,
      section.bullets,
      "context",
    );
    compiled.push(...context);
    if (context.length)
      normalizations.push({
        code: "presentation_activity_context_reflowed",
        detail: `Materialized ${context.length} context slide(s) for '${section.heading}' so narrative copy never competes with the activity surface.`,
      });

    const directionSlides = supportingFragments(
      section,
      "",
      activity.directions,
      "directions",
    );
    compiled.push(...directionSlides);
    if (directionSlides.length)
      normalizations.push({
        code: "presentation_activity_directions_reflowed",
        detail: `Materialized ${directionSlides.length} directions slide(s) for '${section.heading}' so every instruction remains readable at normal classroom size.`,
      });

    const frameSlides = supportingFragments(
      section,
      "",
      activity.sentenceFrames,
      "language frames",
    );
    compiled.push(...frameSlides);
    if (frameSlides.length)
      normalizations.push({
        code: "presentation_activity_frames_reflowed",
        detail: `Materialized ${frameSlides.length} language-frame slide(s) for '${section.heading}' instead of shrinking frames into an undersized activity box.`,
      });

    const promptsPerSlide =
      activity.type === "four_corners"
        ? 1
        : activity.type === "speed_dating"
          ? 4
          : 3;
    const promptGroups = Array.from(
      { length: Math.ceil(activity.prompts.length / promptsPerSlide) },
      (_, index) =>
        activity.prompts.slice(
          index * promptsPerSlide,
          index * promptsPerSlide + promptsPerSlide,
        ),
    );

    promptGroups.forEach((prompts, index) => {
      const primary = structuredClone(section);
      primary.heading =
        index === 0
          ? section.heading
          : labelledHeading(section.heading, `round ${index + 1}`);
      primary.body =
        activity.type === "speed_dating"
          ? ""
          : activity.type === "four_corners"
            ? "Choose a corner and explain your choice."
            : activityLabel(activity.type);
      primary.bullets = [];
      primary.activity = {
        ...structuredClone(activity),
        directions: [],
        sentenceFrames: [],
        prompts,
      };
      primary.imageQuery = index === 0 ? section.imageQuery : undefined;
      compiled.push(primary);
    });

    if (promptGroups.length > 1)
      normalizations.push({
        code: "presentation_activity_paginated",
        detail: `Expanded '${section.heading}' into ${promptGroups.length} activity round slides so prompt cards stay readable without truncation or extreme auto-shrink.`,
      });
  }

  plan.sections = compiled;
  return { plan, normalizations };
}
