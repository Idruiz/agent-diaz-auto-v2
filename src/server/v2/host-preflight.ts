import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import puppeteer, { type Browser } from "puppeteer";
import { log } from "../log.js";
import { browserAutonomyMode } from "./mcp-runtime.js";
import { inspectV2RuntimeReadiness } from "./runtime-readiness.js";

const execute = promisify(execFile);

async function checkWritable(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const real = await fs.realpath(directory);
  const probe = await fs.mkdtemp(path.join(real, ".readiness-"));
  try {
    const file = path.join(probe, "proof");
    await fs.writeFile(file, "jefe-runtime-ready", { flag: "wx", mode: 0o600 });
    if (await fs.readFile(file, "utf8") !== "jefe-runtime-ready")
      throw new Error("Storage read-back mismatch");
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
  return real;
}

async function closeBrowser(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser close timeout")), 2_000);
      }),
    ]);
  } catch (error) {
    browser.process()?.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Run once at boot. /readyz serves this result without spawning more browsers. */
export async function probeV2RuntimeReadiness(env: NodeJS.ProcessEnv = process.env) {
  const config = inspectV2RuntimeReadiness(env);
  const issues = [...config.issues];
  const hostRuntime = config.runtime === "v2" && config.sandboxProvider !== "cloudflare";
  const render = hostRuntime && config.sandboxProvider === "render";
  const browserRequired = hostRuntime && config.ready && browserAutonomyMode(env) !== "off";
  const homePath = env.HOME?.trim() || null;
  const result = {
    ...config,
    checkedAt: new Date().toISOString(),
    storageWritable: null as boolean | null,
    persistentPath: null as string | null,
    home: { path: homePath, writable: null as boolean | null },
    browserMcpConfigured: browserRequired && config.mcpServerCount > 0,
    chromium: {
      required: browserRequired,
      executable: env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium",
      available: false,
      version: null as string | null,
      launchVerified: false,
    },
    issues,
  };
  log("info", "agent_v2.preflight_started", { sandboxProvider: config.sandboxProvider, browserRequired });
  // Do not probe paths or execute commands from invalid configuration.
  if (config.ready && render) {
    try {
      const storage = await checkWritable(env.STORAGE_DIR?.trim() || "/var/data");
      if (env.NODE_ENV === "production" && storage !== "/var/data" && !storage.startsWith("/var/data/"))
        throw new Error("Storage symlink escapes persistent mount");
      result.persistentPath = storage;
      result.storageWritable = true;
    } catch {
      result.storageWritable = false;
      issues.push("STORAGE_PROBE_FAILED: Render storage must support write/read/delete within /var/data; check mount and runtime-user permissions.");
    }
  }
  if (browserRequired) {
    try {
      if (!homePath || (render && env.NODE_ENV === "production" && homePath !== "/home/diaz"))
        throw new Error("Invalid browser HOME");
      await checkWritable(homePath);
      result.home.writable = true;
    } catch {
      result.home.writable = false;
      issues.push("HOME_PROBE_FAILED: browser HOME must be writable; Render production requires /home/diaz.");
    }
    // Only pass the minimal browser environment, never application credentials.
    const browserEnv = { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: homePath || "", LANG: "C.UTF-8" };
    try {
      const version = await execute(result.chromium.executable, ["--version"], {
        timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384, env: browserEnv,
      });
      result.chromium.version = version.stdout.trim().slice(0, 200);
      result.chromium.available = true;
    } catch {
      issues.push("CHROMIUM_VERSION_FAILED: configured Chromium executable could not complete --version within 5 seconds.");
    }
    if (result.chromium.available && result.home.writable) {
      let browser: Browser | undefined;
      try {
        browser = await puppeteer.launch({
          executablePath: result.chromium.executable,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          env: browserEnv,
          timeout: 10_000,
          protocolTimeout: 5_000,
        });
        const page = await browser.newPage();
        await page.setContent("<title>JEFE readiness</title>", { timeout: 5_000 });
        if (await page.title() !== "JEFE readiness") throw new Error("Browser page mismatch");
        result.chromium.launchVerified = true;
      } catch {
        issues.push("CHROMIUM_LAUNCH_FAILED: headless Chromium could not launch and operate a trivial page; check executable, HOME, and browser resources.");
      } finally {
        if (browser) {
          try { await closeBrowser(browser); }
          catch {
            result.chromium.launchVerified = false;
            issues.push("CHROMIUM_CLOSE_FAILED: probe browser needed forced termination.");
          }
        }
      }
    }
  }
  result.ready = issues.length === 0;
  log(result.ready ? "info" : "error", "agent_v2.preflight_finished", result);
  return result;
}
