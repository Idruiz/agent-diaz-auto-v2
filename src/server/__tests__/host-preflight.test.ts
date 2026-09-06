import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ version: vi.fn(), launch: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => {
    const callback = args.at(-1);
    try { callback(null, { stdout: mocks.version(...args.slice(0, -1)), stderr: "" }); }
    catch (error) { callback(error); }
  },
}));
vi.mock("puppeteer", () => ({ default: { launch: mocks.launch } }));
import { probeV2RuntimeReadiness } from "../v2/host-preflight.js";

let root: string;
let env: NodeJS.ProcessEnv;
let close: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jefe-preflight-"));
  env = { NODE_ENV: "test", AGENT_RUNTIME: "v2", AGENT_SANDBOX_PROVIDER: "render",
    STORAGE_DIR: path.join(root, "disk"), HOME: path.join(root, "home"),
    AGENT_BROWSER_AUTONOMY: "both", OPENAI_API_KEY: "private-key", ADMIN_PASSWORD: "private-password" };
  mocks.version.mockReturnValue("Chromium 123\n");
  close = vi.fn().mockResolvedValue(undefined);
  mocks.launch.mockResolvedValue({
    newPage: async () => ({ setContent: async () => {}, title: async () => "JEFE readiness" }),
    close,
  });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("boot runtime preflight", () => {
  it("proves storage round-trip and browser operation without passing app secrets", async () => {
    const result = await probeV2RuntimeReadiness(env);
    expect(result).toMatchObject({ ready: true, storageWritable: true, persistentPath: env.STORAGE_DIR,
      home: { writable: true }, chromium: { available: true, launchVerified: true, version: "Chromium 123" } });
    expect(close).toHaveBeenCalledOnce();
    expect(await fs.readdir(env.STORAGE_DIR!)).toEqual([]);
    expect(await fs.readdir(env.HOME!)).toEqual([]);
    const serialized = JSON.stringify([result, mocks.launch.mock.calls, mocks.version.mock.calls]);
    expect(serialized).not.toContain("private-key");
    expect(serialized).not.toContain("private-password");
  });
  it("fails readiness when storage is not a writable directory", async () => {
    await fs.writeFile(env.STORAGE_DIR!, "not a directory");
    const result = await probeV2RuntimeReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.storageWritable).toBe(false);
    expect(result.issues.some((issue) => issue.startsWith("STORAGE_PROBE_FAILED:"))).toBe(true);
  });
  it("fails readiness and does not launch with unusable HOME", async () => {
    await fs.writeFile(env.HOME!, "not a directory");
    const result = await probeV2RuntimeReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.home.writable).toBe(false);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("fails readiness when Chromium is missing and sanitizes process errors", async () => {
    mocks.version.mockImplementation(() => { throw new Error("private-password ENOENT"); });
    const result = await probeV2RuntimeReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.chromium.available).toBe(false);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-password");
  });
  it("rejects launch failure even when version and MCP configuration succeed", async () => {
    mocks.launch.mockRejectedValue(new Error("TimeoutError"));
    const result = await probeV2RuntimeReadiness(env);
    expect(result).toMatchObject({ ready: false, mcpServerCount: 2,
      chromium: { available: true, launchVerified: false } });
    expect(mocks.launch.mock.calls[0]![0]).toMatchObject({ timeout: 10_000, protocolTimeout: 5_000 });
  });
  it("closes Chromium when page verification fails", async () => {
    mocks.launch.mockResolvedValue({ newPage: async () => { throw new Error("Page failure"); }, close });
    expect((await probeV2RuntimeReadiness(env)).ready).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
  it("forces termination and reports a failed close", async () => {
    const kill = vi.fn();
    close.mockRejectedValue(new Error("Close failed"));
    mocks.launch.mockResolvedValue({
      newPage: async () => ({ setContent: async () => {}, title: async () => "JEFE readiness" }),
      close, process: () => ({ kill }),
    });
    expect((await probeV2RuntimeReadiness(env)).ready).toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("skips host Chromium for browser-off, legacy, and Cloudflare runtimes", async () => {
    for (const override of [
      { AGENT_BROWSER_AUTONOMY: "off" }, { AGENT_RUNTIME: "legacy" },
      { AGENT_SANDBOX_PROVIDER: "cloudflare", CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example" },
    ]) {
      const result = await probeV2RuntimeReadiness({ ...env, ...override });
      expect(result.ready).toBe(true);
      expect(result.chromium.required).toBe(false);
    }
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.version).not.toHaveBeenCalled();
  });
  it("does not touch host resources after configuration rejection", async () => {
    const result = await probeV2RuntimeReadiness({ ...env, AGENT_SANDBOX_PROVIDER: "spaceship" });
    expect(result.ready).toBe(false);
    expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
