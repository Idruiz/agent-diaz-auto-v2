import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";

interface ExecutionState { active: boolean; crashes: number; startedAt: number }
const statePath = (root: string) => path.join(root, "EXECUTION_STATE.json");
function readState(root: string): ExecutionState | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
    if (typeof state.active !== "boolean" || !Number.isSafeInteger(state.crashes) || state.crashes < 0)
      throw new Error("Invalid execution state");
    return state;
  } catch (error: any) {
    if (error.code !== "ENOENT") log("error", "agent_v2.recovery_state_invalid", { error: error.message });
    return null;
  }
}
function writeState(root: string, state: ExecutionState) {
  fs.mkdirSync(root, { recursive: true });
  const temp = `${statePath(root)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, statePath(root));
}
/** Only unexpected process deaths increment this counter, never artifact validation retries. */
export function beginArtifactExecution(root: string) {
  const previous = readState(root);
  writeState(root, { active: true, crashes: (previous?.crashes ?? 0) + (previous?.active ? 1 : 0), startedAt: Date.now() });
}
export function finishArtifactExecution(root: string) {
  // Successful artifact persistence removes the work root; don't recreate it.
  if (fs.existsSync(statePath(root))) writeState(root, { active: false, crashes: 0, startedAt: 0 });
}
export function artifactRecoveryDelay(root: string): number {
  const state = readState(root);
  return Math.min(300_000, 60_000 * 2 ** Math.min(3, state?.active ? state.crashes : 0));
}
