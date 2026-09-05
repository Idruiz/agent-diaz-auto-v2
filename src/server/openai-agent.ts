import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
  ArtifactPlanSchema,
  type ArtifactPlan,
  type JobKind,
  type MessageView,
  type ModelMode,
} from "../shared/contracts.js";
import { personaProfile } from "../shared/personas.js";
import { buildArtifact } from "./builders.js";
import { compileArtifactPlan } from "./artifact-compiler.js";
import {
  assertAnalysisNumericProvenance,
  completedCodeInterpreterCalls,
  evidenceNumericValues,
  type AnalysisNumericProvenanceReceipt,
} from "./artifact-provenance.js";
import {
  ArtifactPipelineError,
  artifactPlanQualityViolations,
  asArtifactPipelineError,
  type ArtifactAttemptReceipt,
  type ArtifactFailureClass,
  type ArtifactNormalizationReceipt,
  type ArtifactPlanViolation,
} from "./artifact-quality.js";
import { log } from "./log.js";
import { withArtifactRunLog } from "./artifact-run-log.js";
import {
  evidenceSteeringForPrompt,
  getSkillForKind,
} from "./skills.js";
import { personaInstructions } from "./personas.js";
import { runV2ArtifactRuntime } from "./v2/artifact-agent-runtime.js";
import {
  clearV2InfrastructureRetry,
  hasV2InfrastructureRetryPending,
  recordV2InfrastructureRetry,
} from "./v2/revision-ledger.js";
import {
  clearsJavierRewriteFloor,
  inspectJavierStyle,
  javierStyleScore,
  javierChatInstructions,
  javierRewriteInstructions,
} from "./javier-style.js";
import {
  clearsKarenRewriteFloor,
  inspectKarenStyle,
  karenStyleScore,
  karenChatInstructions,
  karenRewriteInstructions,
} from "./karen-style.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ARTIFACT_LLM_CALLS = 6;
const MAX_ARTIFACT_WALL_TIME_MS = 20 * 60 * 1000;
const MAX_PROVIDER_AUTOMATIC_RETRIES = 2;
const MAX_ASSET_BUILD_ATTEMPTS = 2;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyArtifactFailure(error: unknown): ArtifactPipelineError {
  if (error instanceof ArtifactPipelineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(?:soffice|libreoffice.*(?:unavailable|timed out)|validator.*(?:binary|execution|spawn|crash)|provider.*(?:5\d\d|server_error|rate_limit))/i.test(
      message,
    )
  )
    return new ArtifactPipelineError("INFRA", message, {
      ruleOrPart: "infrastructure",
      cause: error,
    });
  if (
    /(?:photography validation|image provider|licensed bitmap|image retrieval|no usable licensed image)/i.test(
      message,
    )
  )
    return new ArtifactPipelineError("ASSET", message, {
      ruleOrPart: "asset-resolution",
      cause: error,
    });
  return asArtifactPipelineError(error, "BUILD", "artifact-build");
}

export function artifactFailureFingerprint(input: {
  failureClass: ArtifactFailureClass;
  ruleOrPart: string;
  planSha: string;
  packageSha: string | null;
  strategy: string;
}): string {
  // Package bytes can legitimately differ between deterministic attempts because
  // OOXML embeds generated identifiers/timestamps. Loop detection therefore keys on
  // the logical failure, not the regenerated package SHA.
  return sha256Text(JSON.stringify({
    failureClass: input.failureClass,
    ruleOrPart: input.ruleOrPart,
    planSha: input.planSha,
    strategy: input.strategy,
  }));
}

export interface ModelProfile {
  mode: ModelMode;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  label: "Quick" | "Balanced" | "Deep";
}
export function modelProfileFor(mode: ModelMode): ModelProfile {
  if (mode === "quick")
    return {
      mode,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      label: "Quick",
    };
  if (mode === "deep")
    return {
      mode,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      label: "Deep",
    };
  return {
    mode: "balanced",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    label: "Balanced",
  };
}

export function isImageUpload(mime: string, name = ""): boolean {
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}
export function isSpreadsheetUpload(name: string, mime: string): boolean {
  return (
    /\.(csv|tsv|xls|xlsx|ods)$/i.test(name) ||
    /(csv|tab-separated|spreadsheet|excel|officedocument\.spreadsheet)/i.test(
      mime,
    )
  );
}

export function providerFailureMessage(response: any): string {
  const code =
    response?.error?.code ||
    response?.incomplete_details?.reason ||
    response?.status ||
    "unknown";
  const detail =
    response?.error?.message ||
    "The model provider did not return a completed response.";
  return `OpenAI response failed (${code}): ${detail}`;
}

export function isValidWav(audio: Buffer): boolean {
  return (
    audio.length >= 44 &&
    audio.subarray(0, 4).toString("ascii") === "RIFF" &&
    audio.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export function assertProviderRequestCompatible(request: any): void {
  const format = request?.text?.format?.type,
    hasTools = Array.isArray(request?.tools) && request.tools.length > 0;
  if (hasTools && ["json_object", "json_schema"].includes(format))
    throw new Error(
      "Internal provider contract violation: tool-enabled requests cannot use JSON response mode",
    );
}

const artifactSectionSchema = ArtifactPlanSchema.shape.sections.element;
const artifactProviderSectionSchema = artifactSectionSchema.extend({
  table: artifactSectionSchema.shape.table.unwrap().nullable(),
  chart: artifactSectionSchema.shape.chart.unwrap().nullable(),
  diagram: artifactSectionSchema.shape.diagram.unwrap().nullable(),
  activity: artifactSectionSchema.shape.activity.unwrap().nullable(),
  imageQuery: artifactSectionSchema.shape.imageQuery.unwrap().nullable(),
});

function artifactPlanProviderSchema(_kind?: JobKind) {
  return ArtifactPlanSchema.extend({
    sections: z.array(artifactProviderSectionSchema).min(1).max(30),
    pages: ArtifactPlanSchema.shape.pages.unwrap().nullable(),
  });
}

const supportedStructuredOutputStringFormats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

export function sanitizeStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeStructuredOutputSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          key !== "format" ||
          (typeof child === "string" &&
            supportedStructuredOutputStringFormats.has(child)),
      )
      .map(([key, child]) => [key, sanitizeStructuredOutputSchema(child)]),
  );
}

export function artifactPlanTextFormat(kind?: JobKind) {
  const format = zodTextFormat(
    artifactPlanProviderSchema(kind),
    "artifact_plan",
  );
  return {
    ...format,
    schema: sanitizeStructuredOutputSchema(format.schema),
  };
}

export function omitNullObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullObjectFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNullObjectFields(child)]),
  );
}

function isTransientProviderFailure(response: any): boolean {
  return ["server_error", "rate_limit_exceeded"].includes(
    response?.error?.code,
  );
}

function artifactInstructions(kind: JobKind): string {
  const visualPolicy =
    kind === "presentation"
      ? " Create 7-14 content sections. At least half of them must have exactly one primary visual. Give at least three sections distinct, concrete imageQuery values for relevant licensed photographs or explanatory scientific/historical illustrations; use a compact 3-7 word search phrase naming the visible subject and setting. Prefer imagery to generic process boxes. Use a chart only for exact values present in the evidence dossier and include its source in sourceNote. Keep visible slide copy concise: normally 2-4 bullets, with no bibliography section because the builder adds source slides."
      : kind === "website"
        ? " Define 3-6 pages with unique lowercase slugs (use index for the home page), assign every section heading to a page, and give at least four sections distinct concrete imageQuery values for relevant documentary photographs. Do not request logos, AI images, text-heavy graphics, or identifiable private people."
        : kind === "research" || kind === "document"
          ? " Create 5-12 sections. Include at least three meaningful visuals and at least one distinct concrete imageQuery for a relevant licensed photograph or explanatory illustration. Use charts only for exact sourced values and include sourceNote. Do not create a Sources or References section because the builder adds it."
          : " Create 5-12 sections. Use charts and tables only from executed analysis; every numerical visual must state its data source in sourceNote. Decorative imagery is optional.";
  return `Create a complete ${kind} plan. Use web search when current or factual claims benefit from verification. For analysis, use the python tool on every uploaded dataset and base all numerical claims on executed results. Return JSON only with: title, subtitle, requirements[{id:R1..Rn,text,mandatory}], sections[{heading,body,bullets,speakerNotes,requirementIds,layout:auto|title|standard|comparison|process|timeline|gallery|data|conjugation|guided_practice|speed_dating|four_corners|exit_ticket,activity{type:speed_dating|four_corners|guided_practice|independent_practice|discussion|exit_ticket,durationMinutes,directions,prompts,sentenceFrames,cornerLabels},imageQuery,table{title,headers,rows},chart{title,type:bar|line|pie|donut,labels,series[{name,values}],unit,sourceNote},diagram{title,nodes,caption}}], pages[{slug,title,description,sectionHeadings}], sources[{title,url}]. Extract every explicit user instruction and named deliverable feature into the requirements list; assign stable IDs and cover every mandatory ID in section requirementIds. Use null for imageQuery, table, chart, diagram, or pages when that field does not apply. Every material factual claim must be supported. Never invent numbers. Body and bullets must contain finished audience-facing content, not directions, placeholders, production notes, or visual descriptions. For teaching decks, model classroom activities as activity objects rather than mentioning them in ordinary bullets. Speed Dating needs at least four prompts, three operational directions, and two target-language sentence frames. Four Corners needs exactly four labels, a decision prompt, movement/discussion directions, and at least two sentence frames.${visualPolicy}`;
}

