import fs from "node:fs";
import { log } from "../log.js";

function read(name: string): string | null {
  try { return fs.readFileSync(name, "utf8").trim(); } catch { return null; }
}

/** Numeric process diagnostics only: never command lines, environment or user content. */
export function processHealth() {
  const numeric = (file: string) => {
    const value = read(file);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const events = Object.fromEntries((read("/sys/fs/cgroup/memory.events") ?? "")
    .split("\n").map(line => line.split(/\s+/)).filter(parts => parts.length === 2)
    .map(([key, value]) => [key!, Number(value)]));
  return { pid: process.pid, uptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    cgroupBytes: numeric("/sys/fs/cgroup/memory.current"),
    cgroupLimitBytes: numeric("/sys/fs/cgroup/memory.max"), memoryEvents: events };
}

export function installProcessDiagnostics() {
  log("info", "server.process_health", processHealth());
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    log("error", "server.uncaught_exception", { origin, error: error.message, ...processHealth() });
  });
  process.on("exit", code => log(code ? "error" : "info", "server.process_exit", { code, ...processHealth() }));
}
