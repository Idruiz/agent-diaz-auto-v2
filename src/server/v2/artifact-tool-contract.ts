import { z } from "zod";
import {
  ArtifactLayoutSchema,
  ArtifactPlanSchema,
  type ArtifactPlan,
} from "../../shared/contracts.js";

const V2ArtifactRequirementInputSchema = z.object({
  id: z.string().regex(/^R[1-9][0-9]*$/).max(8),
  text: z.string().min(2).max(400),
  mandatory: z.boolean().nullable().optional(),
});

const V2ArtifactActivityInputSchema = z.object({
  type: z.enum([
    "speed_dating",
    "four_corners",
    "guided_practice",
    "independent_practice",
    "discussion",
    "exit_ticket",
  ]),
  durationMinutes: z.number().int().min(1).max(120),
  directions: z.array(z.string().min(2).max(180)).min(2).max(5),
  prompts: z.array(z.string().min(2).max(240)).min(1).max(6),
  sentenceFrames: z
    .array(z.string().min(2).max(180))
    .max(4)
    .nullable()
    .optional(),
  cornerLabels: z
    .array(z.string().min(1).max(80))
    .max(4)
    .nullable()
    .optional(),
});

const V2ArtifactTableInputSchema = z.object({
  title: z.string().max(140),
  headers: z.array(z.string().max(100)).min(2).max(8),
  rows: z
    .array(z.array(z.string().max(300)).min(2).max(8))
    .min(1)
    .max(30),
});

const V2ArtifactChartInputSchema = z.object({
  title: z.string().max(120),
  type: z.enum(["bar", "line", "pie", "donut"]),
  labels: z.array(z.string().max(80)).min(2).max(12),
  series: z
    .array(
      z.object({
        name: z.string().max(100),
        values: z.array(z.number().finite()).min(2).max(12),
      }),
    )
    .min(1)
    .max(5),
  unit: z.string().max(40).nullable().optional(),
  sourceNote: z.string().max(180).nullable().optional(),
});

const V2ArtifactDiagramInputSchema = z.object({
  title: z.string().max(120),
  nodes: z.array(z.string().max(100)).min(2).max(8),
  caption: z.string().max(300).nullable().optional(),
});

const V2ArtifactSectionInputSchema = z.object({
  heading: z.string().min(1).max(92),
  body: z.string().min(1).max(8000),
  bullets: z.array(z.string().max(180)).max(12).nullable().optional(),
  speakerNotes: z.string().max(2000).nullable().optional(),
  requirementIds: z
    .array(z.string().regex(/^R[1-9][0-9]*$/).max(8))
    .max(30)
    .nullable()
    .optional(),
  layout: ArtifactLayoutSchema.nullable().optional(),
  activity: V2ArtifactActivityInputSchema.nullable().optional(),
  table: V2ArtifactTableInputSchema.nullable().optional(),
  chart: V2ArtifactChartInputSchema.nullable().optional(),
  diagram: V2ArtifactDiagramInputSchema.nullable().optional(),
  imageQuery: z.string().min(2).max(180).nullable().optional(),
});

export const V2ArtifactPlanToolInputSchema = z.object({
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).nullable().optional(),
  requirements: z
    .array(V2ArtifactRequirementInputSchema)
    .min(1)
    .max(30)
    .nullable()
    .optional(),
  sections: z.array(V2ArtifactSectionInputSchema).min(1).max(30),
  pages: z
    .array(
      z.object({
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(50),
        title: z.string().min(1).max(120),
        description: z.string().max(240).nullable().optional(),
        sectionHeadings: z.array(z.string().min(1).max(180)).min(1).max(10),
      }),
    )
    .min(1)
    .max(6)
    .nullable()
    .optional(),
  // Keep provider-facing JSON Schema deliberately format-free. OpenAI strict
  // function schemas reject JSON Schema format:"uri" even though Zod emits it
  // for .url(). Canonical URL validation still runs immediately after tool
  // parsing in normalizeV2ArtifactPlanToolInput via ArtifactPlanSchema.parse().
  sources: z
    .array(
      z.object({
        title: z.string().max(300),
        url: z.string().min(1).max(2048),
      }),
    )
    .max(40)
    .nullable()
    .optional(),
});

export type V2ArtifactPlanToolInput = z.infer<
  typeof V2ArtifactPlanToolInputSchema
>;

function omitNullObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullObjectFields);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNullObjectFields(child)]),
  );
}

export function normalizeV2ArtifactPlanToolInput(
  input: V2ArtifactPlanToolInput,
): ArtifactPlan {
  return ArtifactPlanSchema.parse(omitNullObjectFields(input));
}
