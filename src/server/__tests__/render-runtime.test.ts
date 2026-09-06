import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertV2SandboxProviderReady,
  createV2SandboxRuntime,
  resolveV2SandboxProvider,
} from "../v2/sandbox-runtime.js";
import { inspectV2RuntimeReadiness } from "../v2/runtime-readiness.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("JEFE//AUTO Render execution plane", () => {
  it("selects Render explicitly and from the Render platform marker", () => {
    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "render" })).toBe("render");
    expect(resolveV2SandboxProvider({ RENDER: "true" })).toBe("render");
  });

  it("requires production durable storage under the Render disk mount", () => {
    expect(() =>
      assertV2SandboxProviderReady("render", {
        NODE_ENV: "production",
        STORAGE_DIR: "/var/data",
      }),
    ).not.toThrow();
    expect(() =>
      assertV2SandboxProviderReady("render", {
        NODE_ENV: "production",
        STORAGE_DIR: "/app/storage",
      }),
    ).toThrow(/persistent disk/);
  });

  it("creates the reviewed local Render runtime without the unsafe Unix override", () => {
    const runtime = createV2SandboxRuntime("render-test", {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      STORAGE_DIR: "/var/data",
    });
    expect(runtime.provider).toBe("render");
  });

  it("reports Render production readiness with built-in browser MCPs", () => {
    const readiness = inspectV2RuntimeReadiness({
      NODE_ENV: "production",
      AGENT_RUNTIME: "v2",
      AGENT_SANDBOX_PROVIDER: "render",
      STORAGE_DIR: "/var/data",
      AGENT_BROWSER_AUTONOMY: "both",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.sandboxProvider).toBe("render");
    expect(readiness.mcpServerCount).toBe(2);
  });

  it("writes and reads persistent-state shaped files on a normal POSIX filesystem", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jefe-render-disk-"));
    tempRoots.push(root);
    const workspace = path.join(root, "artifacts", ".agent-v2", "job-1");
    fs.mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, "proof.txt");
    fs.writeFileSync(file, "persistent-render-filesystem", "utf8");
    expect(fs.readFileSync(file, "utf8")).toBe("persistent-render-filesystem");
  });
});
