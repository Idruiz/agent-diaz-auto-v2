# JEFE//AUTO Cloudflare execution plane

This Worker is the production sandbox bridge for JEFE//AUTO. It extends the official Cloudflare Sandbox bridge with three authenticated capabilities:

1. Mount the `JEFE_FS` R2 binding at `/workspace/persist` using a per-job prefix.
2. Prove the mount with ordinary POSIX shell operations before an agent run is admitted.
3. Start Playwright MCP and Puppeteer-backed Chrome DevTools MCP **inside the same Linux sandbox** and proxy their Streamable HTTP transports through the authenticated Worker.

The agent therefore gets one filesystem namespace:

- `/workspace` — fast sandbox-local Linux filesystem.
- `/workspace/persist` — R2-backed filesystem mount that survives sandbox destruction.
- Playwright, Chromium, Chrome DevTools MCP, Puppeteer scripts and shell commands all run in that same container and see both paths.

## Required Cloudflare setup

Cloudflare Sandbox/Containers currently requires Workers Paid. R2 usage is billed separately and may remain within R2's free allowance.

Create the R2 bucket once:

```bash
npx wrangler r2 bucket create jefe-auto-fs
```

Set one high-entropy bridge secret (never commit it):

```bash
openssl rand -hex 32
npx wrangler secret put SANDBOX_API_KEY
```

Deploy from this directory:

```bash
npm ci
npm run typecheck
npm run verify:contract
npm run deploy
```

Put the resulting Worker URL and the same raw secret in Render as `CLOUDFLARE_SANDBOX_WORKER_URL` and `CLOUDFLARE_SANDBOX_API_KEY`. JEFE//AUTO adds `Bearer ` itself.

`standard-1` is deliberately selected for Chromium (4 GiB memory). `max_instances` and the warm pool are both constrained to avoid surprise concurrency costs while proving production.
