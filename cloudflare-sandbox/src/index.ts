import {
  ContainerProxy,
  Sandbox as BaseSandbox,
  getSandbox,
} from "@cloudflare/sandbox";
import { bridge, WarmPool as BridgeWarmPool, type BridgeEnv } from "@cloudflare/sandbox/bridge";

const PLAYWRIGHT_PORT = 8931;
const PUPPETEER_PORT = 8932;
const PERSIST_PATH = "/workspace/persist";
const PLAYWRIGHT_PROCESS = "jefe-playwright-mcp";
const PUPPETEER_PROCESS = "jefe-puppeteer-mcp";
const PERSIST_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;

type BrowserMode = "both" | "playwright" | "puppeteer" | "off";

interface Env extends BridgeEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  WarmPool: DurableObjectNamespace<BridgeWarmPool>;
  JEFE_FS: R2Bucket;
  SANDBOX_API_KEY: string;
  SANDBOX_TRANSPORT?: string;
  WARM_POOL_TARGET?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  WARM_POOL_MAX_INSTANCES?: string;
  WARM_POOL_SCALE_BATCH_SIZE?: string;
}

export { ContainerProxy, BridgeWarmPool as WarmPool };

// Fresh WarmPool Durable Object namespace for recovery from the 0/0 cached
// capacity latch in the upstream bridge. The binding name remains `WarmPool`
// so bridge() continues to work, while the old namespace is left intact and
// unused rather than destructively deleting Worker state.
export class WarmPoolV3 extends BridgeWarmPool {}

// Fresh pool namespace paired with SandboxV4. This prevents stale capacity
// state from the earlier split-container architecture from poisoning new jobs.
export class WarmPoolV4 extends BridgeWarmPool {}

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

// Fresh container-enabled Durable Object namespace. The old Sandbox namespace
// may contain keepAlive orphans created when JEFE routes addressed sandboxId
// directly instead of the warm-pool-assigned container UUID.
export class SandboxV4 extends Sandbox {}

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


function persistArchiveKey(jobId: string): string {
  return `jobs/${jobId}/workspace-persist.tar`;
}

