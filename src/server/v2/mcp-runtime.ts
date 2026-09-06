import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCPServerStdio,
  MCPServerStreamableHttp,
} from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config.js";
import { log } from "../log.js";

const ToolNameListSchema = z.array(z.string().min(1).max(128)).max(100).optional();

const HttpMcpSchema = z.object({
  transport: z.literal("http"),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  authorizationEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  allowedTools: ToolNameListSchema,
  blockedTools: ToolNameListSchema,
});

const StdioMcpSchema = z.object({
  transport: z.literal("stdio"),
  name: z.string().min(1).max(80),
  fullCommand: z.string().min(1).max(2_000),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  allowedTools: ToolNameListSchema,
  blockedTools: ToolNameListSchema,
});

const McpDefinitionSchema = z.discriminatedUnion("transport", [
  HttpMcpSchema,
  StdioMcpSchema,
]);

const McpDefinitionsSchema = z.array(McpDefinitionSchema).max(12);
export type V2McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type V2McpDefinitions = z.infer<typeof McpDefinitionsSchema>;
export type V2McpServer = MCPServerStreamableHttp | MCPServerStdio;
export type V2InternalMcpDefinition = V2McpDefinition & {
  authorization?: string;
};

const BUILTIN_BROWSER_MCP_NAMES = new Set([
  "Playwright Browser",
  "Puppeteer DevTools",
]);
const DEFAULT_STDIO_TOOL_TIMEOUT_MS = 90_000;
const SHARED_BROWSER_ENDPOINT = "http://127.0.0.1:9222";
const SHARED_BROWSER_START_TIMEOUT_MS = 15_000;
const BROWSER_MCP_NODE_HEAP_MB = 96;

export type BrowserAutonomyMode = "both" | "playwright" | "puppeteer" | "off";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\"'\\"'`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localMcpCommand(binary: string, args: string): string {
  const executable = path.resolve(process.cwd(), "node_modules", ".bin", binary);
  // MCPServerStdio parses fullCommand into an executable + argv; a leading
  // VAR=value token is therefore treated as the executable and fails ENOENT.
  // Use /usr/bin/env so NODE_OPTIONS is applied without requiring a shell.
  return `/usr/bin/env NODE_OPTIONS=${shellQuote(`--max-old-space-size=${BROWSER_MCP_NODE_HEAP_MB}`)} ${shellQuote(executable)} ${args}`;
}

export function browserAutonomyMode(
  env: NodeJS.ProcessEnv = process.env,
): BrowserAutonomyMode {
  const rawMode =
    env.AGENT_BROWSER_AUTONOMY?.trim().toLocaleLowerCase() ||
    (env.NODE_ENV === "test" ? "off" : "both");
  if (["off", "none", "false", "0"].includes(rawMode)) return "off";
  if (rawMode === "both" || rawMode === "playwright" || rawMode === "puppeteer")
    return rawMode;
  throw new Error(
    "AGENT_BROWSER_AUTONOMY must be both, playwright, puppeteer, or off",
  );
}

function cloudflareExecutionPlane(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.AGENT_SANDBOX_PROVIDER?.trim().toLocaleLowerCase();
  if (explicit) return explicit === "cloudflare";
  return Boolean(env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim());
}

function builtInHostBrowserDefinitions(
  env: NodeJS.ProcessEnv = process.env,
): V2McpDefinitions {
  // Cloudflare production browser tools are started inside the sandbox and
  // injected later as authenticated Streamable HTTP MCP servers. Never spawn
  // a second browser on the Render host in that mode.
  if (cloudflareExecutionPlane(env)) return [];

  const rawMode = browserAutonomyMode(env);
  if (rawMode === "off") return [];
  const executable =
    env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";
  const definitions: V2McpDefinitions = [];

  // On constrained Render instances, launching one Chromium per browser MCP
  // is enough to exceed the 512 MB service limit. In "both" mode JEFE starts
  // one host Chromium and both reviewed MCPs attach to that same CDP endpoint.
  // Invoke the locally installed binaries directly so npx/npm wrapper Node
  // processes do not remain resident beside both MCP servers.
  if (rawMode === "both") {
    definitions.push({
      transport: "stdio",
      name: "Playwright Browser",
      fullCommand: localMcpCommand(
        "playwright-mcp",
        `--cdp-endpoint=${shellQuote(SHARED_BROWSER_ENDPOINT)}`,
      ),
      timeoutMs: DEFAULT_STDIO_TOOL_TIMEOUT_MS,
    });
    definitions.push({
      transport: "stdio",
      name: "Puppeteer DevTools",
      fullCommand: localMcpCommand(
        "chrome-devtools-mcp",
        `--browser-url=${shellQuote(SHARED_BROWSER_ENDPOINT)} --no-usage-statistics`,
      ),
      timeoutMs: DEFAULT_STDIO_TOOL_TIMEOUT_MS,
    });
    return definitions;
  }

  if (rawMode === "playwright")
    definitions.push({
      transport: "stdio",
      name: "Playwright Browser",
      fullCommand: localMcpCommand(
        "playwright-mcp",
        `--headless --isolated --no-sandbox --executable-path ${shellQuote(executable)}`,
      ),
      timeoutMs: DEFAULT_STDIO_TOOL_TIMEOUT_MS,
    });
  if (rawMode === "puppeteer")
    definitions.push({
      transport: "stdio",
      name: "Puppeteer DevTools",
      fullCommand: localMcpCommand(
        "chrome-devtools-mcp",
        `--headless --isolated --executablePath ${shellQuote(executable)} --chromeArg=--no-sandbox --chromeArg=--disable-dev-shm-usage --no-usage-statistics`,
      ),
      timeoutMs: DEFAULT_STDIO_TOOL_TIMEOUT_MS,
    });
  return definitions;
}

