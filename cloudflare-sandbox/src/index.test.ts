import { describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => new Response("bridge reached")));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  getSandbox: vi.fn(),
}));
vi.mock("@cloudflare/sandbox/bridge", () => ({
  WarmPool: class {},
  bridge: () => ({ fetch: upstream }),
}));

import worker from "./index.js";

describe("Cloudflare bridge authentication boundary", () => {
  it.each(["/v1/sandbox", "/jefe/setup", "/health"])(
    "refuses %s when the bridge secret is absent",
    async path => {
      upstream.mockClear();
      const response = await worker.fetch(new Request("https://bridge.test" + path), {} as never, {} as never);
      expect(response.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects an incorrect credential before the official bridge runs", async () => {
    upstream.mockClear();
    const request = new Request("https://bridge.test/v1/sandbox", {
      headers: { Authorization: "Bearer wrong" },
    });
    const response = await worker.fetch(request, { SANDBOX_API_KEY: "test-only-key" } as never, {} as never);
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("passes an authenticated request through with its body intact", async () => {
    upstream.mockClear();
    const request = new Request("https://bridge.test/v1/sandbox", {
      method: "POST",
      headers: { Authorization: "Bearer test-only-key" },
      body: "request-body",
    });
    const response = await worker.fetch(request, { SANDBOX_API_KEY: "test-only-key" } as never, {} as never);
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(request);
    expect(await request.text()).toBe("request-body");
  });
});
