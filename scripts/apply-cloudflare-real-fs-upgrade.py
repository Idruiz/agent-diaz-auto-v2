from pathlib import Path

ROOT = Path('.')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


mcp_runtime = r'''import {
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
'''
write('src/server/v2/mcp-runtime.ts', mcp_runtime)

cloudflare_workspace = r'''import { z } from "zod";
import {
  browserAutonomyMode,
  type V2InternalMcpDefinition,
} from "./mcp-runtime.js";

const SetupResponseSchema = z.object({
  ok: z.literal(true),
  sandboxId: z.string().min(1),
  workspaceRoot: z.literal("/workspace"),
  persistentPath: z.literal("/workspace/persist"),
  filesystem: z.object({
    kind: z.literal("linux-r2-mounted"),
    posix: z.literal(true),
    persistent: z.literal(true),
  }),
  browsers: z.object({
    playwright: z.boolean(),
    puppeteer: z.boolean(),
  }),
});

export interface CloudflareWorkspacePreparation {
  persistentPath: "/workspace/persist";
  mcpDefinitions: V2InternalMcpDefinition[];
  filesystem: {
    kind: "linux-r2-mounted";
    posix: true;
    persistent: true;
  };
}

function workerUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("Cloudflare sandbox Worker URL must use HTTPS");
  return url;
}

function proxiedMcpUrl(
  worker: URL,
  sandboxId: string,
  browser: "playwright" | "puppeteer",
): string {
  const url = new URL(worker);
  url.pathname = `/jefe/mcp/${encodeURIComponent(sandboxId)}/${browser}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function cloudflareSandboxIdFromSession(session: unknown): string {
  const value = (session as { state?: { sandboxId?: unknown } } | null)?.state
    ?.sandboxId;
  if (typeof value !== "string" || !value.trim())
    throw new Error("Cloudflare sandbox session did not expose a sandboxId");
  return value.trim();
}

export async function prepareCloudflareWorkspace(args: {
  jobId: string;
  sandboxId: string;
  workerUrl: string;
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<CloudflareWorkspacePreparation> {
  const worker = workerUrl(args.workerUrl);
  const apiKey = args.apiKey.trim();
  if (!apiKey)
    throw new Error(
      "CLOUDFLARE_SANDBOX_API_KEY is required for the authenticated JEFE//AUTO workspace bridge",
    );
  const mode = browserAutonomyMode(args.env ?? process.env);
  const endpoint = new URL("/jefe/setup", worker);
  const response = await (args.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jobId: args.jobId,
      sandboxId: args.sandboxId,
      browserMode: mode,
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 800);
    throw new Error(
      `Cloudflare JEFE workspace setup failed (${response.status}): ${body || response.statusText}`,
    );
  }
  const parsed = SetupResponseSchema.parse(await response.json());
  if (parsed.sandboxId !== args.sandboxId)
    throw new Error("Cloudflare workspace setup returned the wrong sandboxId");

  const authorization = `Bearer ${apiKey}`;
  const mcpDefinitions: V2InternalMcpDefinition[] = [];
  if (mode === "both" || mode === "playwright") {
    if (!parsed.browsers.playwright)
      throw new Error("Cloudflare workspace did not start Playwright MCP");
    mcpDefinitions.push({
      transport: "http",
      name: "Playwright Browser",
      url: proxiedMcpUrl(worker, args.sandboxId, "playwright"),
      authorization,
      timeoutMs: 120_000,
    });
  }
  if (mode === "both" || mode === "puppeteer") {
    if (!parsed.browsers.puppeteer)
      throw new Error("Cloudflare workspace did not start Puppeteer DevTools MCP");
    mcpDefinitions.push({
      transport: "http",
      name: "Puppeteer DevTools",
      url: proxiedMcpUrl(worker, args.sandboxId, "puppeteer"),
      authorization,
      timeoutMs: 120_000,
    });
  }

  return {
    persistentPath: parsed.persistentPath,
    mcpDefinitions,
    filesystem: parsed.filesystem,
  };
}
'''
write('src/server/v2/cloudflare-workspace.ts', cloudflare_workspace)

