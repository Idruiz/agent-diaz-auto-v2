import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseV2McpDefinitions } from "../v2/mcp-runtime.js";

type StdioDefinition = Extract<
  ReturnType<typeof parseV2McpDefinitions>[number],
  { transport: "stdio" }
>;

function stdioDefinition(
  definition: ReturnType<typeof parseV2McpDefinitions>[number] | undefined,
): StdioDefinition {
  expect(definition?.transport).toBe("stdio");
  if (!definition || definition.transport !== "stdio")
    throw new Error("Expected stdio MCP definition");
  return definition;
}

function runtimeEnv(
  mode: "both" | "playwright" | "puppeteer",
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AGENT_SANDBOX_PROVIDER: "render",
    AGENT_BROWSER_AUTONOMY: mode,
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    PATH: process.env.PATH,
    HOME: process.env.HOME || "/tmp",
    LANG: process.env.LANG,
    OPENAI_API_KEY: "must-not-reach-browser-mcp",
    ADMIN_PASSWORD: "must-not-reach-browser-mcp",
  };
}

describe("Render shared Chromium MCP configuration", () => {
  it("attaches both reviewed browser MCPs with structured executable/argv/env", () => {
    const definitions = parseV2McpDefinitions(undefined, runtimeEnv("both"));

    expect(definitions.map((item) => item.name)).toEqual([
      "Playwright Browser",
      "Puppeteer DevTools",
    ]);
    const playwright = stdioDefinition(definitions[0]);
    const puppeteer = stdioDefinition(definitions[1]);

    expect(playwright.command).toMatch(/node_modules[\\/]\.bin[\\/]playwright-mcp$/);
    expect(puppeteer.command).toMatch(
      /node_modules[\\/]\.bin[\\/]chrome-devtools-mcp$/,
    );
    expect(playwright.args).toEqual([
      "--cdp-endpoint=http://127.0.0.1:9222",
    ]);
    expect(puppeteer.args).toEqual([
      "--browser-url=http://127.0.0.1:9222",
      "--no-usage-statistics",
    ]);
    expect(playwright.env?.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(puppeteer.env?.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(playwright.env?.PATH).toBe(process.env.PATH);
    expect(puppeteer.env?.PATH).toBe(process.env.PATH);
    expect(playwright.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(playwright.env).not.toHaveProperty("ADMIN_PASSWORD");
    expect(puppeteer.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(puppeteer.env).not.toHaveProperty("ADMIN_PASSWORD");
    expect(playwright).not.toHaveProperty("fullCommand");
    expect(puppeteer).not.toHaveProperty("fullCommand");
    expect(playwright.command).not.toContain("npx");
    expect(puppeteer.command).not.toContain("npx");
  });

  it("keeps every single-browser argument as a real argv element", () => {
    const playwright = stdioDefinition(
      parseV2McpDefinitions(undefined, runtimeEnv("playwright"))[0],
    );
    const puppeteer = stdioDefinition(
      parseV2McpDefinitions(undefined, runtimeEnv("puppeteer"))[0],
    );

    expect(playwright.args).toEqual([
      "--headless",
      "--isolated",
      "--no-sandbox",
      "--executable-path",
      "/usr/bin/chromium",
    ]);
    expect(puppeteer.args).toEqual([
      "--headless",
      "--isolated",
      "--executablePath",
      "/usr/bin/chromium",
      "--chromeArg=--no-sandbox",
      "--chromeArg=--disable-dev-shm-usage",
      "--no-usage-statistics",
    ]);
    expect(playwright.env?.NODE_OPTIONS).toBe("--max-old-space-size=96");
    expect(puppeteer.env?.NODE_OPTIONS).toBe("--max-old-space-size=96");
  });

  it("spawns the exact configured browser MCP executables without a shell", () => {
    const definitions = parseV2McpDefinitions(undefined, runtimeEnv("both"));

    for (const item of definitions) {
      const definition = stdioDefinition(item);
      const result = spawnSync(
        definition.command,
        [...definition.args, "--help"],
        {
          cwd: definition.cwd,
          env: definition.env,
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(
        result.error,
        `${definition.name} failed to spawn: ${String(result.error)}`,
      ).toBeUndefined();
      expect(
        result.status,
        `${definition.name} exited ${String(result.status)}: ${result.stderr || result.stdout}`,
      ).toBe(0);
    }
  });

  it("normalizes legacy fullCommand config before it reaches MCPServerStdio", () => {
    const [definition] = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "stdio",
          name: "Legacy test MCP",
          fullCommand: "node 'script with spaces.js' --flag=ok",
        },
      ]),
      { NODE_ENV: "test", AGENT_BROWSER_AUTONOMY: "off" },
    );
    const stdio = stdioDefinition(definition);
    expect(stdio.command).toBe("node");
    expect(stdio.args).toEqual(["script with spaces.js", "--flag=ok"]);
    expect(stdio).not.toHaveProperty("fullCommand");
  });
});
