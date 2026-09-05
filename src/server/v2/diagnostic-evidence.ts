import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTIC_BYTES = 18 * 1024 * 1024;

export interface V2FailureDiagnosticInput {
  jobId: string;
  kind: string;
  attempt: number;
  failureClass: string;
  ruleOrPart: string;
  message: string;
  retryAdvice: string;
  planSha: string;
  stagnationCount: number;
  diagnosticPath?: string;
}

function mediaTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

async function renderOfficeDiagnosticPdf(
  sourcePath: string,
  jobId: string,
): Promise<{ bytes: Buffer; filename: string } | null> {
  if (!/\.(?:pptx|docx)$/i.test(sourcePath)) return null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-diagnostic-"));
  const profileDir = path.join(tempRoot, "profile");
  const outputDir = path.join(tempRoot, "out");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    await execFileAsync(
      "soffice",
      [
        "--headless",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--nofirststartwizard",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        sourcePath,
      ],
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    const pdfPath = path.join(
      outputDir,
      `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
    );
    if (!fs.existsSync(pdfPath)) return null;
    const bytes = fs.readFileSync(pdfPath);
    if (
      bytes.length < 2_000 ||
      bytes.length > MAX_DIAGNOSTIC_BYTES ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
      return null;
    return {
      bytes,
      filename: `${path.basename(sourcePath, path.extname(sourcePath))}-diagnostic-render.pdf`,
    };
  } catch (error) {
    log("warn", "agent_v2.diagnostic_render_unavailable", {
      jobId,
      source: path.basename(sourcePath),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function buildFailureToolOutput(
  input: V2FailureDiagnosticInput,
): Promise<any[]> {
  const attachments: any[] = [];
  let diagnosticAttached = false;
  let renderedPdfAttached = false;
  let diagnosticFileName: string | null = null;
  let diagnosticBytes: number | null = null;
  let diagnosticOmittedReason: string | null = null;

  if (input.diagnosticPath && fs.existsSync(input.diagnosticPath)) {
    try {
      const stat = fs.statSync(input.diagnosticPath);
      diagnosticFileName = path.basename(input.diagnosticPath);
      diagnosticBytes = stat.size;
      if (stat.isFile() && stat.size <= MAX_DIAGNOSTIC_BYTES) {
        attachments.push({
          type: "file",
          file: {
            data: new Uint8Array(fs.readFileSync(input.diagnosticPath)),
            filename: diagnosticFileName,
            mediaType: mediaTypeForPath(input.diagnosticPath),
          },
        });
        diagnosticAttached = true;
      } else if (stat.size > MAX_DIAGNOSTIC_BYTES) {
        diagnosticOmittedReason = `diagnostic exceeded ${MAX_DIAGNOSTIC_BYTES} byte agent-output limit`;
      }

      const rendered = await renderOfficeDiagnosticPdf(
        input.diagnosticPath,
        input.jobId,
      );
      if (rendered) {
        attachments.push({
          type: "file",
          file: {
            data: new Uint8Array(rendered.bytes),
            filename: rendered.filename,
            mediaType: "application/pdf",
          },
        });
        renderedPdfAttached = true;
      }
    } catch (error) {
      diagnosticOmittedReason =
        error instanceof Error ? error.message : String(error);
      log("warn", "agent_v2.diagnostic_attachment_failed", {
        jobId: input.jobId,
        error: diagnosticOmittedReason,
      });
    }
  }

  const summary = {
    ok: false,
    attempt: input.attempt,
    failureClass: input.failureClass,
    ruleOrPart: input.ruleOrPart,
    message: input.message,
    planSha: input.planSha,
    stagnationCount: input.stagnationCount,
    retryAdvice: input.retryAdvice,
    diagnosticAttached,
    renderedPdfAttached,
    diagnosticFileName,
    diagnosticBytes,
    diagnosticOmittedReason,
  };

  return [
    { type: "text", text: JSON.stringify(summary, null, 2) },
    ...attachments,
  ];
}
