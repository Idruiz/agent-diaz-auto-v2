import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

const requiredSource = [
  'mountBucket("JEFE_FS", PERSIST_PATH',
  'prefix: `/jobs/${jobId}/`',
  'containerFetch(forwardedRequest(request, "/mcp"), PLAYWRIGHT_PORT)',
  'containerFetch(forwardedRequest(request, "/mcp"), PUPPETEER_PORT)',
  'playwright-mcp --headless',
  'mcp-proxy --server stream',
  'chrome-devtools-mcp --headless',
  'jefe-posix-',
];
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

if (!wrangler.includes('"binding": "JEFE_FS"')) throw new Error("R2 binding missing");
if (!wrangler.includes('"bucket_name": "jefe-auto-fs"')) throw new Error("R2 bucket missing");
if (/trycloudflare|quick.?tunnel/i.test(source + dockerfile))
  throw new Error("Public quick tunnels are forbidden for browser MCP transport");
console.log("Cloudflare real-filesystem contract passed");
