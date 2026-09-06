import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const requireGlobal = createRequire("/usr/local/lib/node_modules/puppeteer/package.json");
const puppeteer = requireGlobal("puppeteer");
const processes = [];
const clients = [];
const logs = new Map();
let browser;
const pageServer = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<title>JEFE shared workspace</title><h1>Browser proof</h1>");
});
const deadline = setTimeout(() => {
  console.error("Cloudflare browser smoke exceeded 120 seconds");
  for (const child of processes) child.kill("SIGKILL");
  process.exit(1);
}, 120_000);

function start(name, command, args) {
  const child = spawn(command, args, { cwd: "/workspace", stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  logs.set(name, "");
  const capture = chunk => logs.set(name, (logs.get(name) + chunk.toString()).slice(-8000));
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", error => capture(error.message));
  return child;
}

async function connect(name, port, child) {
  // Match the Host forwarded by the real Worker, including its DNS protection.
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${logs.get(name)}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const client = new Client({ name: "jefe-browser-proof", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Host: "sandbox.internal" } },
  }));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result;
}

try {
  await fs.mkdir("/workspace/browser-proof", { recursive: true });
  const marker = "/workspace/browser-proof/shared.txt";
  await fs.writeFile(marker, "same-filesystem");
  await new Promise(resolve => pageServer.listen(8940, "127.0.0.1", resolve));
  const playwright = start("playwright", "playwright-mcp", [
    "--headless", "--isolated", "--no-sandbox", "--host", "0.0.0.0", "--port", "8931",
    "--executable-path", "/usr/bin/chromium", "--output-dir", "/workspace/browser-proof",
  ]);
  const devtools = start("devtools", "mcp-proxy", [
    "--server", "stream", "--port", "8932", "--shell", "--", "chrome-devtools-mcp",
    "--headless", "--isolated", "--executablePath", "/usr/bin/chromium",
    "--chromeArg=--no-sandbox", "--chromeArg=--disable-dev-shm-usage",
    "--allowUnrestrictedPaths", "--no-usage-statistics",
  ]);
  const pw = await connect("playwright", 8931, playwright);
  const dt = await connect("devtools", 8932, devtools);
  await call(pw, "browser_navigate", { url: "http://127.0.0.1:8940" });
  const snapshot = await call(pw, "browser_snapshot", {});
  assert.match(JSON.stringify(snapshot), /JEFE shared workspace/);
  await call(pw, "browser_take_screenshot", { type: "png", filename: "playwright.png" });
  await call(dt, "new_page", { url: "http://127.0.0.1:8940" });
  const evaluation = await call(dt, "evaluate_script", { function: "() => document.title" });
  assert.match(JSON.stringify(evaluation), /JEFE shared workspace/);
  await call(dt, "take_screenshot", { format: "png", filePath: "/workspace/browser-proof/devtools.png" });
  browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.goto("file://" + marker);
  assert.match(await page.content(), /same-filesystem/);
  for (const filename of ["playwright.png", "devtools.png"])
    assert.ok((await fs.stat("/workspace/browser-proof/" + filename)).size > 100);
  console.log("Cloudflare image proof passed: both HTTP MCPs executed browser actions, both screenshots read through shell filesystem, direct Puppeteer read shell-written file.");
} catch (error) {
  console.error(error);
  for (const [name, output] of logs) console.error(`${name}: ${output}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const client of clients.reverse()) await client.close().catch(() => {});
  for (const child of processes) child.kill("SIGTERM");
  pageServer.close();
  clearTimeout(deadline);
}
