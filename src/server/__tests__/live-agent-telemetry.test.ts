import fs from "node:fs";
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

  it("places Render sandbox workspaces on persistent storage", () => {
    const source = fs.readFileSync("src/server/v2/sandbox-runtime.ts", "utf8");
    expect(source).toContain("new UnixLocalSandboxClient({ workspaceBaseDir: storageDir })");
    expect(source).toContain('persistentFilesystem: storageDir');
  });

  it("makes tool availability and active work explicit in the UI", () => {
    const styles = fs.readFileSync("src/web/styles.css", "utf8");
    expect(styles).toContain('content: "NO TOOLS"');
    expect(styles).toContain("jefe-live-pulse");
    expect(styles).toContain("jefe-progress-flow");
    expect(styles).toContain("clamp(1.7rem, 3.2vw, 2.75rem)");
  });
});