const CULTURE_REQUIREMENT_RE =
  /(?:\bcultur(?:e|al|a|as|ales|el|elle|ally)\b|文化|ثقاف|문화|культур)/i;

function sectionVisualCount(section: ArtifactPlan["sections"][number]): number {
  return [
    section.table,
    section.chart,
    section.diagram,
    section.imageQuery,
  ].filter(Boolean).length;
}

export function normalizeArtifactPlan(
  kind: JobKind,
  input: ArtifactPlan,
  _prompt = "",
  compileForRender = true,
): {
  plan: ArtifactPlan;
  normalizations: ArtifactNormalizationReceipt[];
} {
  const plan = structuredClone(input);
  const normalizations: ArtifactNormalizationReceipt[] = [];
  const record = (code: string, detail: string) =>
    normalizations.push({ code, detail });

  const usedRequirementIds = new Set<string>();
  let nextRequirement = 1;
  for (const requirement of plan.requirements) {
    if (!usedRequirementIds.has(requirement.id)) {
      usedRequirementIds.add(requirement.id);
      continue;
    }
    while (usedRequirementIds.has(`R${nextRequirement}`))
      nextRequirement++;
    const previous = requirement.id;
    requirement.id = `R${nextRequirement++}`;
    usedRequirementIds.add(requirement.id);
    record(
      "renumber_duplicate_requirement",
      `Renumbered duplicate requirement ${previous} to ${requirement.id}.`,
    );
  }

  const validRequirementIds = new Set(
    plan.requirements.map((requirement) => requirement.id),
  );
  for (const section of plan.sections) {
    const original = [...section.requirementIds];
    section.requirementIds = section.requirementIds.filter((id) =>
      validRequirementIds.has(id),
    );
    const removed = original.filter(
      (id) => !section.requirementIds.includes(id),
    );
    if (removed.length)
      record(
        "strip_unknown_requirement_ids",
        `Removed unknown requirement IDs ${removed.join(", ")} from '${section.heading}'.`,
      );
  }

  const seenQueries = new Set<string>();
  for (const section of plan.sections) {
    const query = section.imageQuery?.trim();
    if (!query) continue;
    const key = query.toLocaleLowerCase();
    if (seenQueries.has(key)) {
      section.imageQuery = undefined;
      record(
        "dedupe_image_query",
        `Removed duplicate image query '${query}' from '${section.heading}'.`,
      );
    } else {
      section.imageQuery = query;
      seenQueries.add(key);
    }
  }

  for (const section of plan.sections) {
    if (section.chart && !section.chart.sourceNote?.trim()) {
      section.chart.sourceNote = "Values from evidence dossier";
      record(
        "default_chart_source_note",
        `Added a deterministic source note to chart '${section.chart.title}'.`,
      );
    }
    if (
      kind === "presentation" &&
      section.speakerNotes.trim().length < 20
    )
      record(
        "short_speaker_notes_warning",
        `Speaker notes for '${section.heading}' are shorter than 20 characters; retained as a warning.`,
      );
  }

  if (!compileForRender) return { plan, normalizations };
  const compiled = compileArtifactPlan(kind, plan);
  normalizations.push(...compiled.normalizations);
  return { plan: compiled.plan, normalizations };
}

export function collectArtifactPlanViolations(
  kind: JobKind,
  plan: ArtifactPlan,
  minVisuals: number,
  prompt = "",
): ArtifactPlanViolation[] {
  const violations: ArtifactPlanViolation[] = [];
  const push = (
    code: string,
    message: string,
    mandatory: boolean,
  ) => violations.push({ code, message, mandatory });
  const visualCount = plan.sections.filter(
    (section) => sectionVisualCount(section) > 0,
  ).length;
  const imageQueries = plan.sections
    .map((section) => section.imageQuery?.trim())
    .filter((query): query is string => Boolean(query));

  if (visualCount < minVisuals)
    push(
      "visual_coverage_low",
      `Artifact plan validation found ${visualCount} meaningful visual sections; target is ${minVisuals}.`,
      false,
    );

  if (kind === "presentation") {
    if (plan.sections.length < 7)
      push(
        "presentation_sections_low",
        `Presentation has ${plan.sections.length} content sections; seven is a quality target, not a validity requirement.`,
        false,
      );
    const targetVisuals = Math.max(
      minVisuals,
      Math.ceil(plan.sections.length / 2),
    );
    if (visualCount < targetVisuals)
      push(
        "presentation_visual_coverage_low",
        `Presentation has ${visualCount} visual sections; target is ${targetVisuals}.`,
        false,
      );
    if (imageQueries.length < 3)
      push(
        "presentation_photo_briefs_low",
        `Presentation has ${imageQueries.length} licensed-image briefs; target is 3.`,
        false,
      );
  }

  if (
    ["research", "document"].includes(kind) &&
    imageQueries.length < 1
  )
    push(
      "document_photo_brief_missing",
      "Document has no licensed-image brief.",
      false,
    );

  if (kind === "website") {
    if (!plan.pages || plan.pages.length < 3)
      push(
        "website_pages_missing",
        "Website requires at least three planned pages.",
        true,
      );
    const headings = new Set(plan.sections.map((section) => section.heading));
    const assigned = new Set(
      plan.pages?.flatMap((page) => page.sectionHeadings) ?? [],
    );
    for (const heading of headings)
      if (!assigned.has(heading))
        push(
          "website_section_unassigned",
          `Website section '${heading}' is not assigned to a page.`,
          true,
        );
    if (
      plan.sections.filter((section) => section.imageQuery).length < 4
    )
      push(
        "website_photo_briefs_low",
        "Website has fewer than four documentary photo briefs.",
        false,
      );
  }

  if (CULTURE_REQUIREMENT_RE.test(prompt)) {
    const cultureRequirements = plan.requirements.filter(
      (requirement) =>
        requirement.mandatory &&
        CULTURE_REQUIREMENT_RE.test(requirement.text),
    );
    if (!cultureRequirements.length)
      push(
        "culture_requirement_missing",
        "The request contains a cultural requirement but the extracted requirements do not include a mandatory cultural requirement.",
        true,
      );
    else if (
      !cultureRequirements.some((requirement) =>
        plan.sections.some((section) =>
          section.requirementIds.includes(requirement.id),
        ),
      )
    )
      push(
        "culture_requirement_uncovered",
        "The mandatory cultural requirement is not covered by any section requirementIds.",
        true,
      );
  }

  violations.push(...artifactPlanQualityViolations(kind, prompt, plan));
  return violations;
}

export function validateArtifactPlan(
  kind: JobKind,
  plan: ArtifactPlan,
  minVisuals: number,
  prompt = "",
): void {
  const violations = collectArtifactPlanViolations(
    kind,
    plan,
    minVisuals,
    prompt,
  );
  const blocking = violations.filter((violation) => violation.mandatory);
  if (!blocking.length) return;
  throw new ArtifactPipelineError(
    "PLAN_CONTENT",
    `Artifact plan content violations:\n${blocking
      .map(
        (violation) =>
          `- [${violation.code}] ${violation.message}`,
      )
      .join("\n")}`,
    { ruleOrPart: "plan-content" },
  );
}

class ArtifactPlanContentError extends ArtifactPipelineError {
  constructor(
    readonly violations: ArtifactPlanViolation[],
    readonly normalizedPlan: ArtifactPlan | null,
    readonly normalizations: ArtifactNormalizationReceipt[],
    message?: string,
  ) {
    super(
      "PLAN_CONTENT",
      message ??
        `Artifact plan content violations:\n${violations
          .map(
            (violation) =>
              `- [${violation.code}] ${violation.message}`,
          )
          .join("\n")}`,
      { ruleOrPart: "plan-content" },
    );
  }
}

