import { createHash } from "node:crypto";
import { UnixLocalSandboxClient, UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import { log } from "../log.js";
import { processHealth } from "./process-health.js";

class RenderSandboxSession extends UnixLocalSandboxSession {
  protected override async spawnShellCommand(command: string, args: {
    cwd: string; logicalCwd: string; shell?: string; login: boolean; runAs?: string; tty?: boolean;
  }) {
    // Inherit the kill preference into every shell descendant. A memory-hungry
    // command should be killed ahead of the HTTP server, not take the site down.
    const prelude = process.platform === "linux"
      ? "printf '1000' > /proc/self/oom_score_adj || { echo 'Cannot set shell OOM priority' >&2; exit 125; }; "
      : "";
    log("info", "agent_v2.shell_started", {
      commandSha: createHash("sha256").update(command).digest("hex"),
      operations: [...new Set(command.match(/\b(?:node|python3?|npm|npx|pip3?|curl|wget|chromium|pkill|killall|kill|ffmpeg|convert|pdftoppm|libreoffice)\b/g) ?? [])],
      ...processHealth(),
    });
    const child = await super.spawnShellCommand(prelude + command, args);
    child.once("exit", (code, signal) => log(code || signal ? "warn" : "info", "agent_v2.shell_exited", {
      childPid: child.pid, code, signal, ...processHealth(),
    }));
    return child;
  }
}

export class RenderSandboxClient extends UnixLocalSandboxClient {
  override async create(...args: Parameters<UnixLocalSandboxClient["create"]>) {
    const session = await super.create(...args);
    return new RenderSandboxSession({ state: session.state });
  }
}
