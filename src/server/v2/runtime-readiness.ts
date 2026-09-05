import {
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