sandbox_runtime = r'''import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from "@openai/agents/sandbox/local";
import { log } from "../log.js";

export type V2SandboxProvider = "cloudflare" | "docker" | "unix";

export type V2SandboxClient =
  | CloudflareSandboxClient
  | DockerSandboxClient
  | UnixLocalSandboxClient;

export interface V2SandboxRuntime {
  provider: V2SandboxProvider;
  client: V2SandboxClient;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function resolveV2SandboxProvider(
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxProvider {
  const explicit = env.AGENT_SANDBOX_PROVIDER?.trim().toLocaleLowerCase();
  if (explicit) {
    if (explicit === "cloudflare" || explicit === "docker" || explicit === "unix")
      return explicit;
    throw new Error(
      `AGENT_SANDBOX_PROVIDER must be cloudflare, docker, or unix; received '${env.AGENT_SANDBOX_PROVIDER}'`,
    );
  }
  if (env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim()) return "cloudflare";
  return "unix";
}

export function assertV2SandboxProviderReady(
  provider: V2SandboxProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider === "cloudflare" && !env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim())
    throw new Error(
      "AGENT_SANDBOX_PROVIDER=cloudflare requires CLOUDFLARE_SANDBOX_WORKER_URL",
    );
  if (
    provider === "cloudflare" &&
    env.NODE_ENV === "production" &&
    !env.CLOUDFLARE_SANDBOX_API_KEY?.trim()
  )
    throw new Error(
      "JEFE//AUTO production Cloudflare sandbox requires CLOUDFLARE_SANDBOX_API_KEY so workspace and browser MCP proxy routes are authenticated",
    );
  if (
    provider === "unix" &&
    env.NODE_ENV === "production" &&
    !enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX)
  )
    throw new Error(
      "Agent Díaz V2 refuses Unix-local shell execution in production. Configure CLOUDFLARE_SANDBOX_WORKER_URL, select AGENT_SANDBOX_PROVIDER=docker, or explicitly set AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true for an emergency override.",
    );
}

export function createV2SandboxRuntime(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxRuntime {
  const provider = resolveV2SandboxProvider(env);
  assertV2SandboxProviderReady(provider, env);

  if (provider === "cloudflare") {
    const workerUrl = env.CLOUDFLARE_SANDBOX_WORKER_URL!.trim();
    const client = new CloudflareSandboxClient({
      workerUrl,
      ...(env.CLOUDFLARE_SANDBOX_API_KEY
        ? { apiKey: env.CLOUDFLARE_SANDBOX_API_KEY }
        : {}),
      timeoutMs: 120_000,
      createTimeoutMs: 120_000,
      requestTimeoutMs: 120_000,
      archiveLimits: {},
    });
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: true,
      persistentFilesystem: "/workspace/persist",
    });
    return { provider, client };
  }

  if (provider === "docker") {
    const image =
      env.AGENT_SANDBOX_DOCKER_IMAGE?.trim() || "node:22-bookworm-slim";
    const client = new DockerSandboxClient({ image });
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: false,
      image,
    });
    return { provider, client };
  }

  log(
    env.NODE_ENV === "production" ? "warn" : "info",
    "agent_v2.sandbox_selected",
    {
      jobId,
      provider,
      hosted: false,
      unsafeProductionOverride:
        env.NODE_ENV === "production" &&
        enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX),
    },
  );
  return { provider, client: new UnixLocalSandboxClient() };
}
'''
write('src/server/v2/sandbox-runtime.ts', sandbox_runtime)

runtime_readiness = r'''import {
  assertV2McpEnvironmentSafe,
  parseV2McpDefinitions,
} from "./mcp-runtime.js";
import {
  assertV2SandboxProviderReady,
  resolveV2SandboxProvider,
  type V2SandboxProvider,
} from "./sandbox-runtime.js";

export interface V2RuntimeReadiness {
  ready: boolean;
  runtime: "v2" | "legacy";
  sandboxProvider: V2SandboxProvider | null;
  mcpServerCount: number;
  issues: string[];
  warnings: string[];
}

export function inspectV2RuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
): V2RuntimeReadiness {
  if (env.AGENT_RUNTIME?.trim().toLocaleLowerCase() === "legacy")
    return {
      ready: true,
      runtime: "legacy",
      sandboxProvider: null,
      mcpServerCount: env.MCP_SERVER_URL?.trim() ? 1 : 0,
      issues: [],
      warnings: ["Legacy artifact runtime is explicitly selected."],
    };

  const issues: string[] = [];
  const warnings: string[] = [];
  let sandboxProvider: V2SandboxProvider | null = null;
  let mcpServerCount = env.MCP_SERVER_URL?.trim() ? 1 : 0;

  try {
    sandboxProvider = resolveV2SandboxProvider(env);
    assertV2SandboxProviderReady(sandboxProvider, env);
    if (sandboxProvider === "cloudflare")
      warnings.push(
        "Cloudflare readiness verifies control-plane configuration; the R2 filesystem mount and in-sandbox browser MCPs are probed when each sandbox job is prepared.",
      );
    if (sandboxProvider === "docker")
      warnings.push(
        "Docker sandbox readiness is verified when the first sandbox session is created; the host must expose a working Docker daemon.",
      );
    if (
      sandboxProvider === "unix" &&
      env.NODE_ENV === "production"
    )
      warnings.push(
        "Unix-local sandbox is running under an explicit unsafe production override.",
      );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON, env);
    assertV2McpEnvironmentSafe(definitions, env);
    mcpServerCount += definitions.length;
    if (sandboxProvider === "cloudflare") {
      const mode = env.AGENT_BROWSER_AUTONOMY?.trim().toLowerCase() || "both";
      if (mode === "both") mcpServerCount += 2;
      else if (mode === "playwright" || mode === "puppeteer") mcpServerCount += 1;
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  return {
    ready: issues.length === 0,
    runtime: "v2",
    sandboxProvider,
    mcpServerCount,
    issues,
    warnings,
  };
}
'''
write('src/server/v2/runtime-readiness.ts', runtime_readiness)

