import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface V2RevisionLedgerEntry {
  attempt: number;
  planSha: string;
  status: "validated" | "rejected";
  buildId?: string;
  failureClass?: string;
  ruleOrPart?: string;
  message?: string;
  stagnationCount?: number;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeV2AttemptPlan(
  workRoot: string,
  attempt: number,
  plan: unknown,
): { attemptDir: string; planPath: string; planSha: string } {
  const attemptDir = path.join(workRoot, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const planPath = path.join(attemptDir, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { attemptDir, planPath, planSha: sha256Json(plan) };
}

export function appendV2RevisionEntry(
  workRoot: string,
  entry: V2RevisionLedgerEntry,
): void {
  fs.mkdirSync(workRoot, { recursive: true });
  fs.appendFileSync(
    path.join(workRoot, "REVISION_HISTORY.jsonl"),
    `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export function listV2RecoveryFiles(
  workRoot: string,
): Array<{ workspacePath: string; hostPath: string }> {
  const out: Array<{ workspacePath: string; hostPath: string }> = [];
  const historyPath = path.join(workRoot, "REVISION_HISTORY.jsonl");
  if (fs.existsSync(historyPath))
    out.push({
      workspacePath: "recovery/REVISION_HISTORY.jsonl",
      hostPath: historyPath,
    });

  if (!fs.existsSync(workRoot)) return out;
  const attempts = fs
    .readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      number: Number(entry.name.replace("attempt-", "")),
    }))
    .sort((a, b) => b.number - a.number);
  const latest = attempts[0];
  if (latest) {
    const planPath = path.join(workRoot, latest.name, "plan.json");
    if (fs.existsSync(planPath))
      out.push({
        workspacePath: "recovery/LATEST_PLAN.json",
        hostPath: planPath,
      });
  }
  return out;
}


export interface V2InfrastructureRetryState {
  count: number;
  ruleOrPart: string;
  message: string;
  updatedAt: string;
}

const INFRA_RETRY_FILENAME = "INFRA_RETRY.json";

export function recordV2InfrastructureRetry(
  workRoot: string,
  ruleOrPart: string,
  message: string,
): V2InfrastructureRetryState {
  fs.mkdirSync(workRoot, { recursive: true });
  const target = path.join(workRoot, INFRA_RETRY_FILENAME);
  let previous: V2InfrastructureRetryState | null = null;
  try {
    if (fs.existsSync(target))
      previous = JSON.parse(fs.readFileSync(target, "utf8")) as V2InfrastructureRetryState;
  } catch {
    previous = null;
  }
  const next: V2InfrastructureRetryState = {
    count: Math.max(0, Number(previous?.count ?? 0)) + 1,
    ruleOrPart,
    message,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function readV2InfrastructureRetry(
  workRoot: string,
): V2InfrastructureRetryState | null {
  const target = path.join(workRoot, INFRA_RETRY_FILENAME);
  try {
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as V2InfrastructureRetryState;
    if (!Number.isFinite(parsed.count) || parsed.count < 1 || !parsed.ruleOrPart)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasV2InfrastructureRetryPending(workRoot: string): boolean {
  return readV2InfrastructureRetry(workRoot) !== null;
}

export function clearV2InfrastructureRetry(workRoot: string): void {
  fs.rmSync(path.join(workRoot, INFRA_RETRY_FILENAME), { force: true });
}
