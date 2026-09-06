import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from "@openai/agents/sandbox/local";
import { log } from "../log.js";

export type V2SandboxProvider = "cloudflare" | "docker" | "render" | "unix";

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

function renderStorageDir(env: NodeJS.ProcessEnv): string {
  return env.STORAGE_DIR?.trim() || "/var/data";
}

export function resolveV2SandboxProvider(
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxProvider {
  const explicit = env.AGENT_SANDBOX_PROVIDER?.trim().toLocaleLowerCase();
  if (explicit) {
    if (
      explicit === "cloudflare" ||
      explicit === "docker" ||
      explicit === "render" ||
      explicit === "unix"
    )
      return explicit;
    throw new Error(
      `AGENT_SANDBOX_PROVIDER must be cloudflare, docker, or unix, with render also supported; received '${env.AGENT_SANDBOX_PROVIDER}'`,
    );
  }
  if (env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim()) return "cloudflare";
  if (enabled(env.RENDER)) return "render";
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
  if (provider === "render" && env.NODE_ENV === "production") {
    const storageDir = renderStorageDir(env);
    if (!storageDir.startsWith("/var/data"))
      throw new Error(
        `JEFE//AUTO Render execution requires STORAGE_DIR under /var/data so recovery state and artifacts use the persistent disk; received '${storageDir}'`,
      );
  }
  if (
    provider === "unix" &&
    env.NODE_ENV === "production" &&
    !enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX)
  )
    throw new Error(
      "Agent Díaz V2 refuses generic Unix-local shell execution in production. Select AGENT_SANDBOX_PROVIDER=render for the reviewed Render execution plane, configure Cloudflare/Docker isolation, or explicitly set AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true for an emergency override.",
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

  if (provider === "render") {
    const storageDir = renderStorageDir(env);
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: true,
      persistentFilesystem: storageDir,
      executionPlane: "render-service",
    });
    return { provider, client: new UnixLocalSandboxClient() };
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