# Patch the artifact runtime to create a developer-owned sandbox session, prepare
# the Cloudflare R2 mount + in-sandbox browser MCPs, and give both the agent and
# MCPs the same Linux filesystem namespace.
artifact = Path('src/server/v2/artifact-agent-runtime.ts').read_text(encoding='utf-8')
artifact = artifact.replace(
    'import { createV2SandboxRuntime } from "./sandbox-runtime.js";\n',
    'import { createV2SandboxRuntime } from "./sandbox-runtime.js";\nimport {\n  cloudflareSandboxIdFromSession,\n  prepareCloudflareWorkspace,\n} from "./cloudflare-workspace.js";\n',
)
artifact = artifact.replace(
    '"You are operating inside a real sandbox workspace with filesystem editing and shell access. Use the workspace actively: keep research notes, a current plan, and revision notes instead of trying to hold the entire job in chat context.",',
    '"You are operating inside a real sandbox workspace with filesystem editing and shell access. Use the workspace actively: keep research notes, a current plan, and revision notes instead of trying to hold the entire job in chat context. In the hosted Cloudflare runtime, /workspace is the fast Linux workspace and /workspace/persist is an R2-backed filesystem mount that survives sandbox destruction; keep durable notes and browser outputs under /workspace/persist.",',
)
anchor = '  let sandboxRuntime: ReturnType<typeof createV2SandboxRuntime>;\n'
start = artifact.index(anchor)
new_tail = r'''  let sandboxRuntime: ReturnType<typeof createV2SandboxRuntime>;
  try {
    sandboxRuntime = createV2SandboxRuntime(input.jobId);
  } catch (error) {
    throw new ArtifactPipelineError(
      "INFRA",
      `Agent Díaz V2 configuration error: ${error instanceof Error ? error.message : String(error)}`,
      { ruleOrPart: "agent-v2-configuration", cause: error },
    );
  }

  let sandboxSession: any = null;
  let mcpRuntime: ReturnType<typeof createV2McpRuntime> | null = null;
  try {
    try {
      sandboxSession = await sandboxRuntime.client.create({ manifest });
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 sandbox creation failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-sandbox-create", cause: error },
      );
    }

    let internalDefinitions = [];
    let persistentPath: string | null = null;
    if (sandboxRuntime.provider === "cloudflare") {
      try {
        const sandboxId = cloudflareSandboxIdFromSession(sandboxSession);
        const prepared = await prepareCloudflareWorkspace({
          jobId: input.jobId,
          sandboxId,
          workerUrl: process.env.CLOUDFLARE_SANDBOX_WORKER_URL ?? "",
          apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY ?? "",
          env: process.env,
        });
        internalDefinitions = prepared.mcpDefinitions;
        persistentPath = prepared.persistentPath;
      } catch (error) {
        throw new ArtifactPipelineError(
          "INFRA",
          `Agent Díaz V2 Cloudflare workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          { ruleOrPart: "agent-v2-cloudflare-workspace", cause: error },
        );
      }
    }

    try {
      mcpRuntime = createV2McpRuntime(input.config, process.env, {
        internalDefinitions,
      });
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 MCP configuration failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-configuration", cause: error },
      );
    }
    const mcpServers = mcpRuntime.servers;

    const agent = new SandboxAgent({
      name: "Agent Díaz V2 Artifact Engineer",
      model: input.model,
      instructions: v2ArtifactAgentInstructions(input.kind),
      defaultManifest: manifest,
      tools: [
        webSearchTool({ searchContextSize: "medium" }),
        codeInterpreterTool(),
        buildTool,
        acceptTool,
      ],
      mcpServers,
      mcpConfig: {
        convertSchemasToStrict: true,
        errorFunction: null,
        includeServerInToolNames: true,
      },
      modelSettings: {
        reasoning: { effort: input.reasoningEffort },
        toolChoice: "required",
      },
      resetToolChoice: false,
      toolUseBehavior: { stopAtToolNames: ["accept_validated_artifact"] },
    });

    try {
      await connectV2McpServers(mcpRuntime, input.jobId);
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 MCP connection failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-mcp-connect", cause: error },
      );
    }

    log("info", "agent_v2.run_started", {
      jobId: input.jobId,
      kind: input.kind,
      model: input.model,
      attachments: attachments.length,
      mcpEnabled: mcpServers.length > 0,
      mcpServers: mcpRuntime.descriptions,
      sandboxProvider: sandboxRuntime.provider,
      persistentPath,
    });

    let result: any;
    try {
      result = await run(
        agent,
        `Open REQUEST.md and complete the ${input.kind} request. Use the workspace, research/code tools as needed, and iterate build_and_validate_artifact until it passes. Finish only by calling accept_validated_artifact.`,
        {
          maxTurns: null,
          signal: input.signal,
          sandbox: { session: sandboxSession },
        },
      );
    } catch (error: any) {
      if (input.signal?.aborted || error?.name === "AbortError") throw error;
      if (error instanceof ArtifactPipelineError) throw error;
      const failure = classifyV2BuildFailure(error);
      throw new ArtifactPipelineError(
        failure.failureClass,
        `Agent Díaz V2 runtime failure: ${failure.message}`,
        { ruleOrPart: failure.ruleOrPart, cause: error },
      );
    }

    if (!acceptedBuildId)
      throw new ArtifactPipelineError(
        "INFRA",
        "Agent Díaz V2 agent loop ended without accepting a validated artifact; the run will resume from its revision ledger.",
        { ruleOrPart: "agent-v2-agent-loop-ended" },
      );
    const accepted = successfulBuilds.get(acceptedBuildId);
    if (!accepted)
      throw new ArtifactPipelineError(
        "BUILD",
        "Agent Díaz V2 acceptance referenced a missing validated build.",
        { ruleOrPart: "agent-v2-accepted-build" },
      );

    const receipt = accepted.validationReceipt as unknown as Record<string, unknown>;
    receipt.agentRuntime = {
      version: "v2",
      harness: "@openai/agents",
      sandbox: sandboxRuntime.provider,
      persistentFilesystem: persistentPath,
      browserExecutionPlane:
        sandboxRuntime.provider === "cloudflare" ? "same-sandbox" : "host-compatible",
      mcp: mcpRuntime.descriptions,
      attempts: attempt,
      acceptance: "explicit-validated-build",
      recovery: "revision-ledger",
      diagnostics: "model-readable-file-output",
    };

    log("info", "agent_v2.run_completed", {
      jobId: input.jobId,
      kind: input.kind,
      attempts: attempt,
      acceptedBuildId,
      name: accepted.name,
    });
    return {
      file: accepted,
      attempts: attempt,
      finalOutput: result.finalOutput,
    };
  } finally {
    if (mcpRuntime) await closeV2McpServers(mcpRuntime, input.jobId);
    try {
      await sandboxSession?.close?.();
    } catch (error) {
      log("warn", "agent_v2.sandbox_close_failed", {
        jobId: input.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
'''
artifact = artifact[:start] + new_tail
write('src/server/v2/artifact-agent-runtime.ts', artifact)

