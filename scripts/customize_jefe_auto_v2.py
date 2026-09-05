from pathlib import Path
import json

root = Path('.')

# Product identity and package metadata.
pkg_path = root / 'package.json'
pkg = json.loads(pkg_path.read_text())
pkg['name'] = 'agent-diaz-auto-v2'
pkg['version'] = '4.0.0'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n')

# UI identity while preserving the complete conversation/persona surface.
main_path = root / 'src/web/main.tsx'
main = main_path.read_text()
font_imports = 'import "@fontsource/orbitron/600.css";\nimport "@fontsource/orbitron/700.css";\nimport "@fontsource/orbitron/800.css";\n'
if '@fontsource/orbitron/600.css' not in main:
    main = main.replace('import React, { useEffect, useMemo, useRef, useState } from "react";\n', 'import React, { useEffect, useMemo, useRef, useState } from "react";\n' + font_imports, 1)
replacements = {
    '<div className="seal">D</div>': '<div className="seal">JA</div>',
    '<span>D</span>': '<span>JA</span>',
    'REVIVED • SECURE • 2026': 'AUTONOMOUS • TOOL-USING • 2026',
    '<h1>Agent Díaz</h1>': '<h1>JEFE//AUTO</h1>',
    'Your private conversational and artifact workbench.': 'Your autonomous conversational, browser, and artifact workbench.',
    'Waking Agent Díaz…': 'Waking JEFE//AUTO…',
    '<strong>Agent Díaz</strong>': '<strong>JEFE//AUTO</strong>',
    '<small>Persistent memory</small>': '<small>Persistent agent memory</small>',
    'PRIVATE AGENT WORKSPACE': 'AUTONOMOUS AGENT WORKSPACE',
    'Download Agent Díaz icon': 'Download JEFE//AUTO icon',
}
for old, new in replacements.items():
    main = main.replace(old, new)
main_path.write_text(main)

index_path = root / 'src/web/index.html'
index = index_path.read_text()
index = index.replace('Agent Díaz Revived', 'JEFE//AUTO')
index = index.replace('Agent Díaz', 'JEFE//AUTO')
index_path.write_text(index)

# Built-in Playwright + Puppeteer-backed Chrome DevTools MCP autonomy.
mcp_path = root / 'src/server/v2/mcp-runtime.ts'
mcp = mcp_path.read_text()
if 'BUILTIN_BROWSER_MCP_NAMES' not in mcp:
    marker = 'export interface V2McpRuntime {\n'
    insert = '''const BUILTIN_BROWSER_MCP_NAMES = new Set([\n  "Playwright Browser",\n  "Puppeteer DevTools",\n]);\n\nfunction shellQuote(value: string): string {\n  return `'${value.replaceAll("'", `'\\"'\\"'`)}'`;\n}\n\nfunction builtInBrowserDefinitions(\n  env: NodeJS.ProcessEnv = process.env,\n): V2McpDefinitions {\n  const rawMode =\n    env.AGENT_BROWSER_AUTONOMY?.trim().toLocaleLowerCase() ||\n    (env.NODE_ENV === "test" ? "off" : "both");\n  if (["off", "none", "false", "0"].includes(rawMode)) return [];\n  if (!["both", "playwright", "puppeteer"].includes(rawMode))\n    throw new Error(\n      "AGENT_BROWSER_AUTONOMY must be both, playwright, puppeteer, or off",\n    );\n  const executable =\n    env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";\n  const definitions: V2McpDefinitions = [];\n  if (rawMode === "both" || rawMode === "playwright")\n    definitions.push({\n      transport: "stdio",\n      name: "Playwright Browser",\n      fullCommand: `npx --no-install @playwright/mcp --headless --isolated --executable-path ${shellQuote(executable)}`,\n    });\n  if (rawMode === "both" || rawMode === "puppeteer")\n    definitions.push({\n      transport: "stdio",\n      name: "Puppeteer DevTools",\n      fullCommand: `npx --no-install chrome-devtools-mcp --headless --isolated --executable-path ${shellQuote(executable)} --no-usage-statistics`,\n    });\n  return definitions;\n}\n\n'''
    mcp = mcp.replace(marker, insert + marker, 1)

    start = mcp.index('export function parseV2McpDefinitions(')
    end = mcp.index('export function assertV2McpEnvironmentSafe(', start)
    parse_impl = '''export function parseV2McpDefinitions(\n  raw: string | undefined,\n  env: NodeJS.ProcessEnv = process.env,\n): V2McpDefinitions {\n  let parsed: unknown = [];\n  if (raw?.trim()) {\n    try {\n      parsed = JSON.parse(raw);\n    } catch (error) {\n      throw new Error(\n        `MCP_SERVERS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,\n      );\n    }\n  }\n  const result = McpDefinitionsSchema.safeParse(parsed);\n  if (!result.success)\n    throw new Error(\n      `MCP_SERVERS_JSON failed validation: ${result.error.issues\n        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)\n        .join("; ")}`,\n    );\n  return uniqueDefinitions(\n    McpDefinitionsSchema.parse([\n      ...result.data,\n      ...builtInBrowserDefinitions(env),\n    ]),\n  );\n}\n\n'''
    mcp = mcp[:start] + parse_impl + mcp[end:]

    old_guard = '''  if (\n    env.NODE_ENV === "production" &&\n    definitions.some((definition) => definition.transport === "stdio") &&\n    !enabled(env.AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION)\n  )\n    throw new Error(\n      "Agent Díaz V2 refuses host-level stdio MCP processes in production by default. Use Streamable HTTP MCP servers, or explicitly set AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true after reviewing the commands.",\n    );\n'''
    new_guard = '''  const unreviewedStdio = definitions.filter(\n    (definition) =>\n      definition.transport === "stdio" &&\n      !BUILTIN_BROWSER_MCP_NAMES.has(definition.name),\n  );\n  if (\n    env.NODE_ENV === "production" &&\n    unreviewedStdio.length > 0 &&\n    !enabled(env.AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION)\n  )\n    throw new Error(\n      "JEFE//AUTO refuses unreviewed host-level stdio MCP processes in production. Built-in pinned browser MCPs are allowed; custom stdio MCPs require AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true after review.",\n    );\n'''
    assert old_guard in mcp, 'MCP production safety guard anchor missing'
    mcp = mcp.replace(old_guard, new_guard, 1)
    mcp = mcp.replace('const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON);', 'const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON, env);', 1)
    mcp_path.write_text(mcp)

