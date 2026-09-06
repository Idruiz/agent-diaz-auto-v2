import { describe, expect, it } from "vitest";
import { parseV2McpDefinitions } from "../v2/mcp-runtime.js";

function stdioCommand(
  definition: ReturnType<typeof parseV2McpDefinitions>[number] | undefined,
): string {
  expect(definition?.transport).toBe("stdio");
  if (!definition || definition.transport !== "stdio")
    throw new Error("Expected stdio MCP definition");
  return definition.fullCommand;
}

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
    const playwrightCommand = stdioCommand(definitions[0]);
    const puppeteerCommand = stdioCommand(definitions[1]);
    expect(playwrightCommand).toContain(
      "--cdp-endpoint='http://127.0.0.1:9222'",
    );
    expect(puppeteerCommand).toContain(
      "--browser-url='http://127.0.0.1:9222'",
    );
    expect(playwrightCommand).not.toContain("--executable-path");
    expect(puppeteerCommand).not.toContain("--executablePath");
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

    expect(stdioCommand(playwright[0])).toContain("--executable-path");
    expect(stdioCommand(puppeteer[0])).toContain("--executablePath");
  });
});
