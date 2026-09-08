import {
  ContainerProxy,
  Sandbox as BaseSandbox,
  getSandbox,
} from "@cloudflare/sandbox";
import { bridge, WarmPool, type BridgeEnv } from "@cloudflare/sandbox/bridge";

const PLAYWRIGHT_PORT = 8931;
const PUPPETEER_PORT = 8932;
const PERSIST_PATH = "/workspace/persist";
const PLAYWRIGHT_PROCESS = "jefe-playwright-mcp";
const PUPPETEER_PROCESS = "jefe-puppeteer-mcp";

type BrowserMode = "both" | "playwright" | "puppeteer" | "off";

interface Env extends BridgeEnv {
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
  forwarded.headers.set("host", "sandbox.internal");
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
    `playwright-mcp --headless --isolated --no-sandbox --host 0.0.0.0 --allowed-hosts sandbox.internal,localhost,127.0.0.1 --port ${PLAYWRIGHT_PORT} --executable-path /usr/bin/chromium --output-dir ${PERSIST_PATH}/browser/playwright`,
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

  // Agent/tool runs can legitimately be quiet for longer than the normal idle
  // window. Cloudflare Sandbox keepAlive emits platform heartbeats every ~30s,
  // so the execution container cannot disappear merely because the model is
  // reasoning or a long tool call has not produced traffic yet. The host must
  // call /jefe/release in a finally path to turn this back off.
  await sandbox.setKeepAlive(true);

  try {
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
      keepAlive: true,
      filesystem: {
        kind: "linux-r2-mounted",
        posix: true,
        persistent: true,
      },
      browsers,
    });
  } catch (error) {
    // Setup did not hand ownership to a running job. Avoid leaking a pinned
    // container if mounting R2 or booting either browser MCP fails.
    try {
      await sandbox.setKeepAlive(false);
    } catch (releaseError) {
      console.error("jefe_keepalive_release_failed", {
        sandboxId,
        phase: "setup-error",
        message: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw error;
  }
}

async function release(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sandboxId = safeToken(body.sandboxId, "sandboxId");
  const sandbox = getSandbox(env.Sandbox, sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
  });
  const errors: string[] = [];

  // Browser MCP processes are task-scoped. Stop them before allowing the
  // sandbox to idle so a completed job never keeps Chromium resident.
  for (const processId of [PLAYWRIGHT_PROCESS, PUPPETEER_PROCESS]) {
    try {
      await stopProcessIfPresent(sandbox, processId);
    } catch (error) {
      errors.push(`${processId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await sandbox.setKeepAlive(false);
  } catch (error) {
    errors.push(`keepAlive: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length) {
    console.error("jefe_release_partial_failure", { sandboxId, errors });
    return json({ ok: false, sandboxId, released: false, errors }, 500);
  }

  return json({ ok: true, sandboxId, released: true, keepAlive: false });
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

const sandboxBridge = bridge({
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/jefe/setup" && request.method === "POST")
        return await setup(request, env);
      if (url.pathname === "/jefe/release" && request.method === "POST")
        return await release(request, env);
      const match = url.pathname.match(
        /^\/jefe\/mcp\/([^/]+)\/(playwright|puppeteer)$/,
      );
      if (match) return await proxyMcp(request, env, match);
      if (url.pathname === "/jefe/health")
        return json({
          ok: true,
          filesystem: "r2-mounted",
          browsers: "in-sandbox",
          keepAliveManaged: true,
        });
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("jefe_bridge_error", {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Cloudflare sandbox operation failed",
        },
        500,
      );
    }
  },
});

// The upstream bridge handles /v1 before the custom fetch handler and permits
// unauthenticated requests when its secret is absent. Guard the whole surface.
export default {
  ...sandboxBridge,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    if (!sandboxBridge.fetch) throw new Error("Cloudflare bridge fetch handler is missing");
    return sandboxBridge.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  },
};