readiness_path = root / 'src/server/v2/runtime-readiness.ts'
readiness = readiness_path.read_text()
readiness = readiness.replace('const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON);', 'const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON, env);')
readiness_path.write_text(readiness)

# V2 browser/runtime contract tests.
test_path = root / 'src/server/__tests__/agent-v2-runtime.test.ts'
test = test_path.read_text()
test = test.replace('name: "Playwright MCP",\n          fullCommand: "npx @playwright/mcp@latest --headless",', 'name: "Custom Browser MCP",\n          fullCommand: "node custom-browser-mcp.js",')
anchor = '  it("prefers the hosted Cloudflare sandbox whenever a bridge URL is configured", () => {'
if 'loads Playwright and Puppeteer browser MCPs as built-in autonomous tools' not in test:
    browser_test = '''  it("loads Playwright and Puppeteer browser MCPs as built-in autonomous tools", () => {\n    const definitions = parseV2McpDefinitions(undefined, {\n      NODE_ENV: "production",\n      AGENT_BROWSER_AUTONOMY: "both",\n      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",\n    });\n    expect(definitions.map((definition) => definition.name)).toEqual([\n      "Playwright Browser",\n      "Puppeteer DevTools",\n    ]);\n    expect(definitions.every((definition) => definition.transport === "stdio")).toBe(true);\n    expect(definitions[0]?.fullCommand).toContain("@playwright/mcp");\n    expect(definitions[1]?.fullCommand).toContain("chrome-devtools-mcp");\n    expect(() =>\n      assertV2McpEnvironmentSafe(definitions, { NODE_ENV: "production" }),\n    ).not.toThrow();\n  });\n\n'''
    assert anchor in test, 'V2 test insertion anchor missing'
    test = test.replace(anchor, browser_test + anchor, 1)
test_path.write_text(test)

# Production image carries Chromium. Puppeteer uses the system browser; package install skips its own browser download.
docker_path = root / 'Dockerfile'
docker = docker_path.read_text()
docker = docker.replace('FROM node:22-bookworm-slim AS regression\nWORKDIR /app\n', 'FROM node:22-bookworm-slim AS regression\nENV PUPPETEER_SKIP_DOWNLOAD=true\nWORKDIR /app\n', 1)
docker = docker.replace('FROM node:22-bookworm-slim AS build\nWORKDIR /app\n', 'FROM node:22-bookworm-slim AS build\nENV PUPPETEER_SKIP_DOWNLOAD=true\nWORKDIR /app\n', 1)
runtime_apt = 'fontconfig fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito libreoffice-impress-nogui libreoffice-writer-nogui poppler-utils'
docker = docker.replace(runtime_apt, runtime_apt + ' chromium')
docker_path.write_text(docker)

