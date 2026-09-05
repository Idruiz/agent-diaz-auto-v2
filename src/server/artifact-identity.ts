import type { ArtifactPlan } from "../shared/contracts.js";

const MANIFEST_PREFIX = "AGENT_DIAZ_MANIFEST_V1";

const pad = (index: number) => String(index + 1).padStart(4, "0");

export function presentationSectionId(index: number): string {
  return `sec-${pad(index)}`;
}

export function presentationActivityId(
  index: number,
  activityType: string,
): string {
  return `act-${pad(index)}-${activityType}`;
}

export function presentationIdentityMarkers(
  section: ArtifactPlan["sections"][number],
  index: number,
): string[] {
  const markers = [
    `[${MANIFEST_PREFIX}:section:${presentationSectionId(index)}]`,
  ];
  if (section.activity)
    markers.push(
      `[${MANIFEST_PREFIX}:activity:${presentationActivityId(index, section.activity.type)}]`,
    );
  return markers;
}

export function expectedPresentationIdentityMarkers(
  plan: ArtifactPlan,
): string[] {
  return plan.sections.flatMap((section, index) =>
    presentationIdentityMarkers(section, index),
  );
}

export function extractPresentationIdentityMarkers(
  xmlText: string,
): Set<string> {
  const escapedPrefix = MANIFEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[${escapedPrefix}:[^\\]]+\\]`, "g");
  return new Set(xmlText.match(pattern) ?? []);
}