worker_index = r'''import {
  ContainerProxy,
  Sandbox as BaseSandbox,
  getSandbox,
} from "@cloudflare/sandbox";
import { bridge, WarmPool } from "@cloudflare/sandbox/bridge";

const PLAYWRIGHT_PORT = 8931;
const PUPPETEER_PORT = 8932;
const PERSIST_PATH = "/workspace/persist";
const PLAYWRIGHT_PROCESS = "jefe-playwright-mcp";
const PUPPETEER_PROCESS = "jefe-puppeteer-mcp";

type BrowserMode = "both" | "playwright" | "puppeteer" | "off";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  WarmPool: DurableObjectNamespace<WarmPool>;
  JEFE_FS: R2Bucket;
  SANDBOX_API_KEY: string;
  SANDBOX_TRANSPORT?: string;
  WARM_POOL_TARGET?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  WARM_POOL_MAX_INSTANCES?: string;
  WARM_POOL_SCALE_BATCH_SIZE?: string;
}

export { ContainerProxy, WarmPool };

function forwardedRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.hostname = "sandbox.internal";
  url.port = "";
  url.pathname = pathname;
  const forwarded = new Request(url.toString(), request);
  forwarded.headers.delete("authorization");
  return forwarded;
}

export class Sandbox extends BaseSandbox<Env> {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__jefe/mcp/playwright")
      return this.containerFetch(forwardedRequest(request, "/mcp"), PLAYWRIGHT_PORT);
    if (pathname === "/__jefe/mcp/puppeteer")
      return this.containerFetch(forwardedRequest(request, "/mcp"), PUPPETEER_PORT);
    return super.fetch(request);
  }
}

function authorized(request: Request, env: Env): boolean {
  const key = env.SANDBOX_API_KEY?.trim();
  return Boolean(key) && request.headers.get("authorization") === `Bearer ${key}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function safeToken(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || !/^[a-zA-Z0-9._-]+$/.test(cleaned))
    throw new Error(`${label} contains unsupported characters`);
  return cleaned;
}

function browserMode(value: unknown): BrowserMode {
  if (value === "both" || value === "playwright" || value === "puppeteer" || value === "off")
    return value;
  throw new Error("browserMode must be both, playwright, puppeteer, or off");
}

async function stopProcessIfPresent(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
  processId: string,
): Promise<void> {
  const process = await sandbox.getProcess(processId);
  if (process) await process.kill();
}

async function prepareFilesystem(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
  jobId: string,
): Promise<void> {
  try {
    await sandbox.unmountBucket(PERSIST_PATH);
  } catch {
    // First setup has nothing mounted. A retry deliberately remounts the same
    // R2 prefix to guarantee that the requested job owns this mount point.
  }
  await sandbox.mountBucket("JEFE_FS", PERSIST_PATH, {
    prefix: `/jobs/${jobId}/`,
    readOnly: false,
  });

  // Prove this is not merely object API access: an ordinary POSIX shell creates,
  // tests, renames, reads and removes a file through the mounted path.
  const sentinel = `.jefe-posix-${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await sandbox.exec(
    `set -eu; cd ${PERSIST_PATH}; printf 'jefe-posix-ok' > ${sentinel}; test -f ${sentinel}; mv ${sentinel} ${sentinel}.moved; grep -q 'jefe-posix-ok' ${sentinel}.moved; rm ${sentinel}.moved; mkdir -p browser/playwright browser/devtools recovery`,
    { cwd: "/workspace" },
  );
  if (!result.success)
    throw new Error(`R2 POSIX mount verification failed: ${result.stderr.slice(0, 400)}`);
}

async function startPlaywright(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
): Promise<void> {
  const process = await sandbox.startProcess(
    `playwright-mcp --headless --isolated --no-sandbox --host 0.0.0.0 --port ${PLAYWRIGHT_PORT} --executable-path /usr/bin/chromium --output-dir ${PERSIST_PATH}/browser/playwright`,
    {
      cwd: "/workspace",
      processId: PLAYWRIGHT_PROCESS,
      autoCleanup: true,
    },
  );
  await process.waitForPort(PLAYWRIGHT_PORT, { mode: "tcp", timeout: 30_000 });
}

async function startPuppeteer(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
): Promise<void> {
  const process = await sandbox.startProcess(
    `mcp-proxy --server stream --port ${PUPPETEER_PORT} --shell -- chrome-devtools-mcp --headless --isolated --executablePath /usr/bin/chromium --chromeArg=--no-sandbox --chromeArg=--disable-dev-shm-usage --allowUnrestrictedPaths --no-usage-statistics`,
    {
      cwd: "/workspace",
      processId: PUPPETEER_PROCESS,
      autoCleanup: true,
      env: {
        HOME: "/home/sandbox",
        NODE_PATH: "/usr/local/lib/node_modules",
      },
    },
  );
  await process.waitForPort(PUPPETEER_PORT, { mode: "tcp", timeout: 30_000 });
}

async function setup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sandboxId = safeToken(body.sandboxId, "sandboxId");
  const jobId = safeToken(body.jobId, "jobId");
  const mode = browserMode(body.browserMode);
  const sandbox = getSandbox(env.Sandbox, sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
  });

  await stopProcessIfPresent(sandbox, PLAYWRIGHT_PROCESS);
  await stopProcessIfPresent(sandbox, PUPPETEER_PROCESS);
  await prepareFilesystem(sandbox, jobId);

  const browsers = { playwright: false, puppeteer: false };
  if (mode === "both" || mode === "playwright") {
    await startPlaywright(sandbox);
    browsers.playwright = true;
  }
  if (mode === "both" || mode === "puppeteer") {
    await startPuppeteer(sandbox);
    browsers.puppeteer = true;
  }

  return json({
    ok: true,
    sandboxId,
    workspaceRoot: "/workspace",
    persistentPath: PERSIST_PATH,
    filesystem: {
      kind: "linux-r2-mounted",
      posix: true,
      persistent: true,
    },
    browsers,
  });
}

async function proxyMcp(request: Request, env: Env, match: RegExpMatchArray): Promise<Response> {
  const sandboxId = safeToken(decodeURIComponent(match[1] ?? ""), "sandboxId");
  const browser = match[2];
  const sandbox = getSandbox(env.Sandbox, sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
  });
  const internalPath =
    browser === "playwright" ? "/__jefe/mcp/playwright" : "/__jefe/mcp/puppeteer";
  const proxyRequest = forwardedRequest(request, internalPath);
  return sandbox.fetch(proxyRequest);
}

export default bridge({
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/jefe/setup" && request.method === "POST")
        return await setup(request, env);
      const match = url.pathname.match(
        /^\/jefe\/mcp\/([^/]+)\/(playwright|puppeteer)$/,
      );
      if (match) return await proxyMcp(request, env, match);
      if (url.pathname === "/jefe/health")
        return json({ ok: true, filesystem: "r2-mounted", browsers: "in-sandbox" });
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("jefe_bridge_error", {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Cloudflare sandbox setup failed",
        },
        500,
      );
    }
  },
});
'''
write('cloudflare-sandbox/src/index.ts', worker_index)

