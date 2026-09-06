import { z } from "zod";
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
  signal?: AbortSignal;
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
    signal: args.signal
      ? AbortSignal.any([args.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
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
      timeoutMs: 120_000,
    });
  }

  // Credentials are needed by the HTTP transport, but must never be included
  // when definitions are serialized for diagnostics, receipts, or model input.
  for (const definition of mcpDefinitions)
    Object.defineProperty(definition, "authorization", {
      value: authorization,
      enumerable: false,
      writable: false,
      configurable: false,
    });

  return {
    persistentPath: parsed.persistentPath,
    mcpDefinitions,
    filesystem: parsed.filesystem,
  };
}