# Runtime defaults / documentation.
env_path = root / '.env.example'
env_text = env_path.read_text()
block = '''\n# JEFE//AUTO autonomous browser tools\n# both = official Playwright MCP + Puppeteer-backed Chrome DevTools MCP\nAGENT_BROWSER_AUTONOMY=both\nAGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium\n# Custom (non-built-in) stdio MCPs still require an explicit production review override.\n# AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true\n'''
if 'AGENT_BROWSER_AUTONOMY=' not in env_text:
    env_text += block
env_path.write_text(env_text)

# Light interface: Orbitron identity, cool cobalt/indigo palette, explicitly no neon green.
styles_path = root / 'src/web/styles.css'
styles = styles_path.read_text().replace('#57d795', '#536edb')
light_overrides = r'''\n\n/* JEFE//AUTO — light autonomous interface */\n:root {\n  --jefe-bg: #f6f8fc;\n  --jefe-panel: #ffffff;\n  --jefe-rail: #eef2f8;\n  --jefe-ink: #171b28;\n  --jefe-muted: #657087;\n  --jefe-line: #d8deea;\n  --jefe-accent: #3156d3;\n  --jefe-accent-2: #6d5bd0;\n  --jefe-soft: #e8edff;\n  --jefe-danger: #b94b5c;\n  color: var(--jefe-ink);\n  background: var(--jefe-bg);\n}\nbody { background: var(--jefe-bg); color: var(--jefe-ink); }\n.boot { background: var(--jefe-bg); color: var(--jefe-accent); font-family: "Orbitron", ui-sans-serif, system-ui; font-weight: 700; letter-spacing: .08em; }\n.login { background: radial-gradient(circle at 50% 8%, #e5eaff 0, #f6f8fc 52%, #edf1f7 100%); color: var(--jefe-ink); }\n.login form { background: rgba(255,255,255,.96); border-color: var(--jefe-line); box-shadow: 0 28px 80px rgba(39,53,94,.14); }\n.login h1, .workspace h1, .emptyState h2, .brand strong { font-family: "Orbitron", ui-sans-serif, system-ui; letter-spacing: .03em; color: var(--jefe-ink); }\n.login h1 { font-size: clamp(2.1rem, 5vw, 4.2rem); }\n.seal, .brand > span { background: linear-gradient(145deg, var(--jefe-accent), var(--jefe-accent-2)); color: #fff; font-family: "Orbitron", ui-sans-serif, system-ui; border-radius: 14px; box-shadow: 0 10px 24px rgba(49,86,211,.22); }\n.eyebrow { color: var(--jefe-accent); font-family: "Orbitron", ui-sans-serif, system-ui; letter-spacing: .14em; }\n.login input { background: #fff; color: var(--jefe-ink); border-color: #c9d1e1; }\n.login input:focus { border-color: var(--jefe-accent); box-shadow: 0 0 0 3px rgba(49,86,211,.12); }\n.login button, .run, .approval button { background: var(--jefe-accent); color: #fff; box-shadow: 0 8px 18px rgba(49,86,211,.18); }\n.shell { background: var(--jefe-bg); }\n.rail { background: var(--jefe-rail); border-right-color: var(--jefe-line); }\n.brand small, .rail nav small, .artifacts small { color: var(--jefe-muted); }\n.new { border-color: #9aa9da; color: var(--jefe-accent); background: rgba(255,255,255,.65); font-weight: 750; }\n.new:hover { background: var(--jefe-soft); }\n.rail nav button { color: #343a4d; }\n.rail nav button:hover { background: #e6eaf3; }\n.rail nav button.active { background: #dfe6ff; color: #1f3f9f; box-shadow: inset 3px 0 0 var(--jefe-accent); }\n.dot { background: #9aa5b8; }\n.dot.completed { background: #536edb; }\n.logout, .danger { border-color: #d6a7af; color: #a83f50; background: #fff8f9; }\n.workspace { background: linear-gradient(180deg, #fbfcff 0, var(--jefe-bg) 100%); color: var(--jefe-ink); }\n.workspaceHeader { background: rgba(255,255,255,.88); border-bottom-color: var(--jefe-line); box-shadow: 0 7px 24px rgba(31,43,75,.05); }\n.conversationMeta { color: var(--jefe-muted); }\n.skillsPanel summary, .skillsPanel > div, .artifactCard, .approval, .artifactStatus, .emptyState { background: #fff; color: var(--jefe-ink); border-color: var(--jefe-line); box-shadow: 0 10px 30px rgba(39,53,94,.07); }\n.skillsPanel summary span { background: var(--jefe-soft); color: var(--jefe-accent); }\n.skillsPanel small { color: var(--jefe-muted); }\n.iconDownloads { color: var(--jefe-muted); }\n.iconDownloads a { background: #fff; border-color: #cbd3e3; color: var(--jefe-accent); }\n.iconDownloads a:hover { background: var(--jefe-soft); border-color: var(--jefe-accent); }\n.artifactStatus b, .artifactCard a, .approval b { color: var(--jefe-accent); }\n.artifactStatus code, .artifactCard code { background: #eef2f8; color: #2d3550; }\n.error { color: var(--jefe-danger); }\n''' 
if 'JEFE//AUTO — light autonomous interface' not in styles:
    styles += light_overrides