write('cloudflare-sandbox/package.json', r'''{
  "name": "jefe-auto-cloudflare-sandbox",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "verify:contract": "node scripts/verify-contract.mjs"
  },
  "devDependencies": {
    "@cloudflare/sandbox": "0.12.9",
    "@cloudflare/workers-types": "^4.20251126.0",
    "typescript": "^5.9.3",
    "wrangler": "^4.102.0"
  }
}
''')

write('cloudflare-sandbox/tsconfig.json', r'''{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
''')

write('cloudflare-sandbox/wrangler.jsonc', r'''{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "jefe-auto-sandbox",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-05",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "traces": { "enabled": true, "head_sampling_rate": 1 }
  },
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "standard-1",
      "max_instances": 1
    }
  ],
  "durable_objects": {
    "bindings": [
      { "class_name": "Sandbox", "name": "Sandbox" },
      { "class_name": "WarmPool", "name": "WarmPool" }
    ]
  },
  "migrations": [
    { "new_sqlite_classes": ["Sandbox"], "tag": "v1" },
    { "new_sqlite_classes": ["WarmPool"], "tag": "v2" }
  ],
  "r2_buckets": [
    { "binding": "JEFE_FS", "bucket_name": "jefe-auto-fs" }
  ],
  "vars": {
    "SANDBOX_TRANSPORT": "rpc",
    "WARM_POOL_TARGET": "0",
    "WARM_POOL_REFRESH_INTERVAL": "10000",
    "WARM_POOL_MAX_INSTANCES": "1",
    "WARM_POOL_SCALE_BATCH_SIZE": "1"
  },
  "preview_urls": false
}
''')

