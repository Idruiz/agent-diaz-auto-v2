# JEFE//AUTO Cloudflare execution plane

This Worker is the production sandbox bridge for JEFE//AUTO. It extends the official Cloudflare Sandbox bridge with three authenticated capabilities:

1. Resolve every JEFE route through the official warm-pool assignment so shell work, browser MCPs, and cleanup target the **same container**.
2. Restore `/workspace/persist` from the `JEFE_FS` R2 bucket at setup and checkpoint it back to R2 at release, without FUSE.
3. Start Playwright MCP and Puppeteer-backed Chrome DevTools MCP inside that same Linux sandbox and proxy their Streamable HTTP transports through the authenticated Worker.

The agent therefore gets one filesystem namespace:

- `/workspace` — fast sandbox-local Linux filesystem.
- `/workspace/persist` — ordinary POSIX storage checkpointed to R2 between jobs.
- Playwright, Chromium, Chrome DevTools MCP, Puppeteer scripts and shell commands all run in the same pool-tracked container.

Containers are **not** pinned with `setKeepAlive(true)`. Real activity renews the normal container idle timer, so a crashed or cancelled Render caller cannot hold a Cloudflare slot forever.

## Required Cloudflare setup

Cloudflare Sandbox/Containers requires Workers Paid. R2 usage is billed separately and may remain within R2's free allowance.

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

`standard-1` is deliberately selected for Chromium (4 GiB memory). `max_instances` is capped at 4. The warm target remains 0 for the low-cost MVP; containers start on demand and idle out when work stops.
