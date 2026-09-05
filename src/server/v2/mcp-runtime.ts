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

const BUILTIN_BROWSER_MCP_NAMES = new Set([
  "Playwright Browser",
  "Puppeteer DevTools",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function builtInBrowserDefinitions(
  env: NodeJS.ProcessEnv = process.env,
): V2McpDefinitions {
  const rawMode =
    env.AGENT_BROWSER_AUTONOMY?.trim().toLocaleLowerCase() ||
    (env.NODE_ENV === "test" ? "off" : "both");
  if (["off", "none", "false", "0"].includes(rawMode)) return [];
  if (!["both", "playwright", "puppeteer"].includes(rawMode))
    throw new Error(
      "AGENT_BROWSER_AUTONOMY must be both, playwright, puppeteer, or off",
    );
  const executable =
    env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";
  const definitions: V2McpDefinitions = [];
  if (rawMode === "both" || rawMode === "playwright")
    definitions.push({
      transport: "stdio",
      name: "Playwright Browser",
      fullCommand: `npx --no-install @playwright/mcp --headless --isolated --executable-path ${shellQuote(executable)}`,
    });
  if (rawMode === "both" || rawMode === "puppeteer")
    definitions.push({
      transport: "stdio",
      name: "Puppeteer DevTools",
      fullCommand: `npx --no-install chrome-devtools-mcp --headless --isolated --executable-path ${shellQuote(executable)} --no-usage-statistics`,
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

function uniqueDefinitions(definitions: V2McpDefinitions): V2McpDefinitions {
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    const key = definition.name.trim().toLocaleLowerCase();
    if (seen.has(key))
      throw new Error(`Duplicate MCP server name '${definition.name}'`);
    seen.add(key);
    return true;
  });
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
  return uniqueDefinitions(
    McpDefinitionsSchema.parse([
      ...result.data,
      ...builtInBrowserDefinitions(env),
    ]),
  );
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
): V2McpRuntime {
  const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON, env);

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

  assertV2McpEnvironmentSafe(definitions, env);

  const servers: V2McpServer[] = [];
  const descriptions: V2McpRuntime["descriptions"] = [];
  for (const definition of definitions) {
    const toolFilter = toolFilterFor(definition);
    if (definition.transport === "http") {
      const authorization = definition.authorizationEnv
        ? env[definition.authorizationEnv]
        : config.MCP_SERVER_URL === definition.url
          ? config.MCP_AUTHORIZATION
          : undefined;
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