write('cloudflare-sandbox/Dockerfile', r'''FROM docker.io/cloudflare/sandbox:0.12.9

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_PATH=/usr/local/lib/node_modules

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    tar \
    git \
    curl \
    wget \
    ripgrep \
    jq \
    procps \
    sed \
    gawk \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /proc/mounts /etc/mtab

RUN npm install -g --omit=dev \
    @playwright/mcp@0.0.80 \
    chrome-devtools-mcp@1.8.0 \
    puppeteer@25.10.0 \
    mcp-proxy@6.7.13

RUN mkdir -p /workspace \
    && useradd -m -s /bin/bash -d /home/sandbox sandbox \
    && chown sandbox:sandbox /workspace \
    && chmod 700 /root

EXPOSE 8931 8932

USER sandbox
WORKDIR /workspace
''')

write('cloudflare-sandbox/scripts/verify-contract.mjs', r'''import fs from "node:fs";

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
''')

write('cloudflare-sandbox/README.md', r'''# JEFE//AUTO Cloudflare execution plane

This Worker is the production sandbox bridge for JEFE//AUTO. It extends the official Cloudflare Sandbox bridge with three authenticated capabilities:

1. Mount the `JEFE_FS` R2 binding at `/workspace/persist` using a per-job prefix.
2. Prove the mount with ordinary POSIX shell operations before an agent run is admitted.
3. Start Playwright MCP and Puppeteer-backed Chrome DevTools MCP **inside the same Linux sandbox** and proxy their Streamable HTTP transports through the authenticated Worker.

The agent therefore gets one filesystem namespace:

- `/workspace` — fast sandbox-local Linux filesystem.
- `/workspace/persist` — R2-backed filesystem mount that survives sandbox destruction.
- Playwright, Chromium, Chrome DevTools MCP, Puppeteer scripts and shell commands all run in that same container and see both paths.

## Required Cloudflare setup

Cloudflare Sandbox/Containers currently requires Workers Paid. R2 usage is billed separately and may remain within R2's free allowance.

Create the R2 bucket once:

```bash
npx wrangler r2 bucket create jefe-auto-fs
```

Set one high-entropy bridge secret (never commit it):

```bash
openssl rand -hex 32
npx wrangler secret put SANDBOX_API_KEY
```

Deploy from this directory:

```bash
npm ci
npm run typecheck
npm run verify:contract
npm run deploy
```

Put the resulting Worker URL and the same raw secret in Render as `CLOUDFLARE_SANDBOX_WORKER_URL` and `CLOUDFLARE_SANDBOX_API_KEY`. JEFE//AUTO adds `Bearer ` itself.

`standard-1` is deliberately selected for Chromium (4 GiB memory). `max_instances` and the warm pool are both constrained to avoid surprise concurrency costs while proving production.
''')

