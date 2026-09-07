import { describe, expect, it } from "vitest";
import {
  builtInBrowserMcpProcessSpec,
  parseV2McpDefinitions,
} from "../v2/mcp-runtime.js";

function stdioCommand(
  definition: ReturnType<typeof parseV2McpDefinitions>[number] | undefined,
): string {
  expect(definition?.transport).toBe("stdio");
  if (!definition || definition.transport !== "stdio")
    throw new Error("Expected stdio MCP definition");
  return definition.fullCommand;
}

const renderBothEnv = {
  NODE_ENV: "production",
  AGENT_SANDBOX_PROVIDER: "render",
  AGENT_BROWSER_AUTONOMY: "both",
  AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
};

describe("Render shared Chromium MCP configuration", () => {
  it("attaches both reviewed browser MCPs to one CDP endpoint with structured process options", () => {
    const definitions = parseV2McpDefinitions(undefined, renderBothEnv);

    expect(definitions.map((item) => item.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    const playwrightCommand = stdioCommand(definitions[0]);
    const puppeteerCommand = stdioCommand(definitions[1]);
    expect(playwrightCommand).toContain(
      "--cdp-endpoint=http://127.0.0.1:9222",
    );
    expect(puppeteerCommand).toContain(
      "--browser-url=http://127.0.0.1:9222",
    );
    expect(playwrightCommand).toContain("node_modules/.bin/playwright-mcp");
    expect(puppeteerCommand).toContain("node_modules/.bin/chrome-devtools-mcp");
    expect(playwrightCommand).not.toContain("NODE_OPTIONS=");
    expect(puppeteerCommand).not.toContain("NODE_OPTIONS=");
    expect(playwrightCommand).not.toContain("npx ");
    expect(puppeteerCommand).not.toContain("npx ");
    expect(playwrightCommand).not.toContain("'");
    expect(puppeteerCommand).not.toContain("'");

    const playwrightSpec = builtInBrowserMcpProcessSpec(
      "Playwright Browser",
      renderBothEnv,
    );
    const puppeteerSpec = builtInBrowserMcpProcessSpec(
      "Puppeteer DevTools",
      renderBothEnv,
    );
    expect(playwrightSpec).not.toBeNull();
    expect(puppeteerSpec).not.toBeNull();
    expect(playwrightSpec?.command).toContain("node_modules/.bin/playwright-mcp");
    expect(playwrightSpec?.args).toEqual([
      "--cdp-endpoint=http://127.0.0.1:9222",
    ]);
    expect(playwrightSpec?.env.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(puppeteerSpec?.command).toContain("node_modules/.bin/chrome-devtools-mcp");
    expect(puppeteerSpec?.args).toEqual([
      "--browser-url=http://127.0.0.1:9222",
      "--no-usage-statistics",
    ]);
    expect(puppeteerSpec?.env.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(JSON.stringify(playwrightSpec?.env)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(playwrightSpec?.env)).not.toContain("ADMIN_PASSWORD");
  });

  it("keeps direct browser launch when only one MCP is enabled", () => {
    const playwrightEnv = {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      AGENT_BROWSER_AUTONOMY: "playwright",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    };
    const puppeteerEnv = {
      NODE_ENV: "production",
      AGENT_SANDBOX_PROVIDER: "render",
      AGENT_BROWSER_AUTONOMY: "puppeteer",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    };
    const playwright = parseV2McpDefinitions(undefined, playwrightEnv);
    const puppeteer = parseV2McpDefinitions(undefined, puppeteerEnv);

    const playwrightCommand = stdioCommand(playwright[0]);
    const puppeteerCommand = stdioCommand(puppeteer[0]);
    expect(playwrightCommand).toContain("--executable-path /usr/bin/chromium");
    expect(puppeteerCommand).toContain("--executablePath /usr/bin/chromium");
    expect(playwrightCommand).not.toContain("NODE_OPTIONS=");
    expect(puppeteerCommand).not.toContain("NODE_OPTIONS=");

    const playwrightSpec = builtInBrowserMcpProcessSpec(
      "Playwright Browser",
      playwrightEnv,
    );
    const puppeteerSpec = builtInBrowserMcpProcessSpec(
      "Puppeteer DevTools",
      puppeteerEnv,
    );
    expect(playwrightSpec?.args).toContain("--executable-path");
    expect(playwrightSpec?.args).toContain("/usr/bin/chromium");
    expect(puppeteerSpec?.args).toContain("--executablePath");
    expect(puppeteerSpec?.args).toContain("/usr/bin/chromium");
    expect(playwrightSpec?.env.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(puppeteerSpec?.env.NODE_OPTIONS).toBe("--max-old-space-size=96");
  });
});
