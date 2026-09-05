import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { validateFile } from "@xarsh/ooxml-validator";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import { log } from "./log.js";
import type { AnalysisNumericProvenanceReceipt } from "./artifact-provenance.js";
import {
  FOUR_CORNERS_LABEL_REPAIR_MESSAGE,
  isGenericFourCornersLabel,
} from "./reconcile.js";
import {
  expectedPresentationIdentityMarkers,
  extractPresentationIdentityMarkers,
  presentationIdentityMarkers,
} from "./artifact-identity.js";

const PLACEHOLDER_RE = /\b(?:tbd|lorem ipsum|placeholder|insert (?:text|content|image)|add (?:content|details)|coming soon)\b|\[(?:insert|add|todo)[^\]]*\]/i;
const TODO_PLACEHOLDER_RE = /\bTODO\b/;
function hasPlaceholderText(value:string):boolean {
  return TODO_PLACEHOLDER_RE.test(value) || PLACEHOLDER_RE.test(value);
}
const SPEED_DATING_RE = /speed[\s-]*dating/i;
const FOUR_CORNERS_RE = /(?:four|4)[\s-]*corners/i;
const TEACHING_RE = /\b(?:teach|teaching|lesson|students?|classroom|practice)\b/i;
const SCHEMA_VALIDATOR = "Open XML SDK 3.5.1 (via @xarsh/ooxml-validator 0.3.0)";
const PPTX_GENERATOR = "pptxgenjs 4.0.1";
const DOCX_GENERATOR = "docx 9.7.1";
const PPTX_NOTES_MASTER_INCIDENT = "2026-09-02 PowerPoint notesMasterIdLst ordering incident";
const KNOWN_BENIGN_NOTES_MASTER_FINDING = {
  id: "Sch_UnexpectedElementContentExpectingComplex",
  path: "/ppt/presentation.xml",
  xPath: "/p:presentation[1]",
  descriptionIncludes: "notesMasterIdLst",
} as const;

export interface ArtifactValidationFinding {
  id?: string;
  path?: string;
  xPath?: string;
  description?: string;
  errorType?: string;
  reason: string;
  incident: string;
}

export type ArtifactFailureClass =
  | "PLAN_CONTENT"
  | "PLAN_NORMALIZABLE"
  | "ASSET"
  | "BUILD"
  | "INFRA";

export interface ArtifactAttemptReceipt {
  failureClass: ArtifactFailureClass;
  fingerprint: string;
  ruleOrPart: string;
  planSha: string;
  packageSha: string | null;
  strategy: string;
  diagnosticPath: string | null;
  at: string;
}

export interface ArtifactNormalizationReceipt {
  code: string;
  detail: string;
}

export interface ArtifactPlanViolation {
  code: string;
  message: string;
  mandatory: boolean;
}

export class ArtifactPipelineError extends Error {
  readonly failureClass: ArtifactFailureClass;
  readonly ruleOrPart: string;
  readonly packageSha: string | null;
  diagnosticPath: string | null;

