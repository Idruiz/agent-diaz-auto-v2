# JEFE//AUTO — autonomous Agent Díaz V2

JEFE//AUTO is the independent 2026 agentic successor to the deterministic Agent Díaz deployment. It preserves the full conversation, persona, voice, file, artifact, validation, PDF/HTML/PPTX and persistence surface while moving autonomous work into a real tool-using agent harness.

## Browser autonomy

- **Playwright Browser**: official `@playwright/mcp` server, pinned in the application dependency graph.
- **Puppeteer DevTools**: `chrome-devtools-mcp`, which is Puppeteer-backed and adds DOM, console, network, screenshot and performance inspection.
- **Puppeteer package**: installed explicitly for programmatic browser work and production smoke verification.
- `AGENT_BROWSER_AUTONOMY=both` is the normal default outside tests; `playwright`, `puppeteer`, or `off` are supported.
- Production images contain system Chromium at `/usr/bin/chromium`; both MCP servers use isolated browser profiles.

## Product identity

The UI uses a light cobalt/indigo system with Orbitron display typography and readable system body typography. Neon green is intentionally excluded. The full Díaz/Javier/Karen/Vega/Mara/Luz/Salcedo persona system remains shared across conversations.
