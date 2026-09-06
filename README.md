# JEFE//AUTO

JEFE//AUTO is the independent agentic successor to Agent Díaz. It keeps the durable conversational workbench, personas, voice, uploads, research, artifact builders, validation, and downloads while moving artifact work into a modern tool-using agent harness with a real workspace, browser autonomy, MCP, revision, and explicit acceptance of validated output.

This repository is deliberately separate from the operational deterministic Agent Díaz repository. Changes here do not alter that deployment.

## What ships

- Durable streaming conversations with conversation history, retry/stop behavior, visible job state, uploads, approvals, and persistent context.
- Seven selectable personas with shared factual continuity: **Díaz, Javier, Karen, Vega, Mara, Luz, and Salcedo**.
- Realtime/voice interaction preserved from Agent Díaz.
- OpenAI Agents SDK orchestration with a filesystem workspace, shell/code execution, hosted web research, MCP tools, cancellation, tracing-compatible execution, and restart recovery.
- Multi-MCP support through Streamable HTTP and reviewed stdio servers.
- Built-in autonomous browser tools:
  - **Playwright Browser** via pinned `@playwright/mcp`.
  - **Puppeteer DevTools** via pinned `chrome-devtools-mcp` (Puppeteer-backed Chrome DevTools automation/inspection).
  - **Puppeteer** installed directly for programmatic browser work.
- Production Chromium in the Docker image. Browser MCPs use isolated browser profiles.
- Sandbox selection for Cloudflare-hosted sandbox, Docker sandbox, or Unix-local development mode. Production refuses an unsafe Unix-local agent shell unless explicitly overridden.
- Artifact revision loop: build the real artifact, validate it, return diagnostic evidence to the agent, revise, rebuild, and continue until a validated artifact is explicitly accepted.
- Persisted revision history, latest-plan recovery, stagnation detection, and restart-safe retries for transient infrastructure failures.
- Existing deterministic renderers and validators retained as reliable tools underneath the agent rather than as the orchestration brain.
- Presentations retain PPTX delivery plus PDF and browser-HTML companion exports.
- DOCX documents and portable multi-page website ZIPs remain supported.
- `/healthz` for process health and `/readyz` for V2 runtime/deployment readiness.

## Product identity

JEFE//AUTO uses a light interface with cobalt/indigo accents and self-hosted **Orbitron** display typography. Conversation text remains in a highly readable system sans-serif. Neon green is intentionally excluded from the interface.

## Browser autonomy

Browser autonomy is on by default outside the test environment.

```env
AGENT_BROWSER_AUTONOMY=both
AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
```

Supported values for `AGENT_BROWSER_AUTONOMY`:

- `both` — Playwright MCP + Puppeteer-backed Chrome DevTools MCP
- `playwright` — Playwright MCP only
- `puppeteer` — Chrome DevTools MCP only
- `off` — disable built-in browser MCPs

The built-in browser servers are pinned and reviewed. Arbitrary custom stdio MCP commands remain blocked in production unless `AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true` is explicitly set after review.

## Production sandbox

Preferred production isolation is a hosted Cloudflare Sandbox bridge:

```env
AGENT_RUNTIME=v2
AGENT_SANDBOX_PROVIDER=cloudflare
CLOUDFLARE_SANDBOX_WORKER_URL=https://your-sandbox-worker.example.workers.dev
CLOUDFLARE_SANDBOX_API_KEY=...
```

Docker sandbox execution is also supported:

```env
AGENT_SANDBOX_PROVIDER=docker
```

Unix-local execution is intended for development. Production fails closed unless an explicit emergency override is supplied.

## Core requirements

- Node.js 22.12 or newer, or Docker.
- OpenAI API key with access to the configured models/tools.
- A unique owner passphrase of at least 16 characters.
- HTTPS for production.
- Durable `STORAGE_DIR` for conversations, uploads, jobs, revision state, and artifacts.

## Local start

```bash
cp .env.example .env
# Set OPENAI_API_KEY and ADMIN_PASSWORD.
npm ci
npm run verify
npm run dev
```

Open `http://localhost:5173`; Vite proxies the API to port 3000.

## Docker start

```bash
cp .env.example .env
# Configure OPENAI_API_KEY, ADMIN_PASSWORD, BASE_URL, and sandbox settings.
docker compose up --build -d
```

## Verification

```bash
npm run verify
```

The GitHub `Verify` workflow goes further: it installs Office render validators, runs the complete application gate, rebuilds the containerized artifact golden matrix, reproduces the exact presentation route, builds the production image, verifies both browser MCP CLIs are present, and launches system Chromium through Puppeteer inside the final production container.

## Architecture

```text
React conversational UI + personas + voice + uploads
  -> authenticated Express API
     -> OpenAI Agents SDK harness
        -> sandbox filesystem / shell / code
        -> hosted web research
        -> Playwright MCP
        -> Puppeteer-backed Chrome DevTools MCP
        -> optional HTTP / reviewed stdio MCP servers
        -> deterministic artifact builders + validators
           -> build real artifact
           -> inspect validation/diagnostic evidence
           -> revise plan/workspace
           -> rebuild and revalidate
           -> explicit validated-artifact acceptance
     -> SQLite durable conversations, messages, jobs, approvals, revision/retry state
     -> authenticated artifact downloads
```

## Security boundary

- Never commit `.env`, credentials, tokens, databases, generated artifacts, uploads, or `node_modules`.
- Keep custom stdio MCP disabled in production unless its command and package supply chain have been reviewed.
- Treat remote MCP/browser content as untrusted input and preserve approval requirements for consequential external writes.
- Prefer Cloudflare or Docker sandbox isolation for agent shell/filesystem work in production.
- The production container runs as a non-root application user.

See `JEFE_AUTO_ARCHITECTURE.md` and `AGENT_DIAZ_V2_ARCHITECTURE.md` for implementation details and migration context.


## Canonical production filesystem boundary

For production V2 jobs, Cloudflare Sandbox is the execution plane. `/workspace` is a real Linux filesystem and the Worker mounts the `JEFE_FS` R2 binding at `/workspace/persist` with a per-job prefix. The Worker performs a POSIX create/test/rename/read/delete sentinel before reporting setup success.

Playwright MCP and Puppeteer-backed Chrome DevTools MCP are launched **inside that same Cloudflare sandbox**, then exposed to the Render control plane only through authenticated Worker proxy routes. There are no public quick tunnels and no second browser filesystem on Render. Direct Puppeteer is installed in the same container as well.

This R2 mount is for agent workspace persistence. It is intentionally **not** used as a SQLite filesystem: Render's application database/storage remains a separate durability concern until it is migrated to a database-safe remote store.

See `cloudflare-sandbox/README.md` for deployment steps.
