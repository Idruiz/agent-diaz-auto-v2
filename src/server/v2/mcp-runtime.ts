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

export type BrowserAutonomyMode = "both" | "playwright" | "puppeteer" | "off";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\"'\\"'`)}'`;
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
  if (rawMode === "both" || rawMode === "playwright")
    definitions.push({
      transport: "stdio",
      name: "Playwright Browser",
      fullCommand: `npx --no-install @playwright/mcp --headless --isolated --no-sandbox --executable-path ${shellQuote(executable)}`,
    });
  if (rawMode === "both" || rawMode === "puppeteer")
    definitions.push({
      transport: "stdio",
      name: "Puppeteer DevTools",
      fullCommand: `npx --no-install chrome-devtools-mcp --headless --isolated --executablePath ${shellQuote(executable)} --chromeArg=--no-sandbox --chromeArg=--disable-dev-shm-usage --no-usage-statistics`,
    });
  return definitions;
}

export interface V2McpRuntime {
  servers: V2McpServer[];
  descriptions: Array<{
    name: string;
    transport: "http" | "stdio";
  }>;
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
        ...(toolFilter ? { toolFilter } : {}),
      }),
    );
    descriptions.push({ name: definition.name, transport: "stdio" });
  }

  return { servers, descriptions };
}

export async function connectV2McpServers(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const connected: V2McpServer[] = [];
  try {
    for (const server of runtime.servers) {
      await server.connect();
      connected.push(server);
    }
  } catch (error) {
    for (const server of connected.reverse()) {
      try {
        await server.close();
      } catch {
        // Preserve the original connection failure.
      }
    }
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
}