# Environment contract: Cloudflare becomes the canonical production execution plane.
env_path = Path('.env.example')
env_text = env_path.read_text(encoding='utf-8')
env_text = env_text.replace(
    '# Production sandbox. Cloudflare hosted is the recommended production path.\n',
    '# Production sandbox. Cloudflare hosted is the canonical production path.\n',
)
env_text = env_text.replace(
    'CLOUDFLARE_SANDBOX_API_KEY=\n',
    '# Raw high-entropy SANDBOX_API_KEY from the Worker; JEFE//AUTO sends Bearer auth.\nCLOUDFLARE_SANDBOX_API_KEY=\n',
)
env_text += '\n# Cloudflare Worker binds R2 bucket jefe-auto-fs as JEFE_FS and mounts it at\n# /workspace/persist. Do not set STORAGE_DIR to this path: Render app SQLite is\n# a separate persistence concern and must not be placed on an object/FUSE mount.\n'
write('.env.example', env_text)

# README gets an explicit filesystem boundary so future work cannot regress to
# running browsers on Render while the agent edits files elsewhere.
readme_path = Path('README.md')
readme = readme_path.read_text(encoding='utf-8')
readme += r'''

## Canonical production filesystem boundary

For production V2 jobs, Cloudflare Sandbox is the execution plane. `/workspace` is a real Linux filesystem and the Worker mounts the `JEFE_FS` R2 binding at `/workspace/persist` with a per-job prefix. The Worker performs a POSIX create/test/rename/read/delete sentinel before reporting setup success.

Playwright MCP and Puppeteer-backed Chrome DevTools MCP are launched **inside that same Cloudflare sandbox**, then exposed to the Render control plane only through authenticated Worker proxy routes. There are no public quick tunnels and no second browser filesystem on Render. Direct Puppeteer is installed in the same container as well.

This R2 mount is for agent workspace persistence. It is intentionally **not** used as a SQLite filesystem: Render's application database/storage remains a separate durability concern until it is migrated to a database-safe remote store.

See `cloudflare-sandbox/README.md` for deployment steps.
'''
write('README.md', readme)

# Update tests: Cloudflare must suppress host stdio browsers and prepare dynamic
# authenticated HTTP browser MCPs backed by a proven POSIX/R2 workspace.
test_path = Path('src/server/__tests__/agent-v2-runtime.test.ts')
test = test_path.read_text(encoding='utf-8')
test = test.replace(
    'import { buildFailureToolOutput } from "../v2/diagnostic-evidence.js";\n',
    'import { buildFailureToolOutput } from "../v2/diagnostic-evidence.js";\nimport { prepareCloudflareWorkspace } from "../v2/cloudflare-workspace.js";\n',
)
old_browser_test = r'''  it("loads Playwright and Puppeteer browser MCPs as built-in autonomous tools", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_BROWSER_AUTONOMY: "both",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(definitions.map((definition) => definition.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    expect(definitions.every((definition) => definition.transport === "stdio")).toBe(true);
    const playwright = definitions[0];
    const puppeteer = definitions[1];
    expect(playwright?.transport).toBe("stdio");
    expect(puppeteer?.transport).toBe("stdio");
    if (playwright?.transport !== "stdio" || puppeteer?.transport !== "stdio")
      throw new Error("Built-in browser MCPs must use stdio transport");
    expect(playwright.fullCommand).toContain("@playwright/mcp");
    expect(puppeteer.fullCommand).toContain("chrome-devtools-mcp");
    expect(() =>
      assertV2McpEnvironmentSafe(definitions, { NODE_ENV: "production" }),
    ).not.toThrow();
  });
'''
new_browser_tests = r'''  it("keeps host browser MCPs for non-Cloudflare compatibility runtimes", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "unix",
      AGENT_BROWSER_AUTONOMY: "both",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(definitions.map((definition) => definition.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    expect(definitions.every((definition) => definition.transport === "stdio")).toBe(true);
  });

  it("never launches Cloudflare production browser MCPs on the Render host", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      AGENT_BROWSER_AUTONOMY: "both",
    });
    expect(definitions).toEqual([]);
  });

  it("prepares authenticated in-sandbox browser MCPs over the Cloudflare R2 filesystem", async () => {
    let authorization = "";
    let body = "";
    const prepared = await prepareCloudflareWorkspace({
      jobId: "job-123",
      sandboxId: "cf-123",
      workerUrl: "https://sandbox.example.workers.dev",
      apiKey: "bridge-secret",
      env: {
        NODE_ENV: "production",
        AGENT_BROWSER_AUTONOMY: "both",
      },
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        body = String(init?.body ?? "");
        return Response.json({
          ok: true,
          sandboxId: "cf-123",
          workspaceRoot: "/workspace",
          persistentPath: "/workspace/persist",
          filesystem: {
            kind: "linux-r2-mounted",
            posix: true,
            persistent: true,
          },
          browsers: { playwright: true, puppeteer: true },
        });
      },
    });
    expect(authorization).toBe("Bearer bridge-secret");
    expect(JSON.parse(body)).toMatchObject({ jobId: "job-123", sandboxId: "cf-123" });
    expect(prepared.persistentPath).toBe("/workspace/persist");
    expect(prepared.filesystem).toMatchObject({ posix: true, persistent: true });
    expect(prepared.mcpDefinitions.map((item) => [item.name, item.transport])).toEqual([
      ["Playwright Browser", "http"],
      ["Puppeteer DevTools", "http"],
    ]);
    expect(JSON.stringify(prepared.mcpDefinitions)).not.toContain("bridge-secret");
    expect(prepared.mcpDefinitions.every((item) => item.authorization === "Bearer bridge-secret")).toBe(true);
  });
'''
if old_browser_test not in test:
    raise SystemExit('browser test anchor missing')