  constructor(
    failureClass: ArtifactFailureClass,
    message: string,
    options: {
      ruleOrPart?: string;
      packageSha?: string | null;
      diagnosticPath?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ArtifactPipelineError";
    this.failureClass = failureClass;
    this.ruleOrPart = options.ruleOrPart ?? "unknown";
    this.packageSha = options.packageSha ?? null;
    this.diagnosticPath = options.diagnosticPath ?? null;
  }
}

export interface ArtifactQualityScores {
  layoutVariety: {
    score: number;
    distinctTemplates: number;
    contentSections: number;
    templates: string[];
  };
  emptyCanvasRatio: {
    average: number | null;
    bySlide: number[];
    method: string;
  };
  notesCoverage: {
    score: number;
    sectionsWithNotes: number;
    contentSections: number;
  };
  sourceTopicality: {
    score: number | null;
    status: "pending_qualitative_review";
    reason: string;
  };
}

export interface ArtifactValidationReceipt {
  kind: JobKind;
  artifactSha256: string;
  bytes: number;
  requirements: number;
  schemaValidator: string | null;
  renderValidator: string | null;
  powerPointDesktopValidated: boolean;
  wordDesktopValidated: boolean;
  browserValidated: boolean;
  scores: ArtifactQualityScores;
  buildSha: string;
  generatorVersion: string;
  knownBenignFindings: ArtifactValidationFinding[];
  llmCalls: number;
  maxLlmCalls: number;
  wallTimeMs: number;
  attempts: ArtifactAttemptReceipt[];
  normalizations: ArtifactNormalizationReceipt[];
  qualityWarnings: ArtifactNormalizationReceipt[];
  analysisProvenance?: AnalysisNumericProvenanceReceipt;
}

export function asArtifactPipelineError(
  error: unknown,
  fallbackClass: ArtifactFailureClass = "BUILD",
  fallbackPart = "unknown",
): ArtifactPipelineError {
  if (error instanceof ArtifactPipelineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ArtifactPipelineError(fallbackClass, message, {
    ruleOrPart: fallbackPart,
    cause: error,
  });
}

function currentBuildSha(): string {
  return (
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    "unknown"
  );
}

function isKnownBenignFinding(error: any): boolean {
  const xPath = error?.xPath ?? error?.xpath;
  return (
    error?.id === KNOWN_BENIGN_NOTES_MASTER_FINDING.id &&
    error?.path === KNOWN_BENIGN_NOTES_MASTER_FINDING.path &&
    xPath === KNOWN_BENIGN_NOTES_MASTER_FINDING.xPath &&
    String(error?.description ?? "").includes(
      KNOWN_BENIGN_NOTES_MASTER_FINDING.descriptionIncludes,
    )
  );
}

function benignFindingReceipt(error: any): ArtifactValidationFinding {
  return {
    id: error?.id,
    path: error?.path,
    xPath: error?.xPath ?? error?.xpath,
    description: error?.description,
    errorType: error?.errorType,
    reason:
      "Raw PptxGenJS notesMasterIdLst ordering is accepted by PowerPoint Desktop; reordering it caused PowerPoint to reject the artifact.",
    incident: PPTX_NOTES_MASTER_INCIDENT,
  };
}

function allPlanText(plan: ArtifactPlan): string {
  return [
    plan.title,
    plan.subtitle,
    ...(plan.requirements ?? []).map((requirement) => requirement.text),
    ...plan.sections.flatMap((section) => [
      section.heading,
      section.body,
      ...section.bullets,
      section.speakerNotes,
      ...(section.activity?.directions ?? []),
      ...(section.activity?.prompts ?? []),
      ...(section.activity?.sentenceFrames ?? []),
      ...(section.activity?.cornerLabels ?? []),
    ]),
  ].join("\n");
}

function sectionText(section: ArtifactPlan["sections"][number]): string {
  return [
    section.heading,
    section.body,
    ...section.bullets,
    section.speakerNotes,
    ...(section.activity?.directions ?? []),
    ...(section.activity?.prompts ?? []),
    ...(section.activity?.sentenceFrames ?? []),
    ...(section.activity?.cornerLabels ?? []),
  ].join("\n");
}

function activityQualityViolations(
  section: ArtifactPlan["sections"][number],
): ArtifactPlanViolation[] {
  const activity = section.activity;
  if (!activity) return [];
  const violations: ArtifactPlanViolation[] = [];
  const push = (code: string, message: string) =>
    violations.push({ code, message, mandatory: true });

  if (activity.type === "speed_dating") {
    if (activity.prompts.length < 4)
      push(
        "speed_dating_prompts",
        "Artifact quality validation failed: Speed Dating requires at least four usable prompts",
      );
    if (activity.sentenceFrames.length < 2)
      push(
        "speed_dating_frames",
        "Artifact quality validation failed: Speed Dating requires at least two language frames",
      );
    if (activity.directions.length < 3)
      push(
        "speed_dating_directions",
        "Artifact quality validation failed: Speed Dating requires setup, rotation, and response directions",
      );
  }
  if (activity.type === "four_corners") {
    if (activity.cornerLabels.length !== 4)
      push(
        "four_corners_labels",
        "Artifact quality validation failed: Four Corners requires exactly four corner labels",
      );
    else if (activity.cornerLabels.some(isGenericFourCornersLabel))
      push(
        "four_corners_labels_generic",
        FOUR_CORNERS_LABEL_REPAIR_MESSAGE,
      );
    if (activity.prompts.length < 1)
      push(
        "four_corners_prompt",
        "Artifact quality validation failed: Four Corners requires a decision prompt",
      );
    if (activity.sentenceFrames.length < 2)
      push(
        "four_corners_frames",
        "Artifact quality validation failed: Four Corners requires at least two discussion frames",
      );
  }
  if (activity.type === "exit_ticket" && activity.prompts.length < 2)
    push(
      "exit_ticket_prompts",
      "Artifact quality validation failed: an exit ticket requires at least two checks",
    );
  return violations;
}

export function artifactPlanQualityViolations(
  kind: JobKind,
  prompt: string,
  plan: ArtifactPlan,
): ArtifactPlanViolation[] {
  const violations: ArtifactPlanViolation[] = [];
  const requirements = plan.requirements ?? [];
  const push = (
    code: string,
    message: string,
    mandatory = true,
  ) => violations.push({ code, message, mandatory });

  if (
    prompt.trim() &&
    (requirements.length === 0 ||
      requirements.every((item) => !item.mandatory))
  )
    push(
      "mandatory_requirements_missing",
      "Artifact quality validation failed: prompt-specific mandatory requirements were not extracted",
    );

  const serialized = allPlanText(plan);
  if (hasPlaceholderText(serialized))
    push(
      "placeholder_text",
      "Artifact quality validation failed: unfinished placeholder language is present",
    );

  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id))
      push(
        "duplicate_requirement_id",
        `Artifact quality validation failed: duplicate requirement id ${requirement.id}`,
        false,
      );
    ids.add(requirement.id);
  }

  for (const section of plan.sections) {
    for (const id of section.requirementIds ?? [])
      if (!ids.has(id))
        push(
          "unknown_requirement_id",
          `Artifact quality validation failed: section '${section.heading}' references unknown requirement ${id}`,
          false,
        );
    violations.push(...activityQualityViolations(section));
  }

  for (const requirement of requirements.filter((item) => item.mandatory)) {
    const covered = plan.sections.some((section) =>
      (section.requirementIds ?? []).includes(requirement.id),
    );
    if (!covered)
      push(
        "mandatory_requirement_uncovered",
        `Artifact quality validation failed: mandatory requirement ${requirement.id} is not covered: ${requirement.text}`,
      );
  }

  if (kind === "presentation") {
    if (plan.sections.length > 14)
      push(
        "presentation_sections_excess",
        `Presentation compiled to ${plan.sections.length} content sections; this is a quality metric, not a validity failure.`,
        false,
      );
    const activityTypes = new Set(
      plan.sections
        .map((section) => section.activity?.type)
        .filter(Boolean),
    );
    if (
      SPEED_DATING_RE.test(prompt) &&
      !activityTypes.has("speed_dating")
    )
      push(
        "speed_dating_missing",
        "Artifact quality validation failed: the prompt explicitly requires a Speed Dating activity slide",
      );
    if (
      FOUR_CORNERS_RE.test(prompt) &&
      !activityTypes.has("four_corners")
    )
      push(
        "four_corners_missing",
        "Artifact quality validation failed: the prompt explicitly requires a Four Corners activity slide",
      );
    if (
      TEACHING_RE.test(prompt) &&
      !plan.sections.some((section) => section.activity)
    )
      push(
        "student_practice_missing",
        "Artifact quality validation failed: a teaching deck requires active student practice",
      );
  }

  if (kind === "website") {
    const pages = plan.pages ?? [];
    const slugs = pages.map((page) => page.slug);
    if (slugs.length !== new Set(slugs).size)
      push(
        "website_duplicate_slugs",
        "Artifact quality validation failed: website page slugs must be unique",
      );
    if (!slugs.includes("index"))
      push(
        "website_index_missing",
        "Artifact quality validation failed: website plan requires an index page",
      );

    const knownHeadings = new Set(
      plan.sections
        .filter((section) => !/^(sources|references|bibliography|works cited)$/i.test(section.heading.trim()))
        .map((section) => section.heading),
    );
    const assignmentCounts = new Map<string, number>();
    for (const page of pages) {
      for (const heading of page.sectionHeadings) {
        if (!knownHeadings.has(heading))
          push(
            "website_unknown_section_assignment",
            `Artifact quality validation failed: website page '${page.slug}' references unknown section '${heading}'`,
          );
        assignmentCounts.set(
          heading,
          (assignmentCounts.get(heading) ?? 0) + 1,
        );
      }
    }
    for (const heading of knownHeadings) {
      const count = assignmentCounts.get(heading) ?? 0;
      if (count !== 1)
        push(
          count === 0
            ? "website_section_unassigned"
            : "website_section_multiply_assigned",
          `Artifact quality validation failed: website section '${heading}' must be assigned exactly once; found ${count} assignments`,
        );
    }
  }

  return violations;
}

