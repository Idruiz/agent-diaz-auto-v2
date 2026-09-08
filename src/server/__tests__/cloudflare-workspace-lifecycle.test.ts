import { describe, expect, it, vi } from "vitest";
import {
  cloudflareSandboxIdFromSession,
  prepareCloudflareWorkspace,
} from "../v2/cloudflare-workspace.js";

describe("Cloudflare workspace lifecycle", () => {
  it("arms keepAlive setup and releases it before the SDK session closes", async () => {
    const originalClose = vi.fn(async () => undefined);
    const session = {
      state: { sandboxId: "sandbox-test-1" },
      close: originalClose,
    };
    expect(cloudflareSandboxIdFromSession(session)).toBe("sandbox-test-1");

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/jefe/setup"))
        return Response.json({
          ok: true,
          sandboxId: "sandbox-test-1",
          workspaceRoot: "/workspace",
          persistentPath: "/workspace/persist",
          keepAlive: true,
          filesystem: {
            kind: "linux-r2-mounted",
            posix: true,
            persistent: true,
          },
          browsers: { playwright: false, puppeteer: false },
        });
      if (url.endsWith("/jefe/release"))
        return Response.json({
          ok: true,
          sandboxId: "sandbox-test-1",
          released: true,
          keepAlive: false,
        });
      return new Response("not found", { status: 404 });
    });

    const prepared = await prepareCloudflareWorkspace({
      jobId: "job-test-1",
      sandboxId: "sandbox-test-1",
      workerUrl: "https://sandbox.example.test",
      apiKey: "test-only-key",
      env: { NODE_ENV: "test", AGENT_BROWSER_AUTONOMY: "off" },
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(prepared.keepAlive).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://sandbox.example.test/jefe/setup");
    expect(requests[0]?.body).toMatchObject({
      jobId: "job-test-1",
      sandboxId: "sandbox-test-1",
      browserMode: "off",
    });

    await session.close();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("https://sandbox.example.test/jefe/release");
    expect(requests[1]?.body).toEqual({ sandboxId: "sandbox-test-1" });
    expect(originalClose).toHaveBeenCalledTimes(1);
  });

  it("still closes the SDK session when the release request fails", async () => {
    const originalClose = vi.fn(async () => undefined);
    const session = {
      state: { sandboxId: "sandbox-test-2" },
      close: originalClose,
    };
    cloudflareSandboxIdFromSession(session);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/jefe/setup"))
        return Response.json({
          ok: true,
          sandboxId: "sandbox-test-2",
          workspaceRoot: "/workspace",
          persistentPath: "/workspace/persist",
          keepAlive: true,
          filesystem: {
            kind: "linux-r2-mounted",
            posix: true,
            persistent: true,
          },
          browsers: { playwright: false, puppeteer: false },
        });
      return new Response("release unavailable", { status: 503 });
    });

    await prepareCloudflareWorkspace({
      jobId: "job-test-2",
      sandboxId: "sandbox-test-2",
      workerUrl: "https://sandbox.example.test",
      apiKey: "test-only-key",
      env: { NODE_ENV: "test", AGENT_BROWSER_AUTONOMY: "off" },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(session.close()).rejects.toThrow(/release failed \(503\)/i);
    expect(originalClose).toHaveBeenCalledTimes(1);
  });
});
