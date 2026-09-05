# Agent Díaz 3.2

Agent Díaz is a private, single-owner AI workbench for durable conversations, cited research, uploaded-file analysis, visual document production, presentations, and portable multi-page websites.

This repository is the complete application source. It does not contain credentials, generated artifacts, databases, or dependencies.

## Production capabilities

- Streaming Responses API chat with immediate user messages, inline thinking, stop, retry, and durable delivery state.
- Per-conversation Quick (`gpt-5.6-luna` + light), Balanced (`gpt-5.6-terra` + medium), and Deep (`gpt-5.6-sol` + high) modes.
- Six durable, selectable personas: Díaz, Javier, Vega, Mara, Luz, and Salcedo. Each has a distinct reasoning style, written voice, Realtime voice, and spoken delivery.
- One shared factual memory across personas, with per-response persona provenance and explicit protection against promoting persona performance into autobiographical facts.
- Background execution, polling, cancellation, approval continuation, and restart recovery for artifact jobs.
- Full durable context inside each conversation.
- Five recent conversations retain full transcripts; older conversations are summarized and archived read-only.
- Archived summaries can inform later conversations without replaying raw transcripts.
- Explicit anti-repetition and continuity instructions.
- Hosted web search for research and fact-grounded artifacts.
- Message-level image and document inputs, with visible upload/read failures instead of silent attachment loss.
- Automatic Code Interpreter routing for spreadsheets plus explicit analytical jobs.
- Android-safe voice turns use short-lived WebRTC credentials and `gpt-realtime-2.1-mini` for transcription only. The exact transcript then enters the same persona-enforced Responses chat used by typed messages, and OpenAI TTS reads the complete canonical answer in ordered chunks. Tuned server VAD sends after a pause; a visible Send control can manually commit; partial transcripts and failures are surfaced instead of disappearing. Browser speech synthesis is never used.
- Server-owned persona voices: Díaz/Cedar, Javier/Echo, Vega/Sage, Mara/Ash, Luz/Coral, and Salcedo/Marin.
- Visual PPTX files with editable text/tables/diagram primitives, rendered evidence charts, notes, sources, and licensed photography when requested. Presentation content is compiled into render-safe slide budgets before serialization.
- Visual DOCX files with editable tables, rendered charts/diagrams, structured prose, sources, and licensed photography when requested.
- Three-to-six-page website ZIPs with responsive navigation, inline SVG visualizations, tables, one shared stylesheet, and deduplicated local licensed Wikimedia image assets.
- `OPEN_ME_FIRST.html` in every website ZIP. Keep the ZIP contents together when extracting because pages reference the bundled shared stylesheet and image assets.
- Generic remote MCP support with exact per-call approval capture, durable decisions, and Responses continuation.
- Owner authentication, HTTP-only cookies, same-origin mutation protection, contained paths, upload limits, and secret-redacted logs.
- SQLite persistence for sessions, conversations, messages, jobs, approvals, uploads, and artifacts.
- One-root durable storage for SQLite, uploads, and artifacts, with an authenticated write/readiness probe.
- Docker, Compose, runtime health checks, automated tests, GitHub Actions verification, and manual deployment tooling.

## Honest boundaries

- No specific Gmail, Calendar, Drive, Slack, or Notion connector is bundled. One trusted remote MCP server can be configured through environment variables.
- The application does not implement OAuth. If the selected MCP server requires authorization, supply and rotate its token securely through the deployment environment.
- Approval continuation is implemented, but the selected MCP server and its exact tools must be integration-tested with your account before consequential production use.
- Research and analysis artifacts are DOCX. Native XLSX/PDF export, infographic/video generation, image generation, and automatic website publishing are not included.
- Voice turns persist through the same canonical job/message path as typed chat. Raw microphone audio is never stored by this application, and client lifecycle logs omit transcript contents.
- This is single-owner software. Multi-user use requires identity-provider login and per-resource authorization.

## Requirements

- Node.js 22.5 or newer, or Docker.
- OpenAI API key with access to the configured models and tools.
- A unique owner passphrase of at least 16 characters.
- HTTPS reverse proxy for production.

## Local start

```bash
cp .env.example .env
# Set OPENAI_API_KEY and ADMIN_PASSWORD in .env
npm ci
npm run verify
npm run dev
```

Open `http://localhost:5173`. Vite proxies API requests to port 3000.

## Docker start

```bash
cp .env.example .env
# Set OPENAI_API_KEY, ADMIN_PASSWORD and BASE_URL in .env
docker compose up --build -d
```

Open the `BASE_URL` you configured. The Compose volumes preserve the database, artifacts, and uploads across container replacement.