interface SharedBrowserRuntime {
  endpoint: string;
  executable: string;
  process?: ReturnType<typeof spawn>;
  userDataDir?: string;
}

export interface V2McpRuntime {
  servers: V2McpServer[];
  descriptions: Array<{
    name: string;
    transport: "http" | "stdio";
  }>;
  sharedBrowser?: SharedBrowserRuntime;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function assertUniqueDefinitions(
  definitions: readonly { name: string }[],
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const key = definition.name.trim().toLocaleLowerCase();
    if (seen.has(key))
      throw new Error(`Duplicate MCP server name '${definition.name}'`);
    seen.add(key);
  }
}

export function parseV2McpDefinitions(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): V2McpDefinitions {
  let parsed: unknown = [];
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `MCP_SERVERS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const result = McpDefinitionsSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `MCP_SERVERS_JSON failed validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );

  // Reserved names identify audited first-party browser processes. Do not let
  // user JSON borrow one of those names and accidentally inherit its trust.
  for (const definition of result.data)
    if (BUILTIN_BROWSER_MCP_NAMES.has(definition.name))
      throw new Error(
        `MCP server name '${definition.name}' is reserved for JEFE//AUTO built-in browser tooling`,
      );

  const definitions = [
    ...result.data,
    ...builtInHostBrowserDefinitions(env),
  ];
  assertUniqueDefinitions(definitions);
  return definitions;
}

export function assertV2McpEnvironmentSafe(
  definitions: V2McpDefinitions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const unreviewedStdio = definitions.filter(
    (definition) =>
      definition.transport === "stdio" &&
      !BUILTIN_BROWSER_MCP_NAMES.has(definition.name),
  );
  if (
    env.NODE_ENV === "production" &&
    unreviewedStdio.length > 0 &&
    !enabled(env.AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION)
  )
    throw new Error(
      "JEFE//AUTO refuses unreviewed host-level stdio MCP processes in production. Built-in pinned browser MCPs are allowed; custom stdio MCPs require AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true after review.",
    );
}

function toolFilterFor(definition: V2McpDefinition) {
  const allowed = new Set(definition.allowedTools ?? []);
  const blocked = new Set(definition.blockedTools ?? []);
  if (!allowed.size && !blocked.size) return undefined;
  return async (_context: any, tool: any) => {
    const name = String(tool?.name ?? "");
    return (!allowed.size || allowed.has(name)) && !blocked.has(name);
  };
}