styles_path.write_text(styles)

chat_path = root / 'src/web/chat.css'
chat = chat_path.read_text().replace('#61763b', '#6d5bd0')
chat_overrides = r'''\n\n/* JEFE//AUTO light conversation surface */\n.conversationToolbar { background: rgba(250,251,255,.94); border-bottom-color: var(--jefe-line); }\n.modeSelector button { color: #69758b; }\n.modeSelector button small, .personaControl small, .voiceNotice small { color: #8792a6; }\n.modeSelector button.active { border-color: #aebaf0; background: #e7ecff; color: #2949b3; }\n.modeSelector button.active small { color: #6675ad; }\n.personaControl > span { color: #69758b; font-family: "Orbitron", ui-sans-serif, system-ui; }\n.personaControl select, .voiceIdentity, .mic, .voiceEnd { border-color: #cbd3e3; background: #fff; color: #293044; }\n.voiceIdentity { color: #68748a; }\n.mic:first-letter { color: var(--jefe-accent); }\n.mic.active { border-color: #c96a78; background: #fff0f2; color: #9d3444; }\n.voiceEnd { border-color: #d8a7af; color: #a34555; }\n.voiceNotice { background: #edf1fb; color: #5e6980; border-bottom: 1px solid var(--jefe-line); }\n.chatWelcome { color: #768197; }\n.chatWelcome h2 { font-family: "Orbitron", ui-sans-serif, system-ui; color: #1c2130; }\n.bubble { background: #fff; border-color: #d8deea; box-shadow: 0 8px 24px rgba(39,53,94,.07); }\n.bubble.user { background: #e7ecff; border-color: #c5d0ff; }\n.bubble.assistant { background: #fff; }\n.bubble.failed { border-color: #d7a1aa; }\n.bubbleLabel { color: var(--jefe-accent); }\n.bubbleLabel span { color: #8290a5; }\n.bubble p, .messageContent { color: #232938; }\n.messageContent a { color: #2d50c7; }\n.messageContent pre, .messageContent code { background: #f0f3f8; color: #222a3b; }\n.messageContent pre { border-color: #d4dae6; }\n.messageContent th, .messageContent td { border-color: #d4dae6; }\n.messageContent blockquote { border-left-color: var(--jefe-accent-2); color: #5f697e; }\n.thinking { color: #748096; }\n.thinking i { background: var(--jefe-accent-2); }\n.messageFiles > span, .pendingFiles > span { background: #f4f6fa; border-color: #d6ddea; color: #2f3749; }\n.messageFiles small, .pendingFiles small { color: #7a879d; }\n.inlineError { color: #a13e4e !important; background: #fff0f2; }\n.bubbleActions button { color: #67748a; }\n.bubbleActions button:hover { color: var(--jefe-accent); }\n.voiceDraft { border-color: #8d7de0; }\n.composerDock { background: linear-gradient(180deg, rgba(246,248,252,0), #f6f8fc 24%); box-shadow: none; }\n.taskPicker button { background: #edf1f7; color: #69758a; }\n.taskPicker button.active { border-color: #aebaf0; color: #2949b3; background: #e4eaff; }\n.recommendation { background: #f4f1ff; border-color: #d3c9fb; color: #574a8b; }\n.recommendation button { color: #4d3db2; }\n.pendingFiles i { color: var(--jefe-accent); }\n.pendingFiles button { color: #768399; }\n.composeBox { background: #fff; border-color: #cfd6e3; box-shadow: 0 12px 32px rgba(39,53,94,.10); }\n.composeBox:focus-within { border-color: var(--jefe-accent); box-shadow: 0 0 0 3px rgba(49,86,211,.12), 0 12px 32px rgba(39,53,94,.10); }\n.composeBox textarea { color: #202637; }\n.attachButton { color: #637087; }\n.attachButton:hover { background: #eef2fb; }\n.sendButton { background: var(--jefe-accent); color: #fff; }\n.stopButton { background: #b94b5c; color: #fff; }\n.composerHint { color: #818da0; }\n''' 
if 'JEFE//AUTO light conversation surface' not in chat:
    chat += chat_overrides
