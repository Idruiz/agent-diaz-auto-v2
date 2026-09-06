import { describe, expect, it } from "vitest";
import { parseV2McpDefinitions } from "../v2/mcp-runtime.js";

describe("Render shared Chromium MCP configuration", () => {
  it("attaches both reviewed browser MCPs to one CDP endpoint", () => {
    const definitions = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      AGENT_BROWSER_AUTONOMY: "both",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });

    expect(definitions.map((item) => item.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    expect(definitions[0]?.transport).toBe("stdio");
    expect(definitions[1]?.transport).toBe("stdio");
    expect(definitions[0]?.fullCommand).toContain(
      "--cdp-endpoint='http://127.0.0.1:9222'",
    );
    expect(definitions[1]?.fullCommand).toContain(
      "--browser-url='http://127.0.0.1:9222'",
    );
    expect(definitions[0]?.fullCommand).not.toContain("--executable-path");
    expect(definitions[1]?.fullCommand).not.toContain("--executablePath");
  });

  it("keeps direct browser launch when only one MCP is enabled", () => {
    const playwright = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      AGENT_BROWSER_AUTONOMY: "playwright",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    const puppeteer = parseV2McpDefinitions(undefined, {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      AGENT_BROWSER_AUTONOMY: "puppeteer",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });

    expect(playwright[0]?.fullCommand).toContain("--executable-path");
    expect(puppeteer[0]?.fullCommand).toContain("--executablePath");
  });
});