export function assertArtifactPlanQuality(
  kind: JobKind,
  prompt: string,
  plan: ArtifactPlan,
): void {
  const violations = artifactPlanQualityViolations(kind, prompt, plan);
  const blocking = violations.filter((violation) => violation.mandatory);
  if (!blocking.length) return;
  throw new ArtifactPipelineError(
    "PLAN_CONTENT",
    `Artifact plan content violations:\n${blocking
      .map((violation) => `- [${violation.code}] ${violation.message}`)
      .join("\n")}`,
    { ruleOrPart: "plan-content" },
  );
}

function assertRequiredEntries(zip: AdmZip, required: string[]): void {
  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  for (const name of required)
    if (!names.has(name))
      throw new Error(`Artifact package validation failed: missing required entry ${name}`);
}

function assertCleanXml(zip: AdmZip): void {
  for (const entry of zip.getEntries().filter((item) => item.entryName.endsWith(".xml"))) {
    const xml = entry.getData().toString("utf8");
    if (/(\s[\w:.-]+)="(?:NaN|undefined|null)"/.test(xml))
      throw new Error(`Artifact package validation failed: invalid serialized value in ${entry.entryName}`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml))
      throw new Error(`Artifact package validation failed: forbidden control character in ${entry.entryName}`);
  }
}