chat_path.write_text(chat)

# UI contract test catches accidental identity/theme regressions.
ui_test = root / 'src/web/jefe-auto-ui.test.ts'
ui_test.write_text('''import fs from "node:fs";\nimport { describe, expect, it } from "vitest";\n\ndescribe("JEFE//AUTO UI contract", () => {\n  it("keeps the autonomous light identity and Orbitron display type", () => {\n    const main = fs.readFileSync("src/web/main.tsx", "utf8");\n    const styles = fs.readFileSync("src/web/styles.css", "utf8");\n    const chat = fs.readFileSync("src/web/chat.css", "utf8");\n    expect(main).toContain("JEFE//AUTO");\n    expect(main).toContain("@fontsource/orbitron/800.css");\n    expect(styles).toContain("--jefe-bg: #f6f8fc");\n    expect(styles).toContain("font-family: \\\"Orbitron\\\"");\n    expect(styles + chat).not.toMatch(/#57d795|#39ff14|#00ff00/i);\n  });\n});\n''')

# Verify workflow follows the independent repo and proves browser execution in the final image.
verify_path = root / '.github/workflows/verify.yml'
verify = verify_path.read_text()
verify = verify.replace('      - variant/agent-diaz-v2\n', '      - "build/**"\n')
production_step = '      - name: Build production container\n        run: docker build --tag agent-diaz-verify:${{ github.sha }} .\n'
browser_smoke = '''      - name: Smoke autonomous browser tools in production container\n        run: |\n          docker run --rm --entrypoint sh agent-diaz-verify:${{ github.sha }} -lc '\n            chromium --version &&\n            npx --no-install @playwright/mcp --help >/dev/null &&\n            npx --no-install chrome-devtools-mcp --help >/dev/null &&\n            node --input-type=module -e "import puppeteer from \\\'puppeteer\\\'; const b=await puppeteer.launch({executablePath:\\\'/usr/bin/chromium\\\',headless:true,args:[\\\'--no-sandbox\\\']}); const p=await b.newPage(); await p.goto(\\\'about:blank\\\'); console.log(await p.title()); await b.close();"\n          '\n'''
assert production_step in verify, 'verify production-container anchor missing'
verify = verify.replace(production_step, production_step + browser_smoke, 1)
verify_path.write_text(verify)

# Architecture note for the independent product line.
arch = root / 'JEFE_AUTO_ARCHITECTURE.md'
arch.write_text('''# JEFE//AUTO — autonomous Agent Díaz V2\n\nJEFE//AUTO is the independent 2026 agentic successor to the deterministic Agent Díaz deployment. It preserves the full conversation, persona, voice, file, artifact, validation, PDF/HTML/PPTX and persistence surface while moving autonomous work into a real tool-using agent harness.\n\n## Browser autonomy\n\n- **Playwright Browser**: official `@playwright/mcp` server, pinned in the application dependency graph.\n- **Puppeteer DevTools**: `chrome-devtools-mcp`, which is Puppeteer-backed and adds DOM, console, network, screenshot and performance inspection.\n- **Puppeteer package**: installed explicitly for programmatic browser work and production smoke verification.\n- `AGENT_BROWSER_AUTONOMY=both` is the normal default outside tests; `playwright`, `puppeteer`, or `off` are supported.\n- Production images contain system Chromium at `/usr/bin/chromium`; both MCP servers use isolated browser profiles.\n\n## Product identity\n\nThe UI uses a light cobalt/indigo system with Orbitron display typography and readable system body typography. Neon green is intentionally excluded. The full Díaz/Javier/Karen/Vega/Mara/Luz/Salcedo persona system remains shared across conversations.\n''')

print('JEFE//AUTO V2 customization applied')
