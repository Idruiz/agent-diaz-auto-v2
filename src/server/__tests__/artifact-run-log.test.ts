import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../config";
import { log } from "../log";
import { readArtifactRunLog, withArtifactRunLog } from "../artifact-run-log";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact run logs", () => {
  it("captures the complete structured stream for one artifact job and keeps secrets redacted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-artifact-log-"));
    roots.push(root);
    const config = { dataDir: root } as Config;

    await withArtifactRunLog(config, "job-logs-1", async () => {
      log("info", "artifact.first", { value: 42, apiKey: "top-secret" });
      await Promise.resolve();
      log("warn", "artifact.second", { detail: "still here" });
    });

    const text = readArtifactRunLog(config, "job-logs-1");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "artifact.first",
      jobId: "job-logs-1",
      value: 42,
      apiKey: "[REDACTED]",
    });
    expect(lines[1]).toMatchObject({
      event: "artifact.second",
      jobId: "job-logs-1",
      detail: "still here",
    });
    expect(text).not.toContain("top-secret");
  });
});