export function createV2McpRuntime(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  options: { internalDefinitions?: V2InternalMcpDefinition[] } = {},
): V2McpRuntime {
  const definitions: V2InternalMcpDefinition[] = [
    ...parseV2McpDefinitions(env.MCP_SERVERS_JSON, env),
    ...(options.internalDefinitions ?? []),
  ];

  if (config.MCP_SERVER_URL) {
    const fallbackName = config.MCP_SERVER_LABEL || "Agent Diaz MCP";
    if (
      !definitions.some(
        (definition) =>
          definition.name.trim().toLocaleLowerCase() ===
          fallbackName.trim().toLocaleLowerCase(),
      )
    )
      definitions.push({
        transport: "http",
        name: fallbackName,
        url: config.MCP_SERVER_URL,
        timeoutMs: 60_000,
      });
  }

  assertUniqueDefinitions(definitions);
  assertV2McpEnvironmentSafe(definitions, env);

  const usesSharedBrowser =
    !cloudflareExecutionPlane(env) &&
    browserAutonomyMode(env) === "both" &&
    definitions.some((item) => item.name === "Playwright Browser") &&
    definitions.some((item) => item.name === "Puppeteer DevTools");

  const sharedBrowser: SharedBrowserRuntime | undefined = usesSharedBrowser
    ? {
        endpoint: SHARED_BROWSER_ENDPOINT,
        executable:
          env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium",
      }
    : undefined;

  const servers: V2McpServer[] = [];
  const descriptions: V2McpRuntime["descriptions"] = [];
  for (const definition of definitions) {
    const toolFilter = toolFilterFor(definition);
    if (definition.transport === "http") {
      const authorization =
        definition.authorization ??
        (definition.authorizationEnv
          ? env[definition.authorizationEnv]
          : config.MCP_SERVER_URL === definition.url
            ? config.MCP_AUTHORIZATION
            : undefined);
      if (definition.authorizationEnv && !authorization)
        throw new Error(
          `MCP server '${definition.name}' requires environment variable ${definition.authorizationEnv}`,
        );
      servers.push(
        new MCPServerStreamableHttp({
          url: definition.url,
          name: definition.name,
          cacheToolsList: true,
          timeout: definition.timeoutMs,
          useStructuredContent: true,
          ...(toolFilter ? { toolFilter } : {}),
          ...(authorization
            ? { requestInit: { headers: { Authorization: authorization } } }
            : {}),
        }),
      );
      descriptions.push({ name: definition.name, transport: "http" });
      continue;
    }

    servers.push(
      new MCPServerStdio({
        name: definition.name,
        fullCommand: definition.fullCommand,
        cacheToolsList: true,
        useStructuredContent: true,
        timeout: definition.timeoutMs ?? DEFAULT_STDIO_TOOL_TIMEOUT_MS,
        clientSessionTimeoutSeconds: 10,
        ...(toolFilter ? { toolFilter } : {}),
      }),
    );
    descriptions.push({ name: definition.name, transport: "stdio" });
  }

  return {
    servers,
    descriptions,
    ...(sharedBrowser ? { sharedBrowser } : {}),
  };
}

async function waitForSharedBrowser(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const sharedBrowser = runtime.sharedBrowser;
  if (!sharedBrowser?.process) return;
  const startedAt = Date.now();
  const versionUrl = `${sharedBrowser.endpoint}/json/version`;
  for (;;) {
    if (sharedBrowser.process.exitCode !== null)
      throw new Error(
        `Shared Chromium exited before CDP became ready (exit ${sharedBrowser.process.exitCode})`,
      );
    try {
      const response = await fetch(versionUrl, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        log("info", "agent_v2.shared_browser_ready", {
          jobId,
          endpoint: sharedBrowser.endpoint,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
    } catch {
      // Browser startup races are expected for a few hundred milliseconds.
    }
    if (Date.now() - startedAt >= SHARED_BROWSER_START_TIMEOUT_MS)
      throw new Error(
        `Shared Chromium did not expose CDP within ${SHARED_BROWSER_START_TIMEOUT_MS}ms`,
      );
    await sleep(100);
  }
}

async function startSharedBrowser(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const sharedBrowser = runtime.sharedBrowser;
  if (!sharedBrowser || sharedBrowser.process) return;
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "diaz-shared-chromium-"),
  );
  const child = spawn(
    sharedBrowser.executable,
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
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {
      stdio: "ignore",
      env: process.env,
    },
  );
  sharedBrowser.process = child;
  sharedBrowser.userDataDir = userDataDir;
  log("info", "agent_v2.shared_browser_started", {
    jobId,
    executable: sharedBrowser.executable,
    endpoint: sharedBrowser.endpoint,
    memoryMode: "constrained",
  });
  try {
    await waitForSharedBrowser(runtime, jobId);
  } catch (error) {
    await stopSharedBrowser(runtime, jobId);
    throw error;
  }
}

async function stopSharedBrowser(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const sharedBrowser = runtime.sharedBrowser;
  if (!sharedBrowser) return;
  const child = sharedBrowser.process;
  const userDataDir = sharedBrowser.userDataDir;
  sharedBrowser.process = undefined;
  sharedBrowser.userDataDir = undefined;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Temp browser profiles are best-effort cleanup only.
    }
  }
  log("info", "agent_v2.shared_browser_stopped", { jobId });
}

export async function connectV2McpServers(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const connected: V2McpServer[] = [];
  try {
    await startSharedBrowser(runtime, jobId);
    for (const server of runtime.servers) {
      const startedAt = Date.now();
      log("info", "agent_v2.mcp_server_connecting", {
        jobId,
        server: server.name,
      });
      await server.connect();
      connected.push(server);
      log("info", "agent_v2.mcp_server_connected", {
        jobId,
        server: server.name,
        elapsedMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    for (const server of connected.reverse()) {
      try {
        await server.close();
      } catch {
        // Preserve the original connection failure.
      }
    }
    await stopSharedBrowser(runtime, jobId);
    log("error", "agent_v2.mcp_connect_failed", {
      jobId,
      configured: runtime.descriptions,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function closeV2McpServers(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  for (const server of [...runtime.servers].reverse()) {
    try {
      await server.close();
    } catch (error) {
      log("warn", "agent_v2.mcp_close_failed", {
        jobId,
        server: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await stopSharedBrowser(runtime, jobId);
}