function toBase64(bytes: Uint8Array): string {
  let output = "";
  const chunk = 6144;
  for (let i = 0; i < bytes.length; i += chunk)
    output += btoa(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  return output;
}

async function preparePersistentWorkspace(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
  env: Env,
  jobId: string,
): Promise<{ restored: boolean; bytes: number }> {
  const mkdir = await sandbox.exec(
    `mkdir -p ${PERSIST_PATH}/browser/playwright ${PERSIST_PATH}/browser/devtools ${PERSIST_PATH}/recovery`,
    { cwd: "/workspace", timeout: 10_000 },
  );
  if (!mkdir.success)
    throw new Error(`Persistent workspace directory creation failed: ${mkdir.stderr.slice(0, 400)}`);

  const key = persistArchiveKey(jobId);
  const object = await env.JEFE_FS.get(key);
  if (!object) return { restored: false, bytes: 0 };

  if (object.size > PERSIST_ARCHIVE_MAX_BYTES)
    throw new Error(
      `Persistent workspace archive is ${object.size} bytes; hydrate limit is ${PERSIST_ARCHIVE_MAX_BYTES}`,
    );

  const bytes = new Uint8Array(await object.arrayBuffer());
  const tmpPath = `/tmp/jefe-persist-${crypto.randomUUID()}.tar`;
  await sandbox.writeFile(tmpPath, toBase64(bytes), { encoding: "base64" });
  const extract = await sandbox.exec(
    `tar xf ${tmpPath} -C ${PERSIST_PATH} && rm -f ${tmpPath}`,
    { cwd: "/workspace", timeout: 20_000 },
  );
  if (!extract.success)
    throw new Error(`Persistent workspace hydrate failed: ${extract.stderr.slice(0, 400)}`);

  return { restored: true, bytes: object.size };
}

async function checkpointPersistentWorkspace(
  sandbox: ReturnType<typeof getSandbox<Sandbox>>,
  env: Env,
  jobId: string,
): Promise<{ bytes: number }> {
  const tmpPath = `/tmp/jefe-persist-${crypto.randomUUID()}.tar`;
  const archive = await sandbox.exec(
    `mkdir -p ${PERSIST_PATH}; tar cf ${tmpPath} -C ${PERSIST_PATH} .`,
    { cwd: "/workspace", timeout: 20_000 },
  );
  if (!archive.success)
    throw new Error(`Persistent workspace archive failed: ${archive.stderr.slice(0, 400)}`);

  const stream = await sandbox.readFileStream(tmpPath);
  await env.JEFE_FS.put(persistArchiveKey(jobId), stream, {
    httpMetadata: { contentType: "application/x-tar" },
    customMetadata: {
      jobId,
      persistedAt: new Date().toISOString(),
      mode: "checkpointed-workspace",
    },
  });

  const head = await env.JEFE_FS.head(persistArchiveKey(jobId));
  await sandbox.exec(`rm -f ${tmpPath}`, { cwd: "/workspace", timeout: 5_000 }).catch(() => {});
  return { bytes: head?.size ?? 0 };
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

async function resolveSandbox(
  env: Env,
  sandboxId: string,
): Promise<ReturnType<typeof getSandbox<Sandbox>>> {
  const poolId = env.WarmPool.idFromName("global-pool");
  const pool = env.WarmPool.get(poolId);
  const existing = await pool.lookupContainer(sandboxId);
  const containerUUID = existing ?? (await pool.getContainer(sandboxId));
  console.log("jefe_sandbox_resolved", {
    sandboxId,
    containerUUID,
    reused: Boolean(existing),
  });
  return getSandbox(env.Sandbox, containerUUID, {
    transport: "rpc",
    enableDefaultSession: false,
  });
}

async function setup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sandboxId = safeToken(body.sandboxId, "sandboxId");
  const jobId = safeToken(body.jobId, "jobId");
  const mode = browserMode(body.browserMode);
  const sandbox = await resolveSandbox(env, sandboxId);

  const phase = async <T>(
    name: string,
    action: () => Promise<T>,
    timeoutMs = 45_000,
  ): Promise<T> => {
    const startedAt = Date.now();
    console.log("jefe_setup_phase", { sandboxId, jobId, phase: name, state: "start" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} phase exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      const value = await Promise.race([action(), timeout]);
      console.log("jefe_setup_phase", {
        sandboxId,
        jobId,
        phase: name,
        state: "done",
        durationMs: Date.now() - startedAt,
      });
      return value;
    } catch (error) {
      console.error("jefe_setup_phase", {
        sandboxId,
        jobId,
        phase: name,
        state: "error",
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const persistence = await phase("filesystem", () => preparePersistentWorkspace(sandbox, env, jobId), 40_000);

    const browsers = { playwright: false, puppeteer: false };
    const browserStarts: Promise<void>[] = [];
    if (mode === "both" || mode === "playwright") {
      browserStarts.push(
        phase("playwright", async () => {
          await startPlaywright(sandbox);
          browsers.playwright = true;
        }, 40_000),
      );
    }
    if (mode === "both" || mode === "puppeteer") {
      browserStarts.push(
        phase("puppeteer", async () => {
          await startPuppeteer(sandbox);
          browsers.puppeteer = true;
        }, 40_000),
      );
    }
    if (browserStarts.length) await Promise.all(browserStarts);

    // Do not pin the container. BaseSandbox/Container activity renews the
    // normal idle timer on real work, while the default sleepAfter safety net
    // guarantees a crashed caller cannot hold a slot forever.
    console.log("jefe_setup_complete", { sandboxId, jobId, mode, browsers, persistence });
    return json({
      ok: true,
      sandboxId,
      workspaceRoot: "/workspace",
      persistentPath: PERSIST_PATH,
      keepAlive: false,
      filesystem: {
        kind: "linux-r2-checkpointed",
        posix: true,
        persistent: true,
        restored: persistence.restored,
        restoredBytes: persistence.bytes,
      },
      browsers,
    });
  } catch (error) {
    // Setup did not hand ownership to a running job. Destroy the failed
    // pool-tracked sandbox immediately; otherwise normal idle sleep remains
    // the final safety net.
    try {
      await sandbox.destroy();
      console.log("jefe_setup_failed_sandbox_destroyed", { sandboxId, jobId });
    } catch (destroyError) {
      console.error("jefe_setup_destroy_failed", {
        sandboxId,
        jobId,
        message: destroyError instanceof Error ? destroyError.message : String(destroyError),
      });
    }
    throw error;
  }
}

async function release(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sandboxId = safeToken(body.sandboxId, "sandboxId");
  const jobId = safeToken(body.jobId, "jobId");
  const sandbox = await resolveSandbox(env, sandboxId);
  const errors: string[] = [];

  // Browser MCP processes are task-scoped. Stop them before allowing the
  // sandbox to idle so a completed job never keeps Chromium resident.
  for (const processId of [PLAYWRIGHT_PROCESS, PUPPETEER_PROCESS]) {
    try {
      const process = await sandbox.getProcess(processId);
      if (process) await process.kill();
    } catch (error) {
      errors.push(`${processId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const checkpoint = await checkpointPersistentWorkspace(sandbox, env, jobId);
    console.log("jefe_persistence_checkpointed", {
      sandboxId,
      jobId,
      bytes: checkpoint.bytes,
    });
  } catch (error) {
    errors.push(`persistence: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length) {
    console.error("jefe_release_partial_failure", { sandboxId, errors });
    return json({ ok: false, sandboxId, released: false, errors }, 500);
  }

  return json({ ok: true, sandboxId, jobId, released: true, keepAlive: false });
}

async function proxyMcp(request: Request, env: Env, match: RegExpMatchArray): Promise<Response> {
  const sandboxId = safeToken(decodeURIComponent(match[1] ?? ""), "sandboxId");
  const browser = match[2];
  const sandbox = await resolveSandbox(env, sandboxId);
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
          filesystem: "r2-checkpointed",
          browsers: "in-sandbox",
          keepAliveManaged: false,
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