export function assertPresentationPackage(buffer: Buffer): void {
  const zip = new AdmZip(buffer);
  assertRequiredEntries(zip, [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ]);
  assertCleanXml(zip);
  const slides = zip.getEntries().filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
  if (slides.length < 2)
    throw new Error("Presentation package validation failed: fewer than two slides");

  const presentationXml = zip
    .getEntry("ppt/presentation.xml")!
    .getData()
    .toString("utf8");
  const hasNotes = zip.getEntries().some((entry) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName),
  );
  if (hasNotes) {
    if (/<\/p:sldMasterIdLst>\s*<p:notesMasterIdLst\b/.test(presentationXml))
      throw new Error(
        "Presentation package validation failed: notesMasterIdLst was moved before sldIdLst; PowerPoint Desktop rejects this proven-bad form",
      );
    if (!/<\/p:sldIdLst>\s*<p:notesMasterIdLst\b/.test(presentationXml))
      throw new Error(
        "Presentation package validation failed: notesMasterIdLst is not in the proven PowerPoint-compatible native PptxGenJS position after sldIdLst",
      );
  }
}

export function assertDocumentPackage(buffer: Buffer): void {
  const zip = new AdmZip(buffer);
  assertRequiredEntries(zip, ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assertCleanXml(zip);
  const documentXml = zip.getEntry("word/document.xml")!.getData().toString("utf8");
  if (!/<w:t[ >]/.test(documentXml))
    throw new Error("Document package validation failed: document contains no visible text");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function assertPresentationSlidesHaveMeaningfulContent(filePath: string): void {
  const zip = new AdmZip(filePath);
  const slides = zip.getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  for (const [index, entry] of slides.entries()) {
    const xml = entry.getData().toString("utf8");
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1]!).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\b(?:AGENT DÍAZ|VISUAL BRIEF|EVIDENCE TRAIL|DIRECTIONS|PART \d+|\d{1,3})\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const hasSubstantiveText = text.length >= 8;
    const hasMeaningfulVisual = /<p:(?:pic|graphicFrame)\b/.test(xml);
    if (!hasSubstantiveText && !hasMeaningfulVisual)
      throw new ArtifactPipelineError(
        "BUILD",
        `Presentation contains an objectively empty slide at slide ${index + 1}.`,
        { ruleOrPart: `pptx-empty-slide-${index + 1}` },
      );
  }
}

