import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { cleanFailedWork, cleanStartEnabled } from "../clean-start.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-clean-"));
  const config = loadConfig({ NODE_ENV: "test", STORAGE_DIR: root, OPENAI_API_KEY: "test", ADMIN_PASSWORD: "test-password-long-enough" });
  const db = openDatabase(config);
  for (const dir of [config.artifactDir, config.uploadDir]) fs.mkdirSync(dir, { recursive: true });
  const put = (name: string) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "proof"); return target; };
  const job = (id: string, status: "failed" | "completed" | "building" | "blocked", files: string[] = []) => {
    const c = db.createConversation(`conversation-${id}`, id);
    db.createJob({ id, kind: "presentation", prompt: id, conversationId: c.id, fileIds: files });
    db.updateJob(id, { status });
    put(`artifacts/.agent-v2/${id}/INFRA_RETRY.json`);
    put(`data/artifact-run-logs/${id}.jsonl`);
    put(`diagnostics/${id}/failed.pptx`);
  };
  return { root, config, db, put, job, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe("temporary clean-start policy", () => {
  it("is enabled for Render and can be explicitly disabled", () => {
    expect(cleanStartEnabled({ AGENT_SANDBOX_PROVIDER: "render" })).toBe(true);
    expect(cleanStartEnabled({ AGENT_SANDBOX_PROVIDER: "render", AGENT_CLEAN_START: "false" })).toBe(false);
    expect(() => cleanStartEnabled({ AGENT_CLEAN_START: "maybe" })).toThrow("true or false");
  });
  it("clears failed prompts and disk files on open, preserving active work and shared uploads", () => {
    const f = fixture();
    try {
      for (const id of ["shared", "failed-only"]) f.db.addUpload({ id, name: id, mime: "text/plain", size: 5, path: f.put(`uploads/${id}`), openaiFileId: `file-${id}` });
      f.job("failed", "failed", ["shared", "failed-only"]);
      f.job("complete", "completed", ["shared"]);
      f.job("live", "building");
      f.job("closing", "blocked");
      const result = cleanFailedWork(f.config, f.db, { isActive: id => id === "closing" });
      expect(result.clearedJobs).toBe(1);
      expect(f.db.getJob("failed")).toBeUndefined();
      expect(f.db.getConversation("conversation-failed")).toBeUndefined();
      expect(f.db.getJob("complete")?.status).toBe("completed");
      expect(f.db.getJob("live")?.status).toBe("building");
      expect(f.db.getJob("closing")?.status).toBe("blocked");
      expect(fs.existsSync(path.join(f.root, "uploads/shared"))).toBe(true);
      for (const name of ["uploads/failed-only", "artifacts/.agent-v2/failed", "data/artifact-run-logs/failed.jsonl", "diagnostics/failed"]) expect(fs.existsSync(path.join(f.root, name))).toBe(false);
      expect(cleanFailedWork(f.config, f.db, { isActive: id => id === "closing" }).clearedJobs).toBe(0);
    } finally { f.close(); }
  });
  it("removes every interrupted job at boot and sweeps abandoned SDK workspaces", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 105; i++) f.job(`old-${i}`, "building");
      const orphan = f.put("openai-agents-sandbox-abandoned/large.tmp");
      const completed = f.put("artifacts/completed.pptx");
      f.job("complete", "completed");
      expect(cleanFailedWork(f.config, f.db, { boot: true }).clearedJobs).toBe(105);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(completed)).toBe(true);
      expect(f.db.listJobs()).toHaveLength(1);
    } finally { f.close(); }
  });
});
