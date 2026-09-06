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
  it("attaches both reviewed browser MCPs to one CDP endpoint without npx wrappers", () => {
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
    expect(playwrightCommand).toContain("node_modules/.bin/playwright-mcp");
    expect(puppeteerCommand).toContain("node_modules/.bin/chrome-devtools-mcp");
    expect(playwrightCommand).toContain("--max-old-space-size=96");
    expect(puppeteerCommand).toContain("--max-old-space-size=96");
    expect(playwrightCommand).toMatch(/^\/usr\/bin\/env NODE_OPTIONS=/);
    expect(puppeteerCommand).toMatch(/^\/usr\/bin\/env NODE_OPTIONS=/);
    expect(playwrightCommand).not.toMatch(/^NODE_OPTIONS=/);
    expect(puppeteerCommand).not.toMatch(/^NODE_OPTIONS=/);
    expect(playwrightCommand).not.toContain("npx ");
    expect(puppeteerCommand).not.toContain("npx ");
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

    const playwrightCommand = stdioCommand(playwright[0]);
    const puppeteerCommand = stdioCommand(puppeteer[0]);
    expect(playwrightCommand).toContain("--executable-path");
    expect(puppeteerCommand).toContain("--executablePath");
    expect(playwrightCommand).toContain("--max-old-space-size=96");
    expect(puppeteerCommand).toContain("--max-old-space-size=96");
    expect(playwrightCommand).toMatch(/^\/usr\/bin\/env NODE_OPTIONS=/);
    expect(puppeteerCommand).toMatch(/^\/usr\/bin\/env NODE_OPTIONS=/);
  });
});
