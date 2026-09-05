import { appendCurrentArtifactLog, currentArtifactJobId } from "./artifact-run-log.js";

export type Level = "info" | "warn" | "error";

function clean(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_KEY]");
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      [k, /token|secret|authorization|password|api.?key/i.test(k) ? "[REDACTED]" : clean(v)]));
  }
  return value;
}

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const artifactJobId = currentArtifactJobId();
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(artifactJobId && !("jobId" in data) ? { jobId: artifactJobId } : {}),
    ...clean(data) as object,
  };
  const line = JSON.stringify(entry);
  appendCurrentArtifactLog(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