test = test.replace(old_browser_test, new_browser_tests)
# Readiness now requires the bridge API key in production and counts the two
# dynamic in-sandbox browser MCPs without exposing the secret.
test = test.replace(
    'expect(ready.ready).toBe(true);\n    expect(JSON.stringify(ready)).not.toContain("super-secret-value");',
    'expect(ready.ready).toBe(true);\n    expect(ready.mcpServerCount).toBe(2);\n    expect(JSON.stringify(ready)).not.toContain("super-secret-value");',
)
test = test.replace(
    '  it("returns failed artifact bytes to the model as diagnostic file output", async () => {',
    r'''  it("requires an authenticated Cloudflare bridge in production", () => {
    expect(() =>
      assertV2SandboxProviderReady("cloudflare", {
        NODE_ENV: "production",
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      }),
    ).toThrow(/CLOUDFLARE_SANDBOX_API_KEY/);
  });

  it("rejects custom MCP JSON that impersonates a reserved built-in browser", () => {
    expect(() =>
      parseV2McpDefinitions(
        JSON.stringify([
          {
            transport: "stdio",
            name: "Playwright Browser",
            fullCommand: "evil-browser-wrapper",
          },
        ]),
        { NODE_ENV: "production", AGENT_BROWSER_AUTONOMY: "off" },
      ),
    ).toThrow(/reserved/);
  });

  it("returns failed artifact bytes to the model as diagnostic file output", async () => {''',
)
write(str(test_path), test)

# Extend normal CI to typecheck the deployable Worker and statically assert that
# the real-filesystem/browser co-location contract cannot silently disappear.
verify_path = Path('.github/workflows/verify.yml')
verify = verify_path.read_text(encoding='utf-8')
needle = '      - name: Build production container\n'
if needle not in verify:
    raise SystemExit('verify workflow anchor missing')
insert = r'''      - name: Verify Cloudflare sandbox execution plane
        working-directory: cloudflare-sandbox
        run: |
          npm ci --ignore-scripts --no-audit --no-fund
          npm run typecheck
          npm run verify:contract
      - name: Build Cloudflare sandbox browser image
        run: docker build --tag jefe-auto-cloudflare-sandbox:${{ github.sha }} cloudflare-sandbox
      - name: Verify Cloudflare sandbox browser image
        run: |
          docker run --rm --entrypoint sh jefe-auto-cloudflare-sandbox:${{ github.sha }} -lc 'set -eu; test -d /workspace; test -w /workspace; chromium --version; playwright-mcp --help >/dev/null; chrome-devtools-mcp --help >/dev/null; mcp-proxy --help >/dev/null; NODE_PATH=/usr/local/lib/node_modules node -e "const p=require(\"puppeteer\"); if (!p.launch) process.exit(1); console.log(\"Cloudflare Puppeteer module smoke passed\")"'
'''
verify = verify.replace(needle, insert + needle)
write(str(verify_path), verify)

print('Cloudflare real filesystem upgrade applied')