export function assertPresentationStructuralCoverage(
  filePath: string,
  plan: ArtifactPlan,
): void {
  const zip = new AdmZip(filePath);
  const notesText = zip
    .getEntries()
    .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName))
    .flatMap((entry) =>
      [...entry.getData().toString("utf8").matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXml(match[1]!)),
    )
    .join("");
  const emitted = extractPresentationIdentityMarkers(notesText);
  const expected = expectedPresentationIdentityMarkers(plan);
  const missing = plan.sections.flatMap((section, index) =>
    presentationIdentityMarkers(section, index)
      .filter((marker) => !emitted.has(marker))
      .map((marker) => `${marker} (${section.activity?.type ?? "section"}: ${section.heading})`),
  );
  if (missing.length)
    throw new ArtifactPipelineError(
      "BUILD",
      `Presentation structural manifest is missing ${missing.length} emitted item(s): ${missing.join(", ")}`,
      { ruleOrPart: "pptx-structural-manifest" },
    );
  log("info", "artifact.structural_coverage_passed", {
    kind: "presentation",
    expected: expected.length,
    emitted: emitted.size,
  });
}

export function assertWebsitePackage(filePath: string): void {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const names = new Set(entries.map((entry) => entry.entryName));
  if (
    !names.has("index.html") ||
    !names.has("MAIN_HOMEPAGE.html") ||
    !names.has("OPEN_ME_FIRST_HOME_PAGE.html") ||
    !names.has("OPEN_ME_FIRST.html")
  )
    throw new Error("Website package validation failed: missing canonical or labelled homepage entry");
  const htmlEntries = entries.filter((entry) => entry.entryName.endsWith(".html"));
  if (htmlEntries.length < 4)
    throw new Error("Website package validation failed: expected at least three pages plus credits");
  for (const entry of htmlEntries) {
    const html = entry.getData().toString("utf8");
    if (!/<title>[^<]+<\/title>/i.test(html) || !/<nav\b/i.test(html) || !/<main\b/i.test(html))
      throw new Error(`Website package validation failed: incomplete semantic shell in ${entry.entryName}`);
    if (hasPlaceholderText(html))
      throw new Error(`Website package validation failed: placeholder content in ${entry.entryName}`);
    if (
      entry.entryName !== "MAIN_HOMEPAGE.html" &&
      !html.includes('href="MAIN_HOMEPAGE.html"')
    )
      throw new Error(`Website package validation failed: ${entry.entryName} does not link to MAIN_HOMEPAGE.html`);
    if (/data:image\//i.test(html))
      throw new Error(
        `Website package validation failed: embedded base64 image found in ${entry.entryName}`,
      );
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const href = match[1]!;
      if (/^(?:https?:|mailto:|tel:|#)/i.test(href)) continue;
      const target = href.split(/[?#]/)[0]!.replace(/^\.\//, "");
      if (
        target.includes("..") ||
        (target && !names.has(target))
      )
        throw new Error(
          `Website package validation failed: broken internal resource '${href}' in ${entry.entryName}`,
        );
    }
  }
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function renderOfficeArtifact(filePath: string): Promise<string | null> {
  const command = process.env.SOFFICE_PATH?.trim() || "soffice";
  const probe = await runProcess(command, ["--version"], 15_000).catch(() => null);
  if (!probe || probe.code !== 0) {
    if (process.env.NODE_ENV === "production")
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice is unavailable in production",
        { ruleOrPart: "soffice-probe" },
      );
    log("warn", "artifact.render_skipped", {
      filePath: path.basename(filePath),
      reason: "soffice unavailable outside production",
    });
    return null;
  }
  const version =
    (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] || "LibreOffice";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-render-"));
  try {
    const profileUrl = pathToFileURL(path.join(tempDir, "profile")).href;
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runProcess(
        command,
        [
          `-env:UserInstallation=${profileUrl}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          tempDir,
          filePath,
        ],
        90_000,
      );
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Artifact render validation blocked: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "soffice-convert", cause: error },
      );
    }
    if (result.code !== 0)
      throw new ArtifactPipelineError(
        "BUILD",
        `LibreOffice render rejected the artifact: ${result.stderr || result.stdout}`,
        { ruleOrPart: "libreoffice-render" },
      );
    const pdfPath = path.join(tempDir, `${path.parse(filePath).name}.pdf`);
    if (!fs.existsSync(pdfPath))
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice produced no PDF",
        { ruleOrPart: "soffice-output" },
      );
    const pdf = fs.readFileSync(pdfPath);
    if (
      pdf.length < 5_000 ||
      pdf.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice output is invalid or unexpectedly small",
        { ruleOrPart: "soffice-output" },
      );
    return version;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function roundedRatio(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function qualityLayoutSignature(
  section: ArtifactPlan["sections"][number],
): string {
  const primitive = section.activity
    ? `activity:${section.activity.type}`
    : section.chart
      ? "chart"
      : section.table
        ? "table"
        : section.diagram
          ? "diagram"
          : section.imageQuery
            ? "image"
            : "text";
  return `${section.layout ?? "standard"}:${primitive}`;
}

export function estimatePptxEmptyCanvasRatio(filePath: string): {
  average: number | null;
  bySlide: number[];
  method: string;
} {
  const zip = new AdmZip(filePath);
  const presentationXml =
    zip.getEntry("ppt/presentation.xml")?.getData().toString("utf8") ?? "";
  const size = presentationXml.match(
    /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/,
  );
  const slideWidth = Number(size?.[1] ?? 12192000);
  const slideHeight = Number(size?.[2] ?? 6858000);
  const slideArea = slideWidth * slideHeight;
  if (!Number.isFinite(slideArea) || slideArea <= 0)
    return {
      average: null,
      bySlide: [],
      method: "PPTX shape-box area estimate unavailable",
    };

  const slides = zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort((a, b) =>
      a.entryName.localeCompare(b.entryName, undefined, { numeric: true }),
    );
  const bySlide = slides.map((entry) => {
    const xml = entry.getData().toString("utf8");
    const rectangles: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const match of xml.matchAll(
      /<(a|p):xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>[\s\S]*?<\/\1:xfrm>/g,
    )) {
      const x = Number(match[2]);
      const y = Number(match[3]);
      const width = Number(match[4]);
      const height = Number(match[5]);
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      )
        rectangles.push({
          x1: Math.max(0, x),
          y1: Math.max(0, y),
          x2: Math.min(slideWidth, x + width),
          y2: Math.min(slideHeight, y + height),
        });
    }
    const xEdges = [
      ...new Set(rectangles.flatMap((rectangle) => [rectangle.x1, rectangle.x2])),
    ].sort((a, b) => a - b);
    let occupied = 0;
    for (let index = 0; index < xEdges.length - 1; index++) {
      const left = xEdges[index]!;
      const right = xEdges[index + 1]!;
      if (right <= left) continue;
      const intervals = rectangles
        .filter((rectangle) => rectangle.x1 < right && rectangle.x2 > left)
        .map((rectangle) => [rectangle.y1, rectangle.y2] as const)
        .filter(([top, bottom]) => bottom > top)
        .sort((a, b) => a[0] - b[0]);
      let vertical = 0;
      let start = -1;
      let end = -1;
      for (const [top, bottom] of intervals) {
        if (start < 0) {
          start = top;
          end = bottom;
        } else if (top <= end) end = Math.max(end, bottom);
        else {
          vertical += end - start;
          start = top;
          end = bottom;
        }
      }
      if (start >= 0) vertical += end - start;
      occupied += (right - left) * vertical;
    }
    return roundedRatio(1 - Math.min(1, occupied / slideArea));
  });
  return {
    average:
      bySlide.length > 0
        ? roundedRatio(
            bySlide.reduce((sum, value) => sum + value, 0) /
              bySlide.length,
          )
        : null,
    bySlide,
    method:
      "Estimated from the union of serialized PPTX a:xfrm/p:xfrm visual boxes.",
  };
}

function artifactQualityScores(
  kind: JobKind,
  plan: ArtifactPlan,
  filePath: string,
): ArtifactQualityScores {
  const sections = plan.sections.filter(
    (section) =>
      !/^(?:sources|references|bibliography|works cited)$/i.test(
        section.heading.trim(),
      ),
  );
  const templates = [
    ...new Set(sections.map((section) => qualityLayoutSignature(section))),
  ].sort();
  const sectionsWithNotes = sections.filter(
    (section) => section.speakerNotes.trim().length > 0,
  ).length;
  return {
    layoutVariety: {
      score:
        sections.length > 0
          ? roundedRatio(templates.length / sections.length)
          : 0,
      distinctTemplates: templates.length,
      contentSections: sections.length,
      templates,
    },
    emptyCanvasRatio:
      kind === "presentation"
        ? estimatePptxEmptyCanvasRatio(filePath)
        : {
            average: null,
            bySlide: [],
            method: "Not applicable outside PPTX.",
          },
    notesCoverage: {
      score:
        sections.length > 0
          ? roundedRatio(sectionsWithNotes / sections.length)
          : 0,
      sectionsWithNotes,
      contentSections: sections.length,
    },
    sourceTopicality: {
      score: null,
      status: "pending_qualitative_review",
      reason:
        "Source topicality is qualitative and is not inferred by the deterministic verifier; a model or human review must supply it.",
    },
  };
}

export async function validateBuiltArtifact(
  kind: JobKind,
  _prompt: string,
  plan: ArtifactPlan,
  filePath: string,
  diagnostics?: {
    root?: string;
    jobId?: string;
    presentationContentSlides?: number[];
  },
): Promise<ArtifactValidationReceipt> {
  try {
    const buffer = fs.readFileSync(filePath);
    if (kind === "presentation") {
      assertPresentationPackage(buffer);
      assertPresentationSlidesHaveMeaningfulContent(filePath);
      assertPresentationStructuralCoverage(filePath, plan);
    }
    else if (["document", "analysis", "research"].includes(kind))
      assertDocumentPackage(buffer);
    else if (kind === "website") assertWebsitePackage(filePath);

    // Empty-canvas ratio is diagnostic telemetry only. Truly empty slides are
    // rejected above using visible-content/package evidence.

    let schemaValidator: string | null = null;
    let renderValidator: string | null = null;
    const knownBenignFindings: ArtifactValidationFinding[] = [];
    if (
      kind === "presentation" ||
      ["document", "analysis", "research"].includes(kind)
    ) {
      let validation: Awaited<ReturnType<typeof validateFile>>;
      try {
        validation = await validateFile(filePath, {
          officeVersion: "Microsoft365",
        });
      } catch (error) {
        throw new ArtifactPipelineError(
          "INFRA",
          `OOXML validator execution failed: ${error instanceof Error ? error.message : String(error)}`,
          { ruleOrPart: "ooxml-validator", cause: error },
        );
      }
      schemaValidator = SCHEMA_VALIDATOR;
      const blockingErrors = [];
      for (const error of validation.errors ?? []) {
        if (kind === "presentation" && isKnownBenignFinding(error))
          knownBenignFindings.push(benignFindingReceipt(error));
        else blockingErrors.push(error);
      }
      if (blockingErrors.length) {
        const detail = blockingErrors
          .map(
            (error: any) =>
              `${error.path ?? "package"}: ${error.description ?? error.id ?? "schema error"}`,
          )
          .join("; ");
        throw new ArtifactPipelineError(
          "BUILD",
          `Microsoft 365 OOXML validation failed: ${detail || "unknown schema error"}`,
          {
            ruleOrPart: String(
              (blockingErrors[0] as any)?.path ??
                (blockingErrors[0] as any)?.xPath ??
                "ooxml-schema",
            ),
          },
        );
      }
      renderValidator = await renderOfficeArtifact(filePath);
    }

    const scores = artifactQualityScores(kind, plan, filePath);
    const qualityWarnings: ArtifactNormalizationReceipt[] = [];
    if (kind === "presentation") {
      const contentSlides =
        diagnostics?.presentationContentSlides ??
        plan.sections.map((_, index) => index + 2);
      const sparse = contentSlides
        .map((slideNumber) => ({ slideNumber, ratio: scores.emptyCanvasRatio.bySlide[slideNumber - 1] }))
        .filter((item): item is { slideNumber: number; ratio: number } =>
          typeof item.ratio === "number" && item.ratio > 0.55,
        );
      if (sparse.length)
        qualityWarnings.push({
          code: "pptx_empty_canvas_metric",
          detail: `Diagnostic only: ${sparse.map(({ slideNumber, ratio }) => `slide ${slideNumber}=${ratio.toFixed(3)}`).join(", ")}.`,
        });
    }
    const receipt: ArtifactValidationReceipt = {
      kind,
      artifactSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      requirements: plan.requirements?.length ?? 0,
      schemaValidator,
      renderValidator,
      powerPointDesktopValidated: false,
      wordDesktopValidated: false,
      browserValidated: false,
      scores,
      buildSha: currentBuildSha(),
      generatorVersion:
        kind === "presentation"
          ? PPTX_GENERATOR
          : ["document", "analysis", "research"].includes(kind)
            ? DOCX_GENERATOR
            : "Agent Díaz deterministic HTML ZIP",
      knownBenignFindings,
      llmCalls: 0,
      maxLlmCalls: 0,
      wallTimeMs: 0,
      attempts: [],
      normalizations: [],
      qualityWarnings,
    };
    log("info", "artifact.quality_passed", { ...receipt });
    return receipt;
  } catch (error) {
    const classified = asArtifactPipelineError(error, "BUILD", "artifact-build");
    if (
      diagnostics &&
      diagnostics.root &&
      diagnostics.jobId &&
      classified.failureClass === "BUILD" &&
      fs.existsSync(filePath)
    ) {
      const bytes = fs.readFileSync(filePath);
      const packageSha = crypto.createHash("sha256").update(bytes).digest("hex");
      const dir = path.join(diagnostics.root, diagnostics.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const diagnosticName = `${Date.now()}-${kind}-${packageSha.slice(0, 12)}${path.extname(filePath)}`;
      const diagnosticPath = path.join(dir, diagnosticName);
      fs.copyFileSync(filePath, diagnosticPath);
      fs.writeFileSync(
        `${diagnosticPath}.json`,
        JSON.stringify(
          {
            kind,
            packageSha,
            failureClass: classified.failureClass,
            ruleOrPart: classified.ruleOrPart,
            error: classified.message,
            sourceName: path.basename(filePath),
            capturedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      classified.diagnosticPath = diagnosticPath;
      log("warn", "artifact.diagnostic_preserved", {
        jobId: diagnostics.jobId,
        kind,
        packageSha,
        diagnosticPath,
        reason: classified.message,
      });
    }
    log("warn", "artifact.validation_failed", {
      file: path.basename(filePath),
      kind,
      failureClass: classified.failureClass,
      ruleOrPart: classified.ruleOrPart,
      diagnosticPath: classified.diagnosticPath,
      reason: classified.message,
    });
    throw classified;
  }
}
