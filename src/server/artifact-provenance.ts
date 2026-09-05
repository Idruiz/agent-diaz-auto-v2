import type { ArtifactPlan } from "../shared/contracts.js";
import { ArtifactPipelineError } from "./artifact-quality.js";

const URL_RE = /https?:\/\/\S+/gi;
const NUMERIC_TOKEN_RE =
  /(?<![\p{L}\p{N}_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu;

export interface AnalysisNumericProvenanceReceipt {
  numericClaimsChecked: number;
  evidenceNumericValues: number;
  unmatchedNumericClaims: string[];
  source: "prompt+evidence";
  pythonExecuted: boolean | null;
}

export function canonicalNumericToken(token: string): string {
  const trimmed = token.trim();
  const percent = trimmed.endsWith("%");
  const core = (percent ? trimmed.slice(0, -1) : trimmed).replace(/,/g, "");
  const numeric = Number(core);
  if (!Number.isFinite(numeric)) return trimmed;
  const normalized = Object.is(numeric, -0) ? "0" : String(numeric);
  return `${normalized}${percent ? "%" : ""}`;
}

export function extractNumericTokens(value: string): string[] {
  const withoutUrls = value.replace(URL_RE, " ");
  return [...withoutUrls.matchAll(NUMERIC_TOKEN_RE)].map((match) =>
    canonicalNumericToken(match[0]),
  );
}

function analysisPlanNumericTexts(plan: ArtifactPlan): string[] {
  const texts: string[] = [plan.title, plan.subtitle];
  for (const section of plan.sections) {
    texts.push(section.heading, section.body, ...section.bullets);
    if (section.table) {
      texts.push(section.table.title, ...section.table.headers);
      for (const row of section.table.rows) texts.push(...row);
    }
    if (section.chart) {
      texts.push(section.chart.title, ...section.chart.labels);
      for (const series of section.chart.series) {
        texts.push(series.name, ...series.values.map(String));
      }
      if (section.chart.unit) texts.push(section.chart.unit);
      if (section.chart.sourceNote) texts.push(section.chart.sourceNote);
    }
    if (section.diagram) {
      texts.push(section.diagram.title, ...section.diagram.nodes);
      if (section.diagram.caption) texts.push(section.diagram.caption);
    }
    if (section.activity) {
      texts.push(
        ...section.activity.directions,
        ...section.activity.prompts,
        ...section.activity.sentenceFrames,
        ...section.activity.cornerLabels,
      );
    }
  }
  return texts.filter(Boolean);
}

export function completedCodeInterpreterCalls(response: unknown): number {
  const output = (response as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return 0;
  return output.filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: string }).type === "code_interpreter_call" &&
      (item as { status?: string }).status === "completed",
  ).length;
}

export function codeInterpreterLogText(response: unknown): string {
  const output = (response as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return "";
  const logs: string[] = [];
  for (const item of output) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: string }).type !== "code_interpreter_call" ||
      (item as { status?: string }).status !== "completed"
    )
      continue;
    const outputs = (item as { outputs?: unknown[] | null }).outputs;
    if (!Array.isArray(outputs)) continue;
    for (const result of outputs)
      if (
        result &&
        typeof result === "object" &&
        (result as { type?: string }).type === "logs" &&
        typeof (result as { logs?: unknown }).logs === "string"
      )
        logs.push((result as { logs: string }).logs);
  }
  return logs.join("\n");
}

export function evidenceNumericValues(
  evidenceText: string,
  response?: unknown,
): string[] {
  return [
    ...new Set(
      extractNumericTokens(
        `${evidenceText}\n${response ? codeInterpreterLogText(response) : ""}`,
      ),
    ),
  ];
}

export function inspectAnalysisNumericProvenance(input: {
  plan: ArtifactPlan;
  prompt: string;
  evidenceNumericValues: string[];
  pythonExecuted?: boolean | null;
}): AnalysisNumericProvenanceReceipt {
  const claims = analysisPlanNumericTexts(input.plan).flatMap(extractNumericTokens);
  const allowedValues = new Set([
    ...extractNumericTokens(input.prompt),
    ...input.evidenceNumericValues.map(canonicalNumericToken),
  ]);
  const unmatched = [
    ...new Set(claims.filter((claim) => !allowedValues.has(claim))),
  ];
  return {
    numericClaimsChecked: claims.length,
    evidenceNumericValues: allowedValues.size,
    unmatchedNumericClaims: unmatched,
    source: "prompt+evidence",
    pythonExecuted: input.pythonExecuted ?? null,
  };
}

export function assertAnalysisNumericProvenance(input: {
  plan: ArtifactPlan;
  prompt: string;
  evidenceNumericValues: string[];
  pythonExecuted?: boolean | null;
}): AnalysisNumericProvenanceReceipt {
  const receipt = inspectAnalysisNumericProvenance(input);
  if (receipt.unmatchedNumericClaims.length)
    throw new ArtifactPipelineError(
      "PLAN_CONTENT",
      `Analysis provenance validation failed: these numeric claims are absent from the original request and executed evidence: ${receipt.unmatchedNumericClaims.join(", ")}`,
      { ruleOrPart: "analysis-numeric-provenance" },
    );
  return receipt;
}
