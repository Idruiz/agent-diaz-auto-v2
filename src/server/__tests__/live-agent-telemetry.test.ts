import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Manifest } from "@openai/agents/sandbox";
import { createV2SandboxRuntime } from "../v2/sandbox-runtime.js";
import { RenderSandboxClient } from "../v2/render-sandbox.js";
import { describe, expect, it } from "vitest";

describe("JEFE//AUTO live agent telemetry contract", () => {
  it("streams agent activity and emits heartbeat/tool telemetry", () => {
    const source = fs.readFileSync("src/server/v2/artifact-agent-runtime.ts", "utf8");
    expect(source).toContain("stream: true");
    expect(source).toContain("agent_v2.heartbeat");
    expect(source).toContain("agent_v2.tool_call_started");
    expect(source).toContain("agent_v2.tool_call_completed");
    expect(source).toContain("stream.toStream()");
    expect(source).toContain("await stream.completed");
    expect(source).toContain("resetToolChoice: true");
    expect(source).toContain("convertSchemasToStrict: false");
  });

  it("bounds stdio MCP calls instead of allowing silent indefinite waits", () => {
    const source = fs.readFileSync("src/server/v2/mcp-runtime.ts", "utf8");
    expect(source).toContain("DEFAULT_STDIO_TOOL_TIMEOUT_MS = 90_000");
    expect(source).toContain("timeout: definition.timeoutMs ?? DEFAULT_STDIO_TOOL_TIMEOUT_MS");
    expect(source).toContain("agent_v2.mcp_server_connecting");
    expect(source).toContain("agent_v2.mcp_server_connected");
  });

  it("places Render sandbox workspaces on persistent storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-durable-"));
    const runtime = createV2SandboxRuntime("durable-test", { NODE_ENV: "test", AGENT_SANDBOX_PROVIDER: "render", STORAGE_DIR: root });
    if (!(runtime.client instanceof RenderSandboxClient)) throw new Error("Render client was not selected");
    const session = await runtime.client.create({ manifest: new Manifest({ root: "/workspace" }) });
    try {
      const result = await session.exec({ cmd: "printf durable > proof.txt", login: false });
      expect(result.exitCode).toBe(0);
      const workspaces = fs.readdirSync(root);
      expect(workspaces).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, workspaces[0]!, "proof.txt"), "utf8")).toBe("durable");
    } finally { await session.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("makes tool availability and active work explicit in the UI", () => {
    const styles = fs.readFileSync("src/web/styles.css", "utf8");
    expect(styles).toContain('content: "NO TOOLS"');
    expect(styles).toContain("jefe-live-pulse");
    expect(styles).toContain("jefe-progress-flow");
    expect(styles).toContain("clamp(1.7rem, 3.2vw, 2.75rem)");
  });
});
