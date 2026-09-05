import type { ArtifactPlan } from "../shared/contracts.js";

const VISUAL_REFERENCE_RE =
  /\b(?:image|images|photo|photos|picture|pictures|carte|cartes|map|maps|regardez|regarde|look\s+at|observe|observez|observa|observad|imagen|imágenes|foto|fotos|mapa|mapas)\b/i;

export interface PresentationReconciliation {
  sectionIndex: number;
  heading: string;
  reason: string;
  /** Legacy field retained for receipt compatibility. Reconciliation no longer
   * deletes audience-facing copy merely because an optional image failed. */
  movedToSpeakerNotes: string[];
  preservedVisibleReferences: string[];
}

export interface ReconciledPresentationPlan {
  plan: ArtifactPlan;
  reconciliations: PresentationReconciliation[];
}

const GENERIC_FOUR_CORNERS_LABEL_RE =
  /^(?:corner|coin|option|choice)\s*[A-D1-4]$/i;

export const FOUR_CORNERS_LABEL_REPAIR_MESSAGE =
  "Four Corners labels must be the four choices themselves (e.g. the four verb forms), not Corner A–D.";

export function isGenericFourCornersLabel(value: string): boolean {
  const label = value.trim();
  if (GENERIC_FOUR_CORNERS_LABEL_RE.test(label)) return true;
  const meaningfulWords =
    label
      .normalize("NFKD")
      .match(/[\p{L}\p{N}]+(?:['’’-][\p{L}\p{N}]+)*/gu) ?? [];
  return meaningfulWords.length < 2;
}

export function hasVisibleVisualReference(value: string): boolean {
  return VISUAL_REFERENCE_RE.test(value);
}

export function reconcilePresentationPlan(
  input: ArtifactPlan,
  placedImageQueries: Set<string>,
): ReconciledPresentationPlan {
  const plan = structuredClone(input);
  const reconciliations: PresentationReconciliation[] = [];

  plan.sections.forEach((section, sectionIndex) => {
    const requestedImage = section.imageQuery?.trim();
    const imageAvailable =
      Boolean(requestedImage) &&
      placedImageQueries.has(requestedImage!);
    if (imageAvailable) return;

    // Optional asset failure is not permission to delete instructional content.
    // Preserve the exact audience-facing copy and record the missing visual for
    // honest diagnostics. This keeps semantic validation meaningful: the final
    // artifact must still contain what the accepted plan promised.
    const preservedVisibleReferences = [
      ...section.body
        .split(/(?<=[.!?;:])\s+|\n+/u)
        .map((part) => part.trim())
        .filter((part) => part && hasVisibleVisualReference(part)),
      ...section.bullets.filter(hasVisibleVisualReference),
      ...(section.activity?.directions.filter(hasVisibleVisualReference) ?? []),
      ...(section.activity?.prompts.filter(hasVisibleVisualReference) ?? []),
      ...(section.activity?.sentenceFrames.filter(hasVisibleVisualReference) ?? []),
    ];

    if (!preservedVisibleReferences.length) return;
    section.speakerNotes = [
      section.speakerNotes.trim(),
      `Licensed visual unavailable for query: ${requestedImage || "unspecified"}. Audience-facing visual references were preserved instead of silently deleting them.`,
    ]
      .filter(Boolean)
      .join("\n");
    reconciliations.push({
      sectionIndex,
      heading: section.heading,
      reason:
        "The requested visual was unavailable; audience-facing references were preserved exactly and the missing asset was recorded in notes/receipt diagnostics.",
      movedToSpeakerNotes: [],
      preservedVisibleReferences,
    });
  });

  return { plan, reconciliations };
}