function parseArtifactPlan(
  kind: JobKind,
  output: string,
  minVisuals: number,
  prompt = "",
  allowNonMandatoryWarnings = false,
): {
  plan: ArtifactPlan;
  normalizations: ArtifactNormalizationReceipt[];
} {
  let parsed: ArtifactPlan;
  try {
    const raw = omitNullObjectFields(
      JSON.parse(output.replace(/^\`\`\`json\s*|\`\`\`$/g, "")),
    );
    parsed = ArtifactPlanSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const violations = error.issues.map((issue, index) => ({
        code: `schema_${index + 1}`,
        message: `${issue.path.join(".") || "plan"}: ${issue.message}`,
        mandatory: true,
      }));
      throw new ArtifactPlanContentError(
        violations,
        null,
        [],
        `Artifact plan schema violations:\n${violations
          .map(
            (violation) =>
              `- [${violation.code}] ${violation.message}`,
          )
          .join("\n")}`,
      );
    }
    throw error;
  }

  // Validate the model's semantic plan before compiling it into physical
  // slides. The compiler is allowed to move activity directions/frames onto
  // support slides, so applying semantic activity rules after compilation would
  // incorrectly reject a correct physical plan.
  const normalized = normalizeArtifactPlan(kind, parsed, prompt, false);
  const violations = collectArtifactPlanViolations(
    kind,
    normalized.plan,
    minVisuals,
    prompt,
  );
  const blocking = violations.filter((violation) => violation.mandatory);
  if (blocking.length)
    throw new ArtifactPlanContentError(
      blocking,
      normalized.plan,
      normalized.normalizations,
    );

  // Quality targets are telemetry. They never consume a plan-repair call.
  const warnings = violations
    .filter((violation) => !violation.mandatory)
    .map((violation) => ({
      code: `quality_warning_${violation.code}`,
      detail: violation.message,
    }));
  const compiled = compileArtifactPlan(kind, normalized.plan);
  return {
    plan: compiled.plan,
    normalizations: [
      ...normalized.normalizations,
      ...compiled.normalizations,
      ...warnings,
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown artifact plan error";
}

function planSectionCount(output: string): number | null {
  try {
    const parsed = JSON.parse(output.replace(/^```json\s*|```$/g, ""));
    return Array.isArray(parsed?.sections) ? parsed.sections.length : null;
  } catch {
    return null;
  }
}

export class AgentRunner {
  private client: OpenAI;
  private active = new Set<string>();
  private activeStreams = new Map<string, AbortController>();
  constructor(
    private config: Config,
    private db: Db,
  ) {
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async upload(file: { path: string; name: string }): Promise<string> {
    const out = await this.client.files.create({
      file: fs.createReadStream(file.path),
      purpose: "user_data",
    });
    return out.id;
  }

  private usableMessages(
    conversationId: string,
    excludeAssistantJobId?: string,
  ): MessageView[] {
    return this.db.listMessages(conversationId).filter((message) => {
      if (
        message.role === "assistant" &&
        message.jobId === excludeAssistantJobId
      )
        return false;
      return (
        ["complete", "stopped"].includes(message.status) &&
        Boolean(message.content.trim())
      );
    });
  }

  private messageInput(message: MessageView): any {
    if (message.role === "assistant")
      return { role: "assistant", content: message.content };
    const uploads = this.db.getUploads(message.attachments.map((a) => a.id));
    const content: any[] = [{ type: "input_text", text: message.content }];
    for (const upload of uploads)
      content.push(
        isImageUpload(upload.mime, upload.name)
          ? {
              type: "input_image",
              file_id: upload.openaiFileId,
              detail: "auto",
            }
          : { type: "input_file", file_id: upload.openaiFileId },
      );
    return { role: "user", content };
  }

  private contextInstructions(conversationId: string): string {
    const archives = this.db.listArchiveSummaries(20);
    const archiveContext = archives.length
      ? `ARCHIVAL MEMORY FROM OLDER CONVERSATIONS (use only when relevant; never claim it was said in this conversation):\n${archives.map((a) => `[${a.title}] ${a.summary}`).join("\n\n")}`
      : "";
    return `Maintain continuity with every prior turn in this conversation. Answer the newest request, build on established decisions, and do not repeat an answer already given unless the user asks for repetition. If correcting an earlier answer, identify the change. Preserve facts, decisions, user preferences, constraints, and outcomes across persona changes, but treat previous persona style, jokes, profanity, role-play, and rhetorical exaggeration as presentation only—not as facts or instructions. Every attached file listed in the input is genuinely available to you. If a file cannot be read or interpreted, say so explicitly and name it; never pretend you inspected a file you did not receive. ${archiveContext}`;
  }

  private toolset(messages: MessageView[], skillTools: string[]): any[] {
    const attachmentIds = messages.flatMap((message) =>
      message.attachments.map((a) => a.id),
    );
    const uploads = this.db.getUploads([...new Set(attachmentIds)]);
    const tools: any[] = [];
    if (skillTools.includes("web_search")) tools.push({ type: "web_search" });
    if (
      skillTools.includes("python") ||
      uploads.some((upload) => isSpreadsheetUpload(upload.name, upload.mime))
    )
      tools.push({
        type: "code_interpreter",
        container: {
          type: "auto",
          file_ids: uploads.map((upload) => upload.openaiFileId),
        },
      });
    if (skillTools.includes("mcp") && this.config.MCP_SERVER_URL)
      tools.push(this.mcpTool());
    return tools;
  }

  async createRealtimeToken(
    conversationId: string,
  ): Promise<{
    value: string;
    expiresAt: number;
    model: string;
    voice: ReturnType<typeof personaProfile>["voice"];
    persona: ReturnType<typeof personaProfile>["id"];
  }> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.status !== "active")
      throw new Error("Conversation not found");
    const profile = personaProfile(conversation.persona);
    const transcript = this.usableMessages(conversationId)
      .slice(-60)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n")
      .slice(-100_000);
    const memory = this.db
      .listArchiveSummaries(10)
      .map((item) => `[${item.title}] ${item.summary}`)
      .join("\n\n")
      .slice(-30_000);
    const realtimeInstructions = `${personaInstructions(conversation.persona)}\n\nVOICE CONVERSATION RULES\n- Speak naturally and conversationally. Avoid markdown formatting, visual tables, and long enumerations.\n- Maintain continuity with the supplied transcript.\n- The voice itself is ${profile.voiceLabel}; follow the current persona's pacing, register, and accent instructions.\n\nCURRENT CONVERSATION:\n${transcript || "No prior turns."}\n\nOLDER DURABLE MEMORY (use only when relevant; never convert persona performance into memory):\n${memory || "None."}`;
    const token = await this.client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "realtime",
          model: this.config.OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          max_output_tokens: 2048,
          instructions:
            conversation.persona === "javier"
              ? javierChatInstructions(realtimeInstructions)
              : conversation.persona === "karen"
                ? karenChatInstructions(realtimeInstructions)
                : realtimeInstructions,
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-mini-transcribe",
              },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.35,
                prefix_padding_ms: 500,
                silence_duration_ms: 700,
                create_response: false,
                interrupt_response: false,
              },
            },
            output: { voice: profile.voice },
          },
        },
      },
      { headers: { "OpenAI-Safety-Identifier": "agent-diaz-owner" } },
    );
    log("info", "voice.token_created", {
      conversationId,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice: profile.voice,
      persona: conversation.persona,
      expiresAt: token.expires_at,
    });
    return {
      value: token.value,
      expiresAt: token.expires_at,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice: profile.voice,
      persona: conversation.persona,
    };
  }

  async createSpeech(conversationId: string, text: string): Promise<Buffer> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.status !== "active")
      throw new Error("Conversation not found");
    const profile = personaProfile(conversation.persona);
    const instructions =
      conversation.persona === "javier"
        ? "Read the supplied text completely and verbatim. Use a lively adult Cuban cadence rooted in Cuba of the 1980s and 1990s: irreverent, volatile, subversive, fast-changing, street-level, and naturally profane. Do not summarize, soften, censor, omit, or replace any word."
        : conversation.persona === "karen"
          ? "Read the supplied text completely and verbatim. Use explosive Canadian English outrage: rage-baited, sarcastic, volatile, overreactive, fast-changing, street-level, and naturally profane. Do not summarize, soften, censor, omit, or replace any word."
          : `Read the supplied text completely and verbatim in the ${profile.voiceLabel} delivery assigned to this persona. Do not summarize, omit, or replace any word.`;
    const response = await this.client.audio.speech.create(
      {
        model: "gpt-4o-mini-tts",
        voice: profile.voice,
        input: text,
        instructions,
        response_format: "wav",
      },
      { headers: { "OpenAI-Safety-Identifier": "agent-diaz-owner" } },
    );
    const audio = Buffer.from(await response.arrayBuffer());
    if (!isValidWav(audio))
      throw new Error(
        `OpenAI returned invalid WAV speech audio (${audio.length} bytes)`,
      );
    log("info", "voice.tts_created", {
      conversationId,
      persona: conversation.persona,
      voice: profile.voice,
      textCharacters: text.length,
      audioBytes: audio.length,
    });
    return audio;
  }

  async compactConversation(conversationId: string): Promise<void> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.summary) return;
    const messages = this.db.listMessages(conversationId);
    if (!messages.length) {
      this.db.setConversationSummary(
        conversationId,
        "No conversation content was recorded.",
      );
      return;
    }
    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(0, 120_000);
    try {
      const response = await this.client.responses.create({
        model: this.config.OPENAI_FAST_MODEL,
        store: false,
        instructions:
          "Compact this completed conversation into durable archival memory shared by every Agent Díaz persona. Preserve decisions, user preferences, facts, named entities, constraints, corrections, unfinished work, artifact names, and outcomes. Remove greetings, repetition, incidental wording, persona voice, jokes, profanity, role-play, metaphors, and rhetorical exaggeration. Never promote a persona performance into a user fact or autobiographical fact. Do not invent anything. Return concise plain text with a maximum of 900 words.",
        input: transcript,
      } as any);
      const summary = response.output_text?.trim();
      if (!summary) throw new Error("Empty archive summary");
      this.db.setConversationSummary(conversationId, summary);
    } catch (e) {
      const fallback = messages
        .slice(-12)
        .map(
          (m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 500)}`,
        )
        .join("\n");
      this.db.setConversationSummary(
        conversationId,
        `Automatic semantic compaction was unavailable. Durable extract:\n${fallback}`,
      );
      log("warn", "conversation.compaction_fallback", {
        conversationId,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  start(jobId: string): void {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    void this.run(jobId).finally(() => this.active.delete(jobId));
  }

  resume(): void {
    const v2Enabled = process.env.AGENT_RUNTIME !== "legacy";
    for (const j of this.db
      .listJobs(100)
      .filter((j) => {
        if (j.kind === "chat") return false;
        if (["queued", "running", "building"].includes(j.status)) return true;
        if (!v2Enabled || j.status !== "blocked") return false;
        return hasV2InfrastructureRetryPending(
          path.join(this.config.artifactDir, ".agent-v2", j.id),
        );
      })) {
      if (j.status === "blocked")
        log("warn", "agent_v2.infrastructure_retry_resumed_after_restart", {
          jobId: j.id,
          kind: j.kind,
        });
      this.start(j.id);
    }
  }

  async cancel(jobId: string): Promise<void> {
    this.activeStreams.get(jobId)?.abort();
    const id = this.db.getProviderResponseId(jobId);
    if (id) {
      try {
        await this.client.responses.cancel(id);
      } catch {}
    }
    this.db.updateJob(jobId, {
      status: "cancelled",
      message: "Cancelled by user",
    });
  }

  async streamChat(
    jobId: string,
    assistantMessageId: string,
    handlers: {
      onReady?: (data: { jobId: string; assistantMessageId: string }) => void;
      onDelta?: (delta: string) => void;
      onDone?: (content: string) => void;
      onApproval?: (count: number) => void;
      onError?: (message: string) => void;
    },
    externalSignal?: AbortSignal,
    excludeAssistantJobId?: string,
  ): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error("Chat job not found");
    const controller = new AbortController();
    this.activeStreams.set(jobId, controller);
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    let output = "",
      lastPersist = 0,
      responseId = "";
    let bufferForStyleGate = false;
    const approvalItems: any[] = [];
    try {
      this.db.updateJob(jobId, {
        status: "running",
        progress: 10,
        message: "Thinking",
      });
      handlers.onReady?.({ jobId, assistantMessageId });
      const skill = getSkillForKind("chat"),
        messages = this.usableMessages(
          job.conversationId,
          excludeAssistantJobId,
        );
      const baseInstructions = `${personaInstructions(job.persona)}\n\nACTIVE SKILL: ${skill.name}\n${skill.instructions}\n\n${this.contextInstructions(job.conversationId)}`;
      const instructions =
        job.persona === "javier"
          ? javierChatInstructions(baseInstructions)
          : job.persona === "karen"
            ? karenChatInstructions(baseInstructions)
            : baseInstructions;
      bufferForStyleGate = job.persona === "javier" || job.persona === "karen";
      const stream = await this.client.responses.create(
        {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions,
          input: messages.map((message) => this.messageInput(message)),
          tools: this.toolset(messages, skill.tools),
          stream: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
        } as any,
        { signal: controller.signal },
      );
      for await (const event of stream as any) {
        if (event.type === "response.created") {
          responseId = event.response.id;
          this.db.updateJob(jobId, {
            providerResponseId: responseId,
            progress: 20,
            message: "Responding",
          });
          continue;
        }
        if (event.type === "response.output_text.delta") {
          output += event.delta;
          if (!bufferForStyleGate) handlers.onDelta?.(event.delta);
          const now = Date.now();
          if (!bufferForStyleGate && now - lastPersist > 300) {
            this.db.updateMessage(assistantMessageId, { content: output });
            lastPersist = now;
          }
          continue;
        }
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        )
          throw new Error(providerFailureMessage(event.response));
        if (
          event.type === "response.output_item.done" &&
          event.item?.type === "mcp_approval_request"
        ) {
          approvalItems.push(event.item);
          continue;
        }
        if (event.type === "error")
          throw new Error(
            `OpenAI stream failed (${event.code ?? "stream_error"}): ${event.message ?? "Unknown stream error"}`,
          );
      }
      if (approvalItems.length) {
        for (const item of approvalItems)
          this.db.createApproval({
            id: crypto.randomUUID(),
            jobId,
            tool: `${item.server_label ?? "MCP"}: ${item.name ?? "external action"}`,
            summary:
              "An external tool wants to perform this action. Review the exact arguments before approving once.",
            argumentsJson:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
            providerItemId: item.id,
            providerResponseId: responseId,
          });
        const content = `${personaProfile(job.persona).name} needs your approval before continuing this external action.`;
        this.db.updateMessage(assistantMessageId, {
          content,
          status: "streaming",
          error: null,
        });
        this.db.updateJob(jobId, {
          status: "waiting_approval",
          progress: 40,
          message: "Waiting for your approval",
          outputText: output || null,
          error: null,
        });
        handlers.onApproval?.(approvalItems.length);
        log("info", "chat.waiting_approval", {
          jobId,
          count: approvalItems.length,
        });
        return;
      }
      if (!output.trim())
        throw new Error("OpenAI completed without returning text");
      if (job.persona === "javier") {
        const firstReport = inspectJavierStyle(output);
        if (!firstReport.passes) {
          log("warn", "javier.style_gate_rewrite", {
            jobId,
            words: firstReport.words,
            profanityHits: firstReport.profanityHits,
            profanityTarget: firstReport.profanityTarget,
            profanityVariety: firstReport.profanityVariety,
            cubanTexture: firstReport.cubanTexture,
            failures: firstReport.failures,
          });
          this.db.updateJob(jobId, {
            progress: 80,
            message: "Javier is rejecting the polite draft",
          });
          const rewritten = await this.client.responses.create(
            {
              model: job.model,
              reasoning: { effort: job.reasoningEffort },
              instructions: javierRewriteInstructions(firstReport),
              input: `DRAFT TO REWRITE:\n${output}`,
              store: false,
              safety_identifier: "agent-diaz-owner",
            } as any,
            { signal: controller.signal },
          );
          const candidate = rewritten.output_text?.trim() ?? "";
          if (!candidate)
            throw new Error("Javier style rewrite returned no text");
          const finalReport = inspectJavierStyle(candidate);
          if (!finalReport.passes) {
            const clearsFloor = clearsJavierRewriteFloor(finalReport);
            const firstScore = javierStyleScore(firstReport);
            const rewriteScore = javierStyleScore(finalReport);
            output = rewriteScore >= firstScore ? candidate : output;
            log(clearsFloor ? "warn" : "error", "javier.style_gate_degraded", {
              jobId,
              words: finalReport.words,
              profanityHits: finalReport.profanityHits,
              profanityTarget: finalReport.profanityTarget,
              profanityVariety: finalReport.profanityVariety,
              cubanTexture: finalReport.cubanTexture,
              clearsFloor,
              selected: rewriteScore >= firstScore ? "rewrite" : "original",
              firstScore,
              rewriteScore,
              failures: finalReport.failures,
            });
            // Style is not a safety boundary. A model may miss a quantitative
            // target, but the app must still return the best available answer.
            // Keeping this observable lets us tune Javier without breaking chat.
          } else {
            output = candidate;
            log("info", "javier.style_gate_passed_after_rewrite", {
              jobId,
              words: finalReport.words,
              profanityHits: finalReport.profanityHits,
              profanityVariety: finalReport.profanityVariety,
              cubanTexture: finalReport.cubanTexture,
            });
          }
        } else {
          log("info", "javier.style_gate_passed", {
            jobId,
            words: firstReport.words,
            profanityHits: firstReport.profanityHits,
            profanityVariety: firstReport.profanityVariety,
            cubanTexture: firstReport.cubanTexture,
          });
        }
        handlers.onDelta?.(output);
      }
      if (job.persona === "karen") {
        const firstReport = inspectKarenStyle(output);
        if (!firstReport.passes) {
          log("warn", "karen.style_gate_rewrite", { jobId, failures: firstReport.failures });
          this.db.updateJob(jobId, { progress: 80, message: "Karen is rejecting the polite draft" });
          const rewritten = await this.client.responses.create({
            model: job.model,
            reasoning: { effort: job.reasoningEffort },
            instructions: karenRewriteInstructions(firstReport),
            input: `DRAFT TO REWRITE:\n${output}`,
            store: false,
            safety_identifier: "agent-diaz-owner",
          } as any, { signal: controller.signal });
          const candidate = rewritten.output_text?.trim() ?? "";
          if (!candidate) throw new Error("Karen style rewrite returned no text");
          const finalReport = inspectKarenStyle(candidate);
          if (!finalReport.passes) {
            const clearsFloor = clearsKarenRewriteFloor(finalReport);
            const firstScore = karenStyleScore(firstReport);
            const rewriteScore = karenStyleScore(finalReport);
            output = rewriteScore >= firstScore ? candidate : output;
            log(clearsFloor ? "warn" : "error", "karen.style_gate_degraded", { jobId, clearsFloor, selected: rewriteScore >= firstScore ? "rewrite" : "original", failures: finalReport.failures });
          } else {
            output = candidate;
            log("info", "karen.style_gate_passed_after_rewrite", { jobId, words: finalReport.words, profanityHits: finalReport.profanityHits, profanityVariety: finalReport.profanityVariety, canadianTexture: finalReport.canadianTexture });
          }
        } else {
          log("info", "karen.style_gate_passed", { jobId, words: firstReport.words, profanityHits: firstReport.profanityHits, profanityVariety: firstReport.profanityVariety, canadianTexture: firstReport.canadianTexture });
        }
        handlers.onDelta?.(output);
      }
      this.db.updateMessage(assistantMessageId, {
        content: output,
        status: "complete",
        error: null,
      });
      this.db.updateJob(jobId, {
        status: "completed",
        progress: 100,
        message: "Completed",
        outputText: output,
        error: null,
      });
      handlers.onDone?.(output);
      log("info", "chat.completed", {
        jobId,
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        persona: job.persona,
      });
    } catch (error: any) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      if (aborted) {
        this.db.updateMessage(assistantMessageId, {
          content: bufferForStyleGate ? "" : output,
          status: "stopped",
          error: null,
        });
        this.db.updateJob(jobId, {
          status: "cancelled",
          message: "Stopped",
          outputText: bufferForStyleGate ? null : output || null,
          error: null,
        });
        handlers.onDone?.(bufferForStyleGate ? "" : output);
        log("info", "chat.stopped", { jobId });
      } else {
        const message =
          error instanceof Error ? error.message : "Unknown chat failure";
        this.db.updateMessage(assistantMessageId, {
          content: bufferForStyleGate ? "" : output,
          status: "failed",
          error: message,
        });
        this.db.updateJob(jobId, {
          status: "failed",
          message: "Failed",
          outputText: bufferForStyleGate ? null : output || null,
          error: message,
        });
        handlers.onError?.(message);
        log("error", "chat.failed", { jobId, error: message });
      }
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      this.activeStreams.delete(jobId);
    }
  }

  private mcpTool(): any {
    if (!this.config.MCP_SERVER_URL) throw new Error("MCP is not configured");
    return {
      type: "mcp",
      server_label: this.config.MCP_SERVER_LABEL,
      server_url: this.config.MCP_SERVER_URL,
      server_description:
        "User-authorized workspace tools. External writes require approval.",
      ...(this.config.MCP_AUTHORIZATION
        ? { authorization: this.config.MCP_AUTHORIZATION }
        : {}),
      require_approval: "always",
    };
  }

  async continueApproval(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    const approval = this.db.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending")
      throw new Error("Approval was already decided");
    this.db.decideApproval(approvalId, decision);
    const decisions = this.db.raw
      .prepare(
        "SELECT status,provider_item_id providerItemId,provider_response_id providerResponseId FROM approvals WHERE job_id=? ORDER BY created_at",
      )
      .all(approval.jobId) as Array<{
      status: string;
      providerItemId: string;
      providerResponseId: string;
    }>;
    if (decisions.some((d) => d.status === "pending")) {
      this.db.updateJob(approval.jobId, {
        status: "waiting_approval",
        message: "Waiting for the remaining approval decisions",
      });
      return;
    }
    const response = await this.client.responses.create({
      model: this.db.getJob(approval.jobId)?.model ?? this.config.OPENAI_MODEL,
      previous_response_id: approval.providerResponseId,
      tools: [this.mcpTool()],
      input: decisions.map((d) => ({
        type: "mcp_approval_response",
        approval_request_id: d.providerItemId,
        approve: d.status === "approved",
      })),
      background: true,
      store: true,
      reasoning: {
        effort: this.db.getJob(approval.jobId)?.reasoningEffort ?? "medium",
      },
    } as any);
    this.db.updateJob(approval.jobId, {
      providerResponseId: response.id,
      status: "running",
      progress: 45,
      message:
        decision === "approved"
          ? "Approved action is continuing"
          : "Rejection recorded; Díaz is continuing safely",
    });
    this.start(approval.jobId);
  }

  private captureApproval(jobId: string, response: any): boolean {
    const requests = (response.output ?? []).filter(
      (item: any) => item?.type === "mcp_approval_request",
    );
    if (!requests.length) return false;
    if (this.db.listApprovals(jobId).some((a) => a.status === "pending"))
      return true;
    for (const item of requests) {
      this.db.createApproval({
        id: crypto.randomUUID(),
        jobId,
        tool: `${item.server_label ?? "MCP"}: ${item.name ?? "external action"}`,
        summary:
          "An external tool wants to perform this action. Review the exact arguments before approving once.",
        argumentsJson:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
        providerItemId: item.id,
        providerResponseId: response.id,
      });
    }
    this.db.updateJob(jobId, {
      status: "waiting_approval",
      progress: 40,
      message: "Waiting for your approval",
    });
    return true;
  }

  private async awaitBackgroundResponse(
    jobId: string,
    initialResponse: any,
    createFreshResponse: () => Promise<any>,
    progressCap: number,
    progressLabel: string,
    persistentRetry = false,
  ): Promise<any | null> {
    let response = initialResponse,
      responseId = response.id as string,
      automaticRetries = 0;
    for (;;) {
      while (["queued", "in_progress"].includes(response.status)) {
        await sleep(1800);
        if (this.db.getJob(jobId)?.status === "cancelled") return null;
        response = await this.client.responses.retrieve(responseId);
        this.db.updateJob(jobId, {
          progress: Math.min(
            progressCap,
            (this.db.getJob(jobId)?.progress ?? 25) + 3,
          ),
          message: `${progressLabel}: ${response.status}`,
        });
      }
      if (this.captureApproval(jobId, response)) return null;
      if (response.status === "completed") return response;
      const providerError = providerFailureMessage(response);
      automaticRetries++;
      log("error", "provider.response_failed", {
        jobId,
        responseId: response.id,
        status: response.status,
        code: response?.error?.code,
        error: response?.error?.message,
        phase: progressLabel,
        automaticRetries,
        persistentRetry,
      });
      const mayRetry =
        automaticRetries <= MAX_PROVIDER_AUTOMATIC_RETRIES &&
        isTransientProviderFailure(response) &&
        (persistentRetry || !this.config.MCP_SERVER_URL);
      if (!mayRetry) throw new Error(providerError);
      const delayMs = persistentRetry
        ? Math.min(30_000, 1200 * 2 ** Math.min(automaticRetries - 1, 5))
        : response?.error?.code === "rate_limit_exceeded"
          ? 5000
          : 1200;
      this.db.updateJob(jobId, {
        status: "running",
        error: null,
        message: persistentRetry
          ? `${progressLabel} hit an error; retrying automatically (attempt ${automaticRetries + 1})`
          : `${progressLabel} failed transiently; retrying once`,
      });
      await sleep(delayMs);
      if (this.db.getJob(jobId)?.status === "cancelled") return null;
      response = await createFreshResponse();
      responseId = response.id;
      this.db.updateJob(jobId, {
        providerResponseId: responseId,
        error: null,
        message: `${progressLabel} restarted`,
      });
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) return;
    const isArtifact = [
      "research",
      "analysis",
      "presentation",
      "document",
      "website",
    ].includes(job.kind);
    if (!isArtifact) return this.runInternal(jobId);
    return withArtifactRunLog(this.config, jobId, async () => {
      log("info", "artifact.run_log_started", {
        jobId,
        kind: job.kind,
        status: job.status,
      });
      try {
        await this.runInternal(jobId);
      } finally {
        const finalJob = this.db.getJob(jobId);
        log("info", "artifact.run_log_finished", {
          jobId,
          kind: job.kind,
          status: finalJob?.status ?? "missing",
          progress: finalJob?.progress ?? null,
          error: finalJob?.error ?? null,
        });
      }
    });
  }

  private async runInternal(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job || ["completed", "cancelled"].includes(job.status)) return;
    try {
      const skill = getSkillForKind(job.kind);
      const artifactKinds = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ];
      const isArtifact = artifactKinds.includes(job.kind),
        messages = this.usableMessages(job.conversationId),
        activeMessages = isArtifact
          ? messages.filter((message) => message.jobId === jobId)
          : messages,
        priorArtifactContext = isArtifact
          ? messages
              .filter((message) => message.jobId !== jobId)
              .slice(-20)
              .map(
                (message) =>
                  `${message.role.toUpperCase()} (reference only): ${message.content}`,
              )
              .join("\n\n")
              .slice(-40_000)
          : "",
        existingResponseId = this.db.getProviderResponseId(jobId),
        resumingStructure = Boolean(
          isArtifact &&
            existingResponseId &&
            ([
              "Structuring artifact",
              "Building and validating artifact",
              "Artifact validation",
              "Artifact regeneration",
              "Rebuilding artifact",
            ].some((prefix) => job.message.startsWith(prefix)) ||
              job.status === "building" ||
              job.status === "blocked"),
        );

      if (isArtifact && process.env.AGENT_RUNTIME !== "legacy" && (this.config.NODE_ENV !== "test" || process.env.AGENT_RUNTIME === "v2")) {
        const existingArtifacts = this.db.listArtifacts(jobId);
        if (existingArtifacts.length) {
          const userOutput = `Completed ${job.kind} artifact: ${existingArtifacts.map((a) => a.name).join(", ")}. The finished file is ready to download.`;
          this.db.updateJob(jobId, {
            status: "completed",
            progress: 100,
            message: "Completed",
            outputText: userOutput,
            error: null,
          });
          const existingMessage = this.db.raw
            .prepare("SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1")
            .get(jobId) as { id: string } | undefined;
          if (existingMessage)
            this.db.updateMessage(existingMessage.id, {
              content: userOutput,
              status: "complete",
              error: null,
            });
          else
            this.db.addMessage({
              id: crypto.randomUUID(),
              conversationId: job.conversationId,
              role: "assistant",
              content: userOutput,
              jobId,
            });
          log("info", "agent_v2.resume_reused_artifact", {
            jobId,
            kind: job.kind,
            artifactCount: existingArtifacts.length,
          });
          return;
        }

        const controller = new AbortController();
        this.activeStreams.set(jobId, controller);
        try {
          this.db.updateJob(jobId, {
            status: "running",
            progress: 12,
            message: "Agent V2 workspace starting",
            error: null,
          });
          log("info", "agent_v2.integration_started", {
            jobId,
            kind: job.kind,
            model: job.model,
            runtimeOverride: process.env.AGENT_RUNTIME ?? "v2-default",
          });
          const attachments = this.db.getUploads(this.db.getJobFileIds(jobId));
          this.db.updateJob(jobId, {
            status: "running",
            progress: 20,
            message: "Agent V2 researching, planning, and revising in workspace",
            error: null,
          });
          const result = await runV2ArtifactRuntime({
            config: this.config,
            jobId,
            kind: job.kind,
            prompt: job.prompt,
            model: job.model,
            reasoningEffort: job.reasoningEffort,
            attachments,
            priorContext: priorArtifactContext,
            signal: controller.signal,
            onProgress: (event) => {
              const currentProgress = this.db.getJob(jobId)?.progress ?? 20;
              this.db.updateJob(jobId, {
                status: "building",
                progress: Math.max(currentProgress, Math.min(99, event.progress)),
                error: null,
                message: event.message,
              });
              log("info", "agent_v2.build_progress", {
                jobId,
                kind: job.kind,
                ...event,
              });
            },
          });

          const file = result.file;
          const id = crypto.randomUUID();
          const extension = path.extname(file.name);
          const durableName = `${path.basename(file.name, extension)}-${id.slice(0, 12)}${extension}`;
          const durablePath = path.join(this.config.artifactDir, durableName);
          fs.mkdirSync(this.config.artifactDir, { recursive: true });
          fs.renameSync(file.path, durablePath);
          file.name = durableName;
          file.path = durablePath;
          fs.rmSync(path.join(this.config.artifactDir, ".agent-v2", jobId), {
            recursive: true,
            force: true,
          });
          this.db.addArtifact({
            id,
            jobId,
            name: file.name,
            mime: file.mime,
            size: file.size,
            path: file.path,
            receipt: file.validationReceipt,
          });

          const userOutput = `Completed ${job.kind} artifact: ${file.name}. Agent Díaz V2 iterated through ${result.attempts} build attempt${result.attempts === 1 ? "" : "s"}; the accepted file passed production validation and is ready to download.`;
          this.db.updateJob(jobId, {
            status: "completed",
            progress: 100,
            message: "Completed",
            outputText: userOutput,
            error: null,
          });
          const existingMessage = this.db.raw
            .prepare("SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1")
            .get(jobId) as { id: string } | undefined;
          if (existingMessage)
            this.db.updateMessage(existingMessage.id, {
              content: userOutput,
              status: "complete",
              error: null,
            });
          else
            this.db.addMessage({
              id: crypto.randomUUID(),
              conversationId: job.conversationId,
              role: "assistant",
              content: userOutput,
              jobId,
            });
          log("info", "agent_v2.integration_completed", {
            jobId,
            kind: job.kind,
            attempts: result.attempts,
            name: file.name,
            size: file.size,
          });
          return;
        } finally {
          this.activeStreams.delete(jobId);
        }
      }

      let artifactRunState = isArtifact
        ? this.db.getArtifactRunState(jobId)
        : null;
      if (isArtifact && !artifactRunState) {
        artifactRunState = {
          startedAt: new Date().toISOString(),
          llmCalls: 0,
          maxLlmCalls: MAX_ARTIFACT_LLM_CALLS,
          attempts: [],
        };
        this.db.setArtifactRunState(jobId, artifactRunState);
      }
      const persistArtifactRunState = () => {
        if (isArtifact && artifactRunState)
          this.db.setArtifactRunState(jobId, artifactRunState);
      };
      const trackedCreate = async (
        request: any,
        phase: "evidence" | "structure" | "structure-retry" | "plan-repair",
      ) => {
        if (!isArtifact) return this.client.responses.create(request);
        if (!artifactRunState)
          throw new ArtifactPipelineError(
            "INFRA",
            "Artifact run state is unavailable",
            { ruleOrPart: "run-state" },
          );
        const elapsed =
          Date.now() - Date.parse(artifactRunState.startedAt);
        if (elapsed > MAX_ARTIFACT_WALL_TIME_MS)
          throw new ArtifactPipelineError(
            "INFRA",
            `Artifact wall-time budget exceeded after ${elapsed} ms`,
            { ruleOrPart: "wall-time-budget" },
          );
        if (artifactRunState.llmCalls >= artifactRunState.maxLlmCalls)
          throw new ArtifactPipelineError(
            phase === "plan-repair" ? "PLAN_CONTENT" : "INFRA",
            `Artifact LLM-call budget exhausted at ${artifactRunState.llmCalls}/${artifactRunState.maxLlmCalls}`,
            { ruleOrPart: "llm-call-budget" },
          );
        artifactRunState.llmCalls++;
        persistArtifactRunState();
        try {
          return await this.client.responses.create(request);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            /(?:5\d\d|server[_ -]?error|rate[_ -]?limit|ECONN|ETIMEDOUT|network)/i.test(
              message,
            )
          )
            throw new ArtifactPipelineError(
              "INFRA",
              `Provider infrastructure failure during ${phase}: ${message}`,
              { ruleOrPart: `provider-${phase}`, cause: error },
            );
          throw error;
        }
      };
      const recordArtifactFailure = (
        error: unknown,
        planLike: unknown,
        strategy: string,
        forcedClass?: ArtifactFailureClass,
      ) => {
        const classified = forcedClass
          ? error instanceof ArtifactPipelineError
            ? error
            : new ArtifactPipelineError(
                forcedClass,
                error instanceof Error ? error.message : String(error),
                { ruleOrPart: forcedClass === "PLAN_CONTENT" ? "plan-validation" : "unknown" },
              )
          : classifyArtifactFailure(error);
        const planSha = sha256Text(
          typeof planLike === "string"
            ? planLike
            : JSON.stringify(planLike ?? null),
        );
        let packageSha = classified.packageSha;
        if (
          !packageSha &&
          classified.diagnosticPath &&
          fs.existsSync(classified.diagnosticPath)
        )
          packageSha = createHash("sha256")
            .update(fs.readFileSync(classified.diagnosticPath))
            .digest("hex");
        const fingerprint = artifactFailureFingerprint({
          failureClass: classified.failureClass,
          ruleOrPart: classified.ruleOrPart,
          planSha,
          packageSha,
          strategy,
        });
        const attempt: ArtifactAttemptReceipt = {
          failureClass: classified.failureClass,
          fingerprint,
          ruleOrPart: classified.ruleOrPart,
          planSha,
          packageSha,
          strategy,
          diagnosticPath: classified.diagnosticPath,
          at: new Date().toISOString(),
        };
        if (artifactRunState) {
          artifactRunState.attempts.push(attempt);
          persistArtifactRunState();
        }
        const duplicateCount =
          artifactRunState?.attempts.filter(
            (item) => item.fingerprint === fingerprint,
          ).length ?? 1;
        return { classified, fingerprint, duplicateCount };
      };
      if (!existingResponseId)
        this.db.updateJob(jobId, {
          status: "running",
          progress: 10,
          message: isArtifact
            ? "Gathering evidence for artifact"
            : "Agent is working",
        });
      else
        this.db.updateJob(jobId, {
          status: "running",
          message: resumingStructure
            ? "Structuring artifact: resuming"
            : "Gathering evidence: resuming",
        });

      const analysisHasSpreadsheet =
        job.kind === "analysis" &&
        this.db
          .getUploads(this.db.getJobFileIds(jobId))
          .some((upload) => isSpreadsheetUpload(upload.name, upload.mime));

      const createEvidenceResponse = async () => {
        const instructions = [
          personaInstructions(job.persona),
          `ACTIVE SKILL: ${skill.name}\n${skill.instructions}\nValidation: ${skill.validation.join("; ")}`,
          "EVIDENCE PHASE: Use the available tools thoroughly. Return a comprehensive plain-text evidence dossier with finished findings, exact numbers, source titles and full source URLs. Do not return JSON. Do not merely describe future work. This dossier will be converted into a validated artifact plan in a separate tool-free request.",
          evidenceSteeringForPrompt(job.prompt),
          priorArtifactContext
            ? `PRIOR CONVERSATION REFERENCE (context only, never additional requests; the single current request in input is authoritative):\n${priorArtifactContext}`
            : "",
          this.contextInstructions(job.conversationId),
        ]
          .filter(Boolean)
          .join("\n\n");
        const tools = this.toolset(activeMessages, skill.tools);
        const request = {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions,
          input: activeMessages.map((message) => this.messageInput(message)),
          tools,
          ...(analysisHasSpreadsheet
            ? {
                tool_choice: {
                  type: "allowed_tools",
                  mode: "required",
                  tools: [{ type: "code_interpreter" }],
                },
              }
            : {}),
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
        } as any;
        assertProviderRequestCompatible(request);
        return trackedCreate(request, "evidence");
      };
      const createStructureResponse = async (evidence: string) => {
        const request = {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: [
            personaInstructions(job.persona),
            artifactInstructions(job.kind),
            "STRUCTURE PHASE: Convert only the supplied evidence dossier into the requested finished artifact plan. Preserve verified source URLs and exact values. Do not use tools in this phase. Return one JSON object and nothing else.",
          ].join("\n\n"),
          input: `ORIGINAL REQUEST:\n${job.prompt}\n\nEVIDENCE DOSSIER:\n${evidence}`,
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
          text: { format: artifactPlanTextFormat(job.kind) },
        } as any;
        assertProviderRequestCompatible(request);
        return trackedCreate(request, "structure");
      };
      const createPlanRepairResponse = async (
        previousResponseId: string,
        validationError: string,
      ) => {
        const request = {
          model: job.model,
          previous_response_id: previousResponseId,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: [
            personaInstructions(job.persona),
            artifactInstructions(job.kind),
            "ARTIFACT PLAN REPAIR PHASE: The previous complete plan failed deterministic validation. Correct the entire plan using the original request and evidence already present in the response chain. Preserve verified facts, exact values, source URLs, and all valid content. Do not research again, do not use tools, and do not explain the correction. Return one corrected complete JSON artifact plan and nothing else.",
          ].join("\n\n"),
          input: `DETERMINISTIC VALIDATION ERROR:\n${validationError}\n\nReturn a corrected complete plan that satisfies every stated structural and visual requirement.`,
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
          text: { format: artifactPlanTextFormat(job.kind) },
        } as any;
        assertProviderRequestCompatible(request);
        return trackedCreate(request, "plan-repair");
      };

      let response: any,
        output = "";
      if (isArtifact) {
        let structureResponse: any;
        const canResumeStructure =
          resumingStructure &&
          (job.kind !== "analysis" ||
            Array.isArray(artifactRunState?.evidenceNumericValues));
        if (canResumeStructure) {
          structureResponse = await this.client.responses.retrieve(
            existingResponseId!,
          );
        } else {
          let evidenceResponse: any;
          if (existingResponseId && !resumingStructure)
            evidenceResponse = await this.client.responses.retrieve(
              existingResponseId,
            );
          else {
            evidenceResponse = await createEvidenceResponse();
            this.db.updateJob(jobId, {
              providerResponseId: evidenceResponse.id,
              progress: 20,
              message: "Gathering evidence: started",
            });
          }
          evidenceResponse = await this.awaitBackgroundResponse(
            jobId,
            evidenceResponse,
            createEvidenceResponse,
            58,
            "Gathering evidence",
            true,
          );
          if (!evidenceResponse) return;
          const evidence = evidenceResponse.output_text?.trim() || "";
          if (!evidence)
            throw new Error("Evidence phase returned no usable content");
          if (job.kind === "analysis") {
            const pythonCalls = completedCodeInterpreterCalls(evidenceResponse);
            if (analysisHasSpreadsheet && pythonCalls < 1)
              throw new ArtifactPipelineError(
                "INFRA",
                "Analysis evidence contract failed: the uploaded spreadsheet was not executed with code_interpreter",
                { ruleOrPart: "analysis-python-evidence" },
              );
            if (artifactRunState) {
              artifactRunState.evidenceNumericValues = evidenceNumericValues(
                evidence,
                evidenceResponse,
              );
              artifactRunState.evidencePythonExecuted = pythonCalls > 0;
              persistArtifactRunState();
            }
            log("info", "artifact.analysis_evidence_provenance", {
              jobId,
              spreadsheetRequired: analysisHasSpreadsheet,
              pythonCalls,
              numericValues:
                artifactRunState?.evidenceNumericValues?.length ?? 0,
            });
          }
          structureResponse = await createStructureResponse(evidence);
          this.db.updateJob(jobId, {
            providerResponseId: structureResponse.id,
            progress: 62,
            message: "Structuring artifact: started",
          });
        }
        structureResponse = await this.awaitBackgroundResponse(
          jobId,
          structureResponse,
          () =>
            trackedCreate(
              {
                model: job.model,
                previous_response_id: structureResponse.id,
                reasoning: {
                  effort: job.reasoningEffort,
                  context: "all_turns",
                },
                instructions:
                  "Retry the artifact structure phase from the original request and evidence in the previous response. Return one complete JSON artifact plan only. Do not use tools.",
                input:
                  "Reconstruct the complete artifact plan; the previous structure attempt failed transiently.",
                background: true,
                store: true,
                safety_identifier: "agent-diaz-owner",
                text: { format: artifactPlanTextFormat(job.kind) },
              } as any,
              "structure-retry",
            ),
          79,
          "Structuring artifact",
          true,
        );
        if (!structureResponse) return;
        response = structureResponse;
        output = response.output_text?.trim() || "";
        if (!output)
          throw new Error("Structure phase returned no artifact plan");
        this.db.updateJob(jobId, {
          status: "building",
          progress: 82,
          message: "Building and validating artifact",
        });
        if (!this.db.listArtifacts(jobId).length) {
          const minVisuals = getSkillForKind(job.kind).minVisuals;
          let plan: ArtifactPlan;
          let planNormalizations: ArtifactNormalizationReceipt[] = [];
          let analysisProvenance: AnalysisNumericProvenanceReceipt | null = null;
          let repairAttempt = 0;
          let buildAttempt = 0;

          for (;;) {
            if (this.db.getJob(jobId)?.status === "cancelled") return;

            for (;;) {
              try {
                const parsedPlan = parseArtifactPlan(
                  job.kind,
                  output,
                  minVisuals,
                  job.prompt,
                  repairAttempt >= 2,
                );
                plan = parsedPlan.plan;
                planNormalizations = parsedPlan.normalizations;
                analysisProvenance =
                  job.kind === "analysis"
                    ? assertAnalysisNumericProvenance({
                        plan,
                        prompt: job.prompt,
                        evidenceNumericValues:
                          artifactRunState?.evidenceNumericValues ?? [],
                        pythonExecuted:
                          artifactRunState?.evidencePythonExecuted ?? null,
                      })
                    : null;
                if (repairAttempt > 0)
                  log("info", "artifact.plan_repaired", {
                    jobId,
                    kind: job.kind,
                    repairCalls: repairAttempt,
                    sectionCount: plan.sections.length,
                    normalizations: planNormalizations.length,
                  });
                break;
              } catch (planError) {
                const validationError = errorMessage(planError);
                const planFailure =
                  planError instanceof ArtifactPipelineError
                    ? planError
                    : new ArtifactPipelineError(
                        "PLAN_CONTENT",
                        validationError,
                        { ruleOrPart: "plan-validation" },
                      );
                const failureRecord = recordArtifactFailure(
                  planFailure,
                  output,
                  "plan-repair",
                  "PLAN_CONTENT",
                );
                log("warn", "artifact.plan_validation_failed", {
                  jobId,
                  kind: job.kind,
                  repairCalls: repairAttempt,
                  sectionCount: planSectionCount(output),
                  fingerprint: failureRecord.fingerprint,
                  duplicateCount: failureRecord.duplicateCount,
                  error: validationError,
                });
                if (failureRecord.duplicateCount >= 2)
                  throw new ArtifactPipelineError(
                    "PLAN_CONTENT",
                    `Repeated identical plan-validation fingerprint ${failureRecord.fingerprint}; stopping identical repair loop`,
                    { ruleOrPart: "plan-validation" },
                  );
                if (repairAttempt >= 2)
                  throw planFailure;

                repairAttempt++;
                this.db.updateJob(jobId, {
                  status: "running",
                  progress: Math.min(91, 83 + repairAttempt),
                  error: null,
                  message: `Structuring artifact: batched content repair ${repairAttempt} of 2`,
                });
                const parentResponseId = response.id as string;
                if (repairAttempt > 1)
                  await sleep(
                    Math.min(
                      12_000,
                      800 * 2 ** Math.min(repairAttempt - 2, 4),
                    ),
                  );
                if (this.db.getJob(jobId)?.status === "cancelled") return;
                let repairResponse = await createPlanRepairResponse(
                  parentResponseId,
                  validationError,
                );
                this.db.updateJob(jobId, {
                  providerResponseId: repairResponse.id,
                  error: null,
                  message: `Structuring artifact: repair call ${repairAttempt} of 2 started`,
                });
                repairResponse = await this.awaitBackgroundResponse(
                  jobId,
                  repairResponse,
                  () =>
                    createPlanRepairResponse(
                      parentResponseId,
                      validationError,
                    ),
                  91,
                  "Structuring artifact: repair",
                  true,
                );
                if (!repairResponse) return;
                response = repairResponse;
                output = repairResponse.output_text?.trim() || "";
                if (!output) {
                  log("warn", "artifact.plan_repair_empty", {
                    jobId,
                    kind: job.kind,
                    repairCalls: repairAttempt,
                  });
                  output = "{}";
                }
              }
            }

            this.db.updateJob(jobId, {
              status: "building",
              progress: 82,
              error: null,
              message:
                buildAttempt === 0
                  ? "Preparing deterministic artifact build"
                  : `Rebuilding artifact after asset failure (attempt ${buildAttempt + 1})`,
            });

            const buildWorkspace = path.join(
              this.config.artifactDir,
              ".work",
              jobId,
              `attempt-${buildAttempt + 1}`,
            );
            fs.mkdirSync(buildWorkspace, { recursive: true });
            try {
              const file = await buildArtifact(
                { ...this.config, artifactDir: buildWorkspace },
                job.kind,
                plan,
                job.prompt,
                jobId,
                (event) => {
                  const currentProgress = this.db.getJob(jobId)?.progress ?? 82;
                  this.db.updateJob(jobId, {
                    status: "building",
                    progress: Math.max(currentProgress, Math.min(99, event.progress)),
                    error: null,
                    message: event.message,
                  });
                  log("info", "artifact.build_progress", { jobId, kind: job.kind, ...event });
                },
              );
              const latestRunState =
                this.db.getArtifactRunState(jobId) ?? artifactRunState;
              if (latestRunState) {
                const imageJudgeCallsPerAttempt = Number(
                  (file.validationReceipt as any).images?.judgeCalls ?? 0,
                );
                const imageJudgeCalls =
                  imageJudgeCallsPerAttempt * (buildAttempt + 1);
                const accountedLlmCalls =
                  latestRunState.llmCalls + imageJudgeCalls;
                if (accountedLlmCalls > latestRunState.maxLlmCalls)
                  throw new ArtifactPipelineError(
                    "INFRA",
                    `Artifact LLM-call budget exceeded after qualitative image judgment: ${accountedLlmCalls}/${latestRunState.maxLlmCalls}`,
                    { ruleOrPart: "llm-call-budget" },
                  );
                latestRunState.llmCalls = accountedLlmCalls;
                artifactRunState = latestRunState;
                persistArtifactRunState();
                file.validationReceipt.llmCalls = accountedLlmCalls;
                file.validationReceipt.maxLlmCalls =
                  latestRunState.maxLlmCalls;
                file.validationReceipt.wallTimeMs = Math.max(
                  0,
                  Date.now() - Date.parse(latestRunState.startedAt),
                );
                file.validationReceipt.attempts = [
                  ...latestRunState.attempts,
                ];
              }
              file.validationReceipt.normalizations = [
                ...planNormalizations,
              ];
              if (job.kind === "analysis" && analysisProvenance)
                file.validationReceipt.analysisProvenance = analysisProvenance;
              const id = crypto.randomUUID();
              const extension = path.extname(file.name);
              const durableName = `${path.basename(file.name, extension)}-${id.slice(0, 12)}${extension}`;
              const durablePath = path.join(this.config.artifactDir, durableName);
              fs.mkdirSync(this.config.artifactDir, { recursive: true });
              fs.renameSync(file.path, durablePath);
              file.name = durableName;
              file.path = durablePath;
              fs.rmSync(path.join(this.config.artifactDir, ".work", jobId), {
                recursive: true,
                force: true,
              });
              this.db.addArtifact({
                id,
                jobId,
                name: file.name,
                mime: file.mime,
                size: file.size,
                path: file.path,
                receipt: file.validationReceipt,
              });
              log("info", "artifact.build_validated", {
                jobId,
                kind: job.kind,
                buildAttempt: buildAttempt + 1,
                repairAttempt,
                name: file.name,
                size: file.size,
                buildSha: file.validationReceipt.buildSha,
                artifactSha256: file.validationReceipt.artifactSha256,
                knownBenignFindings:
                  file.validationReceipt.knownBenignFindings.length,
              });
              break;
            } catch (buildError) {
              fs.rmSync(path.join(this.config.artifactDir, ".work", jobId), {
                recursive: true,
                force: true,
              });
              buildAttempt++;
              const failureRecord = recordArtifactFailure(
                buildError,
                plan,
                "same-plan-build",
              );
              const validationError = failureRecord.classified.message;
              log("warn", "artifact.build_failed", {
                jobId,
                kind: job.kind,
                buildAttempt,
                repairAttempt,
                failureClass: failureRecord.classified.failureClass,
                fingerprint: failureRecord.fingerprint,
                duplicateCount: failureRecord.duplicateCount,
                diagnosticPath:
                  failureRecord.classified.diagnosticPath,
                error: validationError,
              });

              if (failureRecord.classified.failureClass === "INFRA")
                throw failureRecord.classified;

              const allowedBuildAttempts =
                failureRecord.classified.failureClass === "ASSET"
                  ? MAX_ASSET_BUILD_ATTEMPTS
                  : 1;
              if (buildAttempt >= allowedBuildAttempts)
                throw failureRecord.classified;

              if (failureRecord.duplicateCount >= 2)
                throw new ArtifactPipelineError(
                  failureRecord.classified.failureClass,
                  `Repeated identical ${failureRecord.classified.failureClass} fingerprint ${failureRecord.fingerprint}; identical retry loop stopped`,
                  {
                    ruleOrPart: failureRecord.classified.ruleOrPart,
                    diagnosticPath:
                      failureRecord.classified.diagnosticPath,
                    packageSha:
                      failureRecord.classified.packageSha,
                  },
                );

              this.db.updateJob(jobId, {
                status: "building",
                progress: Math.min(
                  96,
                  91 + Math.min(buildAttempt, 5),
                ),
                error: null,
                message:
                  failureRecord.classified.failureClass === "ASSET"
                    ? `Asset resolution failed; retrying the same plan without an LLM rewrite (attempt ${buildAttempt + 1})`
                    : `Build validation failed; retrying the same plan without an LLM rewrite (attempt ${buildAttempt + 1})`,
              });
              await sleep(
                Math.min(
                  5000,
                  750 * 2 ** Math.min(buildAttempt - 1, 3),
                ),
              );
              if (this.db.getJob(jobId)?.status === "cancelled") return;
              continue;
            }          }
        } else
          log("info", "artifact.build_resume_reused", {
            jobId,
            artifactCount: this.db.listArtifacts(jobId).length,
          });
      } else {
        response = existingResponseId
          ? await this.client.responses.retrieve(existingResponseId)
          : await createEvidenceResponse();
        if (!existingResponseId)
          this.db.updateJob(jobId, {
            providerResponseId: response.id,
            progress: 25,
            message: "Background response started",
          });
        response = await this.awaitBackgroundResponse(
          jobId,
          response,
          createEvidenceResponse,
          75,
          "Agent",
        );
        if (!response) return;
        output = response.output_text?.trim() || "";
      }
      const userOutput = isArtifact
        ? `Completed ${job.kind} artifact: ${this.db
            .listArtifacts(jobId)
            .map((a) => a.name)
            .join(", ")}. The finished file is ready to download.`
        : output;
      this.db.updateJob(jobId, {
        status: "completed",
        progress: 100,
        message: "Completed",
        outputText: userOutput,
        error: null,
      });
      log("info", "job.completed", { jobId, kind: job.kind });
      const existing = this.db.raw
        .prepare(
          "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get(jobId) as { id: string } | undefined;
      if (existing)
        this.db.updateMessage(existing.id, {
          content: userOutput,
          status: "complete",
          error: null,
        });
      else
        this.db.addMessage({
          id: crypto.randomUUID(),
          conversationId: job.conversationId,
          role: "assistant",
          content: userOutput,
          jobId,
        });
    } catch (e: any) {
      const message = e instanceof Error ? e.message : "Unknown job failure";
      if (String(this.db.getJob(jobId)?.status ?? "") === "cancelled") {
        log("info", "job.cancelled_preserved", { jobId });
        return;
      }
      const current = this.db.getJob(jobId);
      const artifactKinds = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ];
      if (
        current &&
        current.status !== "cancelled" &&
        artifactKinds.includes(current.kind) &&
        e instanceof ArtifactPipelineError
      ) {
        const blocked = e.failureClass === "INFRA";
        this.db.updateJob(jobId, {
          status: blocked ? "blocked" : "failed",
          progress: Math.max(10, Math.min(96, current.progress)),
          message: blocked
            ? "blocked: infrastructure"
            : `Artifact stopped: ${e.failureClass.toLowerCase()}`,
          error: message,
        });
        const existing = this.db.raw
          .prepare(
            "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
          )
          .get(jobId) as { id: string } | undefined;
        if (existing)
          this.db.updateMessage(existing.id, {
            status: "failed",
            error: message,
          });
        log(blocked ? "warn" : "error", "artifact.pipeline_stopped", {
          jobId,
          kind: current.kind,
          failureClass: e.failureClass,
          ruleOrPart: e.ruleOrPart,
          diagnosticPath: e.diagnosticPath,
          error: message,
        });
        if (blocked && this.config.NODE_ENV !== "test") {
          const v2Enabled = process.env.AGENT_RUNTIME !== "legacy";
          const v2WorkRoot = path.join(
            this.config.artifactDir,
            ".agent-v2",
            jobId,
          );
          if (v2Enabled) {
            if (e.ruleOrPart === "agent-v2-configuration") {
              clearV2InfrastructureRetry(v2WorkRoot);
              log("error", "agent_v2.configuration_blocked_no_retry", {
                jobId,
                ruleOrPart: e.ruleOrPart,
                error: message,
              });
            } else {
              const retryState = recordV2InfrastructureRetry(
                v2WorkRoot,
                e.ruleOrPart,
                message,
              );
              const delayMs = Math.min(
                60_000,
                5000 * 2 ** Math.min(4, Math.max(0, retryState.count - 1)),
              );
              this.db.updateJob(jobId, {
                status: "blocked",
                message: `blocked: infrastructure; automatic retry ${retryState.count} scheduled`,
                error: message,
              });
              log("warn", "agent_v2.infrastructure_retry_scheduled", {
                jobId,
                delayMs,
                retryCount: retryState.count,
                ruleOrPart: e.ruleOrPart,
              });
              setTimeout(() => this.start(jobId), delayMs);
            }
          } else {
            const state = this.db.getArtifactRunState(jobId);
            const latest = state?.attempts.at(-1);
            const duplicateCount = latest
              ? state!.attempts.filter(
                  (attempt) => attempt.fingerprint === latest.fingerprint,
                ).length
              : 1;
            if (duplicateCount < 2) {
              const delayMs = Math.min(
                60_000,
                5000 * 2 ** Math.max(0, duplicateCount - 1),
              );
              log("warn", "artifact.infrastructure_retry_scheduled", {
                jobId,
                delayMs,
                fingerprint: latest?.fingerprint ?? null,
              });
              setTimeout(() => this.start(jobId), delayMs);
            }
          }
        }
        return;
      }
      if (
        current &&
        current.status !== "cancelled" &&
        artifactKinds.includes(current.kind)
      ) {
        const classified = classifyArtifactFailure(e);
        const blocked = classified.failureClass === "INFRA";
        this.db.updateJob(jobId, {
          status: blocked ? "blocked" : "failed",
          progress: Math.max(10, Math.min(96, current.progress)),
          message: blocked
            ? "blocked: infrastructure"
            : "Artifact stopped: unexpected deterministic failure",
          error: classified.message,
        });
        const existing = this.db.raw
          .prepare(
            "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
          )
          .get(jobId) as { id: string } | undefined;
        if (existing)
          this.db.updateMessage(existing.id, {
            status: "failed",
            error: classified.message,
          });
        log(blocked ? "warn" : "error", "artifact.unexpected_failure_stopped", {
          jobId,
          kind: current.kind,
          failureClass: classified.failureClass,
          ruleOrPart: classified.ruleOrPart,
          error: classified.message,
        });
        return;
      }
      this.db.updateJob(jobId, {
        status: "failed",
        message: "Failed",
        error: message,
      });
      const existing = this.db.raw
        .prepare(
          "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get(jobId) as { id: string } | undefined;
      if (existing)
        this.db.updateMessage(existing.id, {
          status: "failed",
          error: message,
        });
      log("error", "job.failed", { jobId, error: message });
    }
  }
}
