import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

type ArtifactLogContext = { jobId: string; filePath: string };
const artifactLogStorage = new AsyncLocalStorage<ArtifactLogContext>();

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function artifactRunLogPath(config: Config, jobId: string): string {
  return path.join(config.dataDir, "artifact-run-logs", `${safeJobId(jobId)}.jsonl`);
}

export async function withArtifactRunLog<T>(
  config: Config,
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const filePath = artifactRunLogPath(config, jobId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
  return artifactLogStorage.run({ jobId, filePath }, fn);
}

export function currentArtifactJobId(): string | null {
  return artifactLogStorage.getStore()?.jobId ?? null;
}

export function appendCurrentArtifactLog(line: string): void {
  const context = artifactLogStorage.getStore();
  if (!context) return;
  try {
    fs.appendFileSync(context.filePath, `${line}
`, "utf8");
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "artifact.run_log_write_failed",
        jobId: context.jobId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function readArtifactRunLog(config: Config, jobId: string): string {
  const filePath = artifactRunLogPath(config, jobId);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}
