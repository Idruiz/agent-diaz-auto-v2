import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPServerStdio } from "@openai/agents";
import { builtInBrowserMcpProcessSpec } from "./mcp-runtime.js";

const endpoint = "http://127.0.0.1:9222";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-mcp-smoke-"));
const chromium = spawn(
  process.env.AGENT_BROWSER_EXECUTABLE_PATH || "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--single-process",
    "--no-zygote",
    "--renderer-process-limit=1",
    "--disable-extensions",
    "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore", env: process.env },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBrowser(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (chromium.exitCode !== null)
      throw new Error(`Chromium exited before MCP smoke (${chromium.exitCode})`);
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
    } catch {
      // Normal while Chromium is starting.
    }
    await sleep(100);
  }
  throw new Error("Chromium CDP endpoint did not become ready for MCP smoke");
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  AGENT_SANDBOX_PROVIDER: "render",
  AGENT_BROWSER_AUTONOMY: "both",
  AGENT_BROWSER_EXECUTABLE_PATH:
    process.env.AGENT_BROWSER_EXECUTABLE_PATH || "/usr/bin/chromium",
};

const servers: MCPServerStdio[] = [];
try {
  await waitForBrowser();
  for (const name of ["Playwright Browser", "Puppeteer DevTools"]) {
    const spec = builtInBrowserMcpProcessSpec(name, env);
    if (!spec) throw new Error(`Missing process spec for ${name}`);
    const server = new MCPServerStdio({
      name,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cacheToolsList: true,
      timeout: 30_000,
      clientSessionTimeoutSeconds: 10,
    });
    await server.connect();
    servers.push(server);
    const tools = await server.listTools();
    if (tools.length === 0) throw new Error(`${name} returned no tools`);
    console.log(`${name} MCP smoke passed (${tools.length} tools)`);
  }
} finally {
  for (const server of servers.reverse()) {
    try {
      await server.close();
    } catch {
      // Preserve primary smoke failure.
    }
  }
  if (chromium.exitCode === null) {
    chromium.kill("SIGTERM");
    await sleep(250);
    if (chromium.exitCode === null) chromium.kill("SIGKILL");
  }
  fs.rmSync(profile, { recursive: true, force: true });
}
