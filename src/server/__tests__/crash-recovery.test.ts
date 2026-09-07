import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest } from "@openai/agents/sandbox";
import { artifactRecoveryDelay, beginArtifactExecution, finishArtifactExecution } from "../v2/crash-recovery.js";
import { RenderSandboxClient } from "../v2/render-sandbox.js";

describe("Render crash recovery", () => {
  it("backs off repeated process deaths without limiting artifact repair attempts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-recovery-"));
    try {
      expect(artifactRecoveryDelay(root)).toBe(60_000);
      beginArtifactExecution(root);
      beginArtifactExecution(root); // previous invocation never finished
      expect(artifactRecoveryDelay(root)).toBe(120_000);
      for (let i = 0; i < 20; i++) beginArtifactExecution(root);
      expect(artifactRecoveryDelay(root)).toBe(300_000);
      finishArtifactExecution(root);
      expect(artifactRecoveryDelay(root)).toBe(60_000);
      for (let i = 0; i < 20; i++) { beginArtifactExecution(root); finishArtifactExecution(root); }
      expect(artifactRecoveryDelay(root)).toBe(60_000);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves shell execution, exit status and prefers killing shell children over the web server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-shell-"));
    const session = await new RenderSandboxClient({ workspaceBaseDir: root }).create({ manifest: new Manifest({ root: "/workspace" }) });
    try {
      const result = await session.exec({ cmd: "printf 'durable' > proof.txt; cat proof.txt; exit 7", login: false });
      expect(result.output).toContain("durable");
      expect(result.exitCode).toBe(7);
      if (process.platform === "linux") {
        const parent = fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim();
        const child = await session.exec({ cmd: "cat /proc/self/oom_score_adj", login: false });
        expect(child.output.trim()).toBe("1000");
        expect(fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim()).toBe(parent);
      }
    } finally { await session.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
