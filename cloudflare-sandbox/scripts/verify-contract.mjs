import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

const requiredSource = [
  'JEFE_FS.get(key)',
  'JEFE_FS.put(persistArchiveKey(jobId)',
  'new FixedLengthStream(bytes)',
  'source.pipeTo(fixed.writable)',
  'pool.lookupContainer(sandboxId)',
  'pool.getContainer(sandboxId)',
  'getSandbox(env.Sandbox, containerUUID',
  'containerFetch(forwardedRequest(request, "/mcp"), PLAYWRIGHT_PORT)',
  'containerFetch(forwardedRequest(request, "/mcp"), PUPPETEER_PORT)',
  'playwright-mcp --headless',
  'mcp-proxy --server stream',
  'chrome-devtools-mcp --headless',
  'url.pathname === "/jefe/release"',
  'keepAliveManaged: false',
]
for (const token of requiredSource)
  if (!source.includes(token)) throw new Error(`Missing Cloudflare contract: ${token}`);

for (const token of [
  'chromium',
  '@playwright/mcp@0.0.80',
  'chrome-devtools-mcp@1.8.0',
  'puppeteer@25.10.0',
  'mcp-proxy@6.7.13',
])
  if (!dockerfile.includes(token)) throw new Error(`Missing browser image contract: ${token}`);

if (source.includes("getSandbox(env.Sandbox, sandboxId"))
  throw new Error("JEFE routes must resolve the pool-assigned container UUID, never sandboxId directly");
if (/setKeepAlive\(true\)/.test(source))
  throw new Error("JEFE setup must not pin containers with keepAlive");
if (source.includes("JEFE_FS.put(persistArchiveKey(jobId), stream"))
  throw new Error("R2 checkpoints must use a known-length stream");
if (!wrangler.includes('"class_name": "SandboxV4"')) throw new Error("Fresh SandboxV4 container namespace missing");
if (!wrangler.includes('"class_name": "WarmPoolV4"')) throw new Error("Fresh WarmPoolV4 namespace missing");
if (!wrangler.includes('"max_instances": 4')) throw new Error("Container max_instances must be 4");
if (!wrangler.includes('"binding": "JEFE_FS"')) throw new Error("R2 binding missing");
if (!wrangler.includes('"bucket_name": "jefe-auto-fs"')) throw new Error("R2 bucket missing");
if (/trycloudflare|quick.?tunnel/i.test(source + dockerfile))
  throw new Error("Public quick tunnels are forbidden for browser MCP transport");
console.log("Cloudflare single-container, checkpointed-filesystem lifecycle contract passed");