## Direct production start

```bash
npm ci
npm run verify
NODE_ENV=production npm start
```

Set `BASE_URL` to the exact public HTTPS origin. For production persistence, set `STORAGE_DIR` to one mounted directory and back up that directory as a unit.

## Environment

| Variable                |   Required | Purpose                                                              |
| ----------------------- | ---------: | -------------------------------------------------------------------- |
| `OPENAI_API_KEY`        |        Yes | Server-side API access                                               |
| `ADMIN_PASSWORD`        |        Yes | Single-owner login, minimum 16 characters                            |
| `BASE_URL`              | Production | Exact allowed origin, such as `https://diaz.example.com`             |
| `OPENAI_MODEL`          |         No | Compatibility fallback for pre-3.1 jobs; defaults to `gpt-5.6`       |
| `OPENAI_FAST_MODEL`     |         No | Conversation compaction model; defaults to `gpt-5.6-terra`           |
| `OPENAI_REALTIME_MODEL` |         No | Cost-controlled voice model; defaults to `gpt-realtime-2.1-mini`     |
| `STORAGE_DIR`           | Production | One persistent root containing `data/`, `uploads/`, and `artifacts/` |
| `PORT`                  |         No | HTTP port; defaults to `3000`                                        |
| `MAX_UPLOAD_MB`         |         No | Per-file limit, 1–100 MB                                             |
| `MCP_SERVER_URL`        |         No | Trusted Streamable HTTP or HTTP/SSE MCP endpoint                     |
| `MCP_SERVER_LABEL`      |         No | Stable MCP server label                                              |
| `MCP_AUTHORIZATION`     |         No | Server-side bearer/OAuth token required by that MCP server           |

## GitHub upload

Extract the release ZIP and publish the extracted repository folder with GitHub Desktop or Git. Do not upload the ZIP itself as a repository file. The repository root must contain:

```text
src/
.dockerignore
.env.example
.gitignore
Dockerfile
docker-compose.yml
package.json
package-lock.json
README.md
tsconfig.json
vite.config.ts
```

Never commit `.env`, `data/`, `artifacts/`, `uploads/`, `storage/`, `dist/`, or `node_modules/`.

## Verification

```bash
npm run verify
```

The gate runs TypeScript checking, automated tests, the production client/server build, and a production dependency audit. Deployment is manual; no GitHub Actions workflow is included.

## Architecture

```text
React UI
  -> authenticated Express API
     -> SSE chat -> OpenAI Responses (multimodal files / Code Interpreter / optional MCP)
     -> WebRTC voice -> short-lived OpenAI Realtime credential
     -> SQLite conversations, persona provenance, message states, model modes, jobs, approvals, uploads, artifacts
     -> background Responses jobs (web search / Code Interpreter / optional MCP)
     -> deterministic PPTX, DOCX, and portable website builders
     -> validation gate and authenticated downloads
```

## Security operations

- Keep the application private and behind HTTPS.
- Use only MCP servers you trust; remote MCP content can contain prompt injection.
- Keep approval enabled for every MCP call.
- Review exact arguments before approving.
- Rotate the owner passphrase and MCP authorization token periodically.
- Back up the single `STORAGE_DIR` mount as one consistency unit.
- Do not expose port 3000 directly to the public internet without a TLS reverse proxy.

## Render persistence commissioning

After the Free proof of concept passes functional acceptance:

1. Upgrade the existing service to Starter.
2. Attach one persistent disk at `/app/storage`.
3. Add `STORAGE_DIR=/app/storage` to the service environment.
4. Redeploy the verified commit.
5. While authenticated, confirm `GET /api/system/storage` reports `writable: true`.
6. Create a disposable conversation, upload a file, and build one artifact.
7. Restart the service and verify the conversation, upload count, and artifact download remain.
8. Redeploy the same commit and verify them again.
9. Confirm an interrupted streaming chat becomes explicitly retryable and an interrupted artifact job resumes without duplicate output.


## Artifact trust boundary

Automated tests are evidence for the exact path they exercise; mocked-provider tests are never described as live end-to-end acceptance. The artifact pipeline separates semantic planning from deterministic compilation, one-pass rendering, objective package/consumer validation, and non-blocking quality telemetry. Soft visual scores do not trigger model repairs. A deterministic BUILD failure is not retried with identical inputs; only bounded transient provider/asset failures may retry. Real-provider acceptance is run separately with `node scripts/live-artifact-acceptance.mjs` and requires `DIAZ_BASE_URL` plus `DIAZ_ADMIN_PASSWORD`.
