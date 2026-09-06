import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyV2BuildFailure,
  v2ArtifactAgentInstructions,
} from "../v2/artifact-agent-runtime.js";
import { buildFailureToolOutput } from "../v2/diagnostic-evidence.js";
import { prepareCloudflareWorkspace } from "../v2/cloudflare-workspace.js";
import {
  assertV2McpEnvironmentSafe,
  parseV2McpDefinitions,
} from "../v2/mcp-runtime.js";
import {
  appendV2RevisionEntry,
  clearV2InfrastructureRetry,
  hasV2InfrastructureRetryPending,
  listV2RecoveryFiles,
  readV2InfrastructureRetry,
  recordV2InfrastructureRetry,
  writeV2AttemptPlan,
} from "../v2/revision-ledger.js";
import { inspectV2RuntimeReadiness } from "../v2/runtime-readiness.js";
import {
  assertV2SandboxProviderReady,
  resolveV2SandboxProvider,
} from "../v2/sandbox-runtime.js";
import { ArtifactPipelineError } from "../artifact-quality.js";

describe("Agent Díaz v2 artifact runtime contract", () => {
  it("requires iterative validation, diagnostic inspection, recovery, and explicit acceptance", () => {
    const instructions = v2ArtifactAgentInstructions("presentation");
    expect(instructions).toContain("build_and_validate_artifact");
    expect(instructions).toContain("accept_validated_artifact");
    expect(instructions).toContain("Continue until a build returns ok:true");
    expect(instructions).toContain("avoid rigid text stuffing");
    expect(instructions).toContain("There is no arbitrary two-repair or six-call ceiling");
    expect(instructions).toContain("recovery/REVISION_HISTORY.jsonl");
    expect(instructions).toContain("stagnationCount");
    expect(instructions).toContain("rendered diagnostic PDF");
  });

  it("preserves deterministic failure classes for agent revision", () => {
    const failure = classifyV2BuildFailure(
      new ArtifactPipelineError("BUILD", "Text overflow in slide 4", {
        ruleOrPart: "presentation-text-fit",
      }),
    );
    expect(failure).toMatchObject({
      failureClass: "BUILD",
      ruleOrPart: "presentation-text-fit",
      message: "Text overflow in slide 4",
    });
  });

  it("treats provider/network errors as infrastructure rather than content defects", () => {
    const failure = classifyV2BuildFailure(
      new Error("provider returned 503 server error"),
    );
    expect(failure.failureClass).toBe("INFRA");
    expect(failure.ruleOrPart).toBe("agent-v2-infrastructure");
  });

  it("accepts multiple filtered HTTP and stdio MCP servers", () => {
    const definitions = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "http",
          name: "Research MCP",
          url: "https://example.com/mcp",
          authorizationEnv: "RESEARCH_MCP_AUTH",
          allowedTools: ["search", "fetch"],
        },
        {
          transport: "stdio",
          name: "Filesystem MCP",
          fullCommand: "npx -y @modelcontextprotocol/server-filesystem /workspace",
          blockedTools: ["delete_file"],
        },
        {
          transport: "stdio",
          name: "Playwright MCP",
          fullCommand: "npx -y @playwright/mcp@latest --headless",
        },
      ]),
    );
    expect(definitions).toHaveLength(3);
    expect(definitions[0]?.allowedTools).toEqual(["search", "fetch"]);
    expect(definitions.map((item) => item.transport)).toEqual([
      "http",
      "stdio",
      "stdio",
    ]);
  });

  it("rejects duplicate MCP server names before starting an agent run", () => {
    expect(() =>
      parseV2McpDefinitions(
        JSON.stringify([
          {
            transport: "http",
            name: "tools",
            url: "https://example.com/mcp",
          },
          {
            transport: "stdio",
            name: "TOOLS",
            fullCommand: "node server.js",
          },
        ]),
      ),
    ).toThrow(/Duplicate MCP server name/);
  });

  it("refuses host-level stdio MCP in production unless explicitly reviewed", () => {
    const definitions = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "stdio",
          name: "Custom Browser MCP",
          fullCommand: "node custom-browser-mcp.js",
        },
      ]),
    );
    expect(() =>
      assertV2McpEnvironmentSafe(definitions, { NODE_ENV: "production" }),
    ).toThrow(/refuses unreviewed host-level stdio MCP processes/);
    expect(() =>
      assertV2McpEnvironmentSafe(definitions, {
        NODE_ENV: "production",
        AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION: "true",
      }),
    ).not.toThrow();
  });

  it("keeps host browser MCPs for non-Cloudflare compatibility runtimes", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "unix",
      AGENT_BROWSER_AUTONOMY: "both",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(definitions.map((definition) => definition.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    expect(definitions.every((definition) => definition.transport === "stdio")).toBe(true);
  });

  it("never launches Cloudflare production browser MCPs on the Render host", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      AGENT_BROWSER_AUTONOMY: "both",
    });
    expect(definitions).toEqual([]);
  });

  it("prepares authenticated in-sandbox browser MCPs over the Cloudflare R2 filesystem", async () => {
    let authorization = "";
    let body = "";
    const prepared = await prepareCloudflareWorkspace({
      jobId: "job-123",
      sandboxId: "cf-123",
      workerUrl: "https://sandbox.example.workers.dev",
      apiKey: "bridge-secret",
      env: {
        NODE_ENV: "production",
        AGENT_BROWSER_AUTONOMY: "both",
      },
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        body = String(init?.body ?? "");
        return Response.json({
          ok: true,
          sandboxId: "cf-123",
          workspaceRoot: "/workspace",
          persistentPath: "/workspace/persist",
          filesystem: {
            kind: "linux-r2-mounted",
            posix: true,
            persistent: true,
          },
          browsers: { playwright: true, puppeteer: true },
        });
      },
    });
    expect(authorization).toBe("Bearer bridge-secret");
    expect(JSON.parse(body)).toMatchObject({ jobId: "job-123", sandboxId: "cf-123" });
    expect(prepared.persistentPath).toBe("/workspace/persist");
    expect(prepared.filesystem).toMatchObject({ posix: true, persistent: true });
    expect(prepared.mcpDefinitions.map((item) => [item.name, item.transport])).toEqual([
      ["Playwright Browser", "http"],
      ["Puppeteer DevTools", "http"],
    ]);
    expect(JSON.stringify(prepared.mcpDefinitions)).not.toContain("bridge-secret");
    expect(prepared.mcpDefinitions.every((item) => item.authorization === "Bearer bridge-secret")).toBe(true);
  });

  it("prefers the hosted Cloudflare sandbox whenever a bridge URL is configured", () => {
    expect(
      resolveV2SandboxProvider({
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      }),
    ).toBe("cloudflare");
  });

  it("fails closed instead of silently giving the production agent a host shell", () => {
    expect(() =>
      assertV2SandboxProviderReady("unix", { NODE_ENV: "production" }),
    ).toThrow(/refuses Unix-local shell execution in production/);
    expect(() =>
      assertV2SandboxProviderReady("unix", {
        NODE_ENV: "production",
        AGENT_SANDBOX_ALLOW_UNSAFE_UNIX: "true",
      }),
    ).not.toThrow();
  });

  it("supports explicit Docker and Unix sandbox selection", () => {
    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "docker" })).toBe(
      "docker",
    );
    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "unix" })).toBe(
      "unix",
    );
    expect(() =>
      resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "spaceship" }),
    ).toThrow(/cloudflare, docker, or unix/);
  });

  it("reports deployment readiness without exposing secrets", () => {
    const blocked = inspectV2RuntimeReadiness({
      NODE_ENV: "production",
      AGENT_RUNTIME: "v2",
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.issues.join(" ")).toMatch(/Unix-local/);

    const ready = inspectV2RuntimeReadiness({
      NODE_ENV: "production",
      AGENT_RUNTIME: "v2",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      CLOUDFLARE_SANDBOX_API_KEY: "super-secret-value",
    });
    expect(ready.ready).toBe(true);
    expect(ready.mcpServerCount).toBe(2);
    expect(JSON.stringify(ready)).not.toContain("super-secret-value");
  });

  it("requires an authenticated Cloudflare bridge in production", () => {
    expect(() =>
      assertV2SandboxProviderReady("cloudflare", {
        NODE_ENV: "production",
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      }),
    ).toThrow(/CLOUDFLARE_SANDBOX_API_KEY/);
  });

  it("rejects custom MCP JSON that impersonates a reserved built-in browser", () => {
    expect(() =>
      parseV2McpDefinitions(
        JSON.stringify([
          {
            transport: "stdio",
            name: "Playwright Browser",
            fullCommand: "evil-browser-wrapper",
          },
        ]),
        { NODE_ENV: "production", AGENT_BROWSER_AUTONOMY: "off" },
      ),
    ).toThrow(/reserved/);
  });

  it("returns failed artifact bytes to the model as diagnostic file output", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-test-"));
    try {
      const diagnostic = path.join(temp, "failed.zip");
      fs.writeFileSync(diagnostic, Buffer.from("PK-test-diagnostic"));
      const output = await buildFailureToolOutput({
        jobId: "job-test",
        kind: "website",
        attempt: 2,
        failureClass: "BUILD",
        ruleOrPart: "website-validation",
        message: "Website validation failed",
        retryAdvice: "Inspect and revise",
        planSha: "abc123",
        stagnationCount: 1,
        diagnosticPath: diagnostic,
      });
      expect(output[0]).toMatchObject({ type: "text" });
      expect(output.some((item) => item.type === "file")).toBe(true);
      expect(String(output[0]?.text)).not.toContain(temp);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("persists revision history and the latest plan for process-restart recovery", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-recovery-"));
    try {
      const attempt = writeV2AttemptPlan(temp, 3, {
        title: "Recovered plan",
        sections: [],
      });
      appendV2RevisionEntry(temp, {
        attempt: 3,
        planSha: attempt.planSha,
        status: "rejected",
        failureClass: "BUILD",
        ruleOrPart: "presentation-text-fit",
        message: "overflow",
        stagnationCount: 1,
      });
      const files = listV2RecoveryFiles(temp);
      expect(files.map((item) => item.workspacePath).sort()).toEqual([
        "recovery/LATEST_PLAN.json",
        "recovery/REVISION_HISTORY.jsonl",
      ]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("persists transient infrastructure retry state across process restarts", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-infra-retry-"));
    try {
      expect(hasV2InfrastructureRetryPending(temp)).toBe(false);
      const first = recordV2InfrastructureRetry(
        temp,
        "agent-v2-mcp-connect",
        "503 from remote MCP",
      );
      expect(first.count).toBe(1);
      expect(hasV2InfrastructureRetryPending(temp)).toBe(true);
      const second = recordV2InfrastructureRetry(
        temp,
        "agent-v2-mcp-connect",
        "503 from remote MCP",
      );
      expect(second.count).toBe(2);
      expect(readV2InfrastructureRetry(temp)?.count).toBe(2);
      clearV2InfrastructureRetry(temp);
      expect(hasV2InfrastructureRetryPending(temp)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

});
