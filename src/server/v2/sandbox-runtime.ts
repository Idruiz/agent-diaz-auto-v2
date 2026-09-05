import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
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
