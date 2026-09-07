import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { log } from "./log.js";

/** Temporary personal-instance policy, reversible with AGENT_CLEAN_START=false. */
export function cleanStartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_CLEAN_START?.trim().toLowerCase();
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error("AGENT_CLEAN_START must be true or false");
  return value === "true" || (value === undefined && env.AGENT_SANDBOX_PROVIDER === "render");
}

export function cleanFailedWork(config: Config, db: Db, options: {
  boot?: boolean; isActive?: (id: string) => boolean;
} = {}) {
  const statuses = options.boot
    ? ["failed", "blocked", "cancelled", "queued", "running", "building", "waiting_approval"]
    : ["failed", "blocked", "cancelled"];
  const jobs = (db.raw.prepare(`SELECT id, file_ids_json files, conversation_id conversationId FROM jobs WHERE status IN (${statuses.map(() => "?").join(",")})`).all(...statuses) as Array<{ id: string; files: string; conversationId: string }>)
    .filter(job => !options.isActive?.(job.id));
  let removedPaths = 0;
  const storageRoot = fs.realpathSync(config.storageRoot);
  const remove = (target: string) => {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(storageRoot + path.sep)) throw new Error("Cleanup path escapes storage root");
    if (!fs.existsSync(resolved)) return;
    if (!fs.realpathSync(path.dirname(resolved)).startsWith(storageRoot + path.sep) && fs.realpathSync(path.dirname(resolved)) !== storageRoot)
      throw new Error("Cleanup parent escapes storage root");
    fs.rmSync(resolved, { recursive: true, force: true });
    removedPaths++;
  };
  const candidates = new Set<string>();
  for (const job of jobs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new Error("Invalid cleanup job identifier");
    const ids: unknown = JSON.parse(job.files);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid cleanup attachment list");
    ids.forEach(id => candidates.add(id));
    for (const artifact of db.raw.prepare("SELECT path FROM artifacts WHERE job_id=?").all(job.id) as Array<{ path: string }>) remove(artifact.path);
    remove(path.join(config.artifactDir, ".agent-v2", job.id));
    remove(path.join(config.storageRoot, "diagnostics", job.id));
    remove(path.join(config.dataDir, "artifact-run-logs", `${job.id}.jsonl`));
    remove(path.join(config.dataDir, "artifact-run-logs", `${job.id}.jsonl.1`));
  }
  db.raw.transaction(() => {
    for (const job of jobs) {
      db.raw.prepare("DELETE FROM messages WHERE job_id=?").run(job.id);
      db.raw.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
    }
    for (const id of new Set(jobs.map(job => job.conversationId)))
      db.raw.prepare("DELETE FROM conversations WHERE id=? AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id=conversations.id) AND NOT EXISTS (SELECT 1 FROM jobs WHERE conversation_id=conversations.id)").run(id);
  })();
  const referenced = new Set<string>();
  for (const row of db.raw.prepare("SELECT file_ids_json files FROM jobs").all() as Array<{ files: string }>) {
    const ids: unknown = JSON.parse(row.files);
    if (!Array.isArray(ids)) throw new Error("Invalid retained attachment list");
    ids.forEach(id => { if (typeof id === "string") referenced.add(id); });
  }
  for (const upload of db.raw.prepare("SELECT id,path FROM uploads WHERE NOT EXISTS (SELECT 1 FROM message_uploads WHERE upload_id=uploads.id)").all() as Array<{ id: string; path: string }>) {
    if (referenced.has(upload.id) || (!options.boot && !candidates.has(upload.id))) continue;
    remove(upload.path);
    db.raw.prepare("DELETE FROM uploads WHERE id=?").run(upload.id);
  }
  // SDK-created workspaces have no live owner during boot. Never sweep these
  // during a browser open, when another tab may have a legitimate running task.
  if (options.boot) {
    for (const entry of fs.readdirSync(storageRoot))
      if (entry.startsWith("openai-agents-sandbox-")) remove(path.join(storageRoot, entry));
    db.raw.pragma("wal_checkpoint(TRUNCATE)");
  }
  const result = { clearedJobs: jobs.length, removedPaths };
  log("info", "workspace.clean_start_completed", { ...result, boot: Boolean(options.boot) });
  return result;
}
