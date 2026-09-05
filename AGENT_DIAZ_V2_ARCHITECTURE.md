# Agent Díaz V2 — 2026 Agentic Architecture

Branch: `variant/agent-diaz-v2`

Production `main` and `snapshot/main-2026-09-04-green` are intentionally not modified by this work.

## Goal

Agent Díaz V2 is not a scripted sequence of model calls. It is an agentic artifact-production runtime that owns a real workspace and a real revision loop, and it keeps working until the deterministic production validator accepts a downloadable artifact.

The existing Agent Díaz renderers, visual hardening, PowerPoint/PDF/HTML export behavior, and deterministic validators are retained. V2 changes the orchestration layer above them rather than throwing away the parts that already work.

## Core runtime

- OpenAI Agents SDK `@openai/agents` 0.17.0
- OpenAI Agents extensions `@openai/agents-extensions` 0.17.0
- `SandboxAgent` execution harness
- Real sandbox workspace with filesystem editing, shell execution, patching, image inspection, and context compaction
- Hosted OpenAI web search and code interpreter tools
- Multiple MCP servers at the same time through Streamable HTTP and stdio transports
- Existing Agent Díaz deterministic renderers and validators exposed as an agent tool
- Explicit terminal acceptance tool that can accept only a build that already passed validation
- Agent SDK tracing plus Agent Díaz structured application logs
- Cancellation through `AbortSignal`

## Artifact loop

1. The agent receives the current request and explicitly attached files in `/workspace`.
2. It researches current or factual claims when needed and uses code execution for quantitative work.
3. It develops a complete `ArtifactPlan` in the agent loop.
4. It calls `build_and_validate_artifact`.
5. The existing deterministic builder renders the real PPTX/DOCX/ZIP artifact and runs the real production validators.
6. If validation fails, the agent receives the exact failure class, rule, diagnostic path when available, and repair guidance.
7. The agent revises the plan, layout, content, image queries, or retries a transient infrastructure operation as appropriate.
8. It calls `build_and_validate_artifact` again. V2 has no legacy two-repair/six-LLM-call ceiling controlling this loop.
9. Only a successful validated build receives a `buildId`.
10. The run can finish successfully only by calling `accept_validated_artifact` with one of those validated build IDs.
11. The accepted file is promoted into the normal Agent Díaz artifact store and becomes downloadable through the existing UI/API.
12. Presentation artifacts continue to expose the existing PowerPoint, PDF, and browser-HTML download paths from the accepted PPTX.

The model cannot finish by merely saying an artifact is ready. The acceptance tool is the terminal production-readiness gate.

## Failure policy

- `PLAN_CONTENT`: repair missing/incorrect requirements, structure, or content and rebuild.
- `PLAN_NORMALIZABLE`: normalize the plan without discarding valid user requirements and rebuild.
- `ASSET`: improve image queries or retry transient image acquisition without degrading requested visual coverage.
- `BUILD`: use the deterministic rule/diagnostic to revise layout or content and rebuild.
- `INFRA`: preserve good content and retry the infrastructure operation rather than rewriting the artifact to dodge an outage.

The runtime must not fail silently. Failures and retries are recorded through structured job/application logs. The only normal reasons to end without a downloadable artifact are explicit user cancellation or an unrecoverable external dependency.

## Filesystem and sandbox isolation

The sandbox filesystem is the canonical agent workspace. Exact uploaded files are materialized into `/workspace/inputs`; V2 does not grant the agent the broader host upload directory.

Sandbox backend selection is pluggable:

- `cloudflare`: hosted Cloudflare Sandbox bridge through the OpenAI Agents extension client
- `docker`: isolated local Docker sandbox
- `unix`: Unix-local sandbox for development/fallback

Configuration:

```text
AGENT_SANDBOX_PROVIDER=cloudflare|docker|unix
CLOUDFLARE_SANDBOX_WORKER_URL=https://<your-sandbox-bridge-worker>
CLOUDFLARE_SANDBOX_API_KEY=<optional bridge bearer key>
AGENT_SANDBOX_DOCKER_IMAGE=node:22-bookworm-slim
```

If `AGENT_SANDBOX_PROVIDER` is not set but `CLOUDFLARE_SANDBOX_WORKER_URL` is present, V2 automatically selects the hosted Cloudflare sandbox. Otherwise it falls back to Unix-local and emits a warning when that fallback is used in production. This keeps V2 usable immediately while allowing production shell/filesystem execution to move behind a hosted isolation boundary without another architectural rewrite.

## MCP

MCP is an extension layer for external systems and specialist tools; it is not being used as a fake replacement for the native sandbox filesystem.

V2 supports multiple MCP servers simultaneously through `MCP_SERVERS_JSON`. For example:

```json
[
  {
    "transport": "http",
    "name": "Research MCP",
    "url": "https://example.com/mcp",
    "authorizationEnv": "RESEARCH_MCP_AUTH"
  },
  {
    "transport": "stdio",
    "name": "Filesystem MCP",
    "fullCommand": "npx -y @modelcontextprotocol/server-filesystem /workspace"
  },
  {
    "transport": "stdio",
    "name": "Playwright MCP",
    "fullCommand": "npx -y @playwright/mcp@latest --headless"
  }
]
```

Server names must be unique. HTTP credentials can be referenced by environment-variable name rather than embedded in the JSON. MCP tools are server-prefixed to avoid collisions, connection failures clean up already-connected servers, and all servers are closed at the end of the run.

The existing single-server settings remain supported for backward compatibility:

```text
MCP_SERVER_URL
MCP_SERVER_LABEL
MCP_AUTHORIZATION
```

## Compatibility and rollout

- Real artifact jobs on `variant/agent-diaz-v2` use V2 by default.
- `AGENT_RUNTIME=legacy` is an emergency compatibility override on the V2 branch.
- Existing regression tests remain on the proven legacy harness unless a V2 test explicitly opts into `AGENT_RUNTIME=v2`; this preserves renderer/validator regression coverage while the new harness is tested separately.
- `main` is unchanged.
- The frozen rollback branch `snapshot/main-2026-09-04-green` is unchanged.

## Maturity note

The OpenAI Agents SDK is the production agent runtime used by V2. The newer Sandbox Agents layer is still marked beta upstream, so the sandbox provider is deliberately isolated behind a small adapter. Agent Díaz can move among Cloudflare-hosted, Docker, or local sandbox implementations without changing the artifact loop, MCP layer, validators, or UI contract.


## Final production-readiness contract

V2 now separates liveness from agent readiness:

- `GET /healthz` answers whether the web process is alive.
- `GET /readyz` answers whether the selected V2 sandbox/MCP configuration is safe enough to start artifact work. It returns HTTP 503 when the agent runtime is not deployable.
- `GET /version` exposes only non-secret runtime metadata: Agents SDK version, selected runtime, sandbox provider, readiness flag, and MCP server count.

Production fails closed for agent shell execution. Unix-local is accepted for development, but production requires a hosted Cloudflare sandbox or an explicitly selected Docker sandbox unless `AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true` is deliberately set as an emergency override.

Stdio MCP servers are likewise development-friendly but execute on the application host. Production therefore prefers Streamable HTTP MCP and rejects stdio by default unless `AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true` is deliberately enabled. `MCP_SERVERS_JSON` supports per-server `allowedTools` and `blockedTools` filters.

Every rejected build now returns model-readable diagnostic evidence. When available, the exact preserved failed artifact is attached as a function-tool file output; PPTX/DOCX failures also receive a LibreOffice-rendered diagnostic PDF when conversion succeeds. Host filesystem diagnostic paths are never relied on as the model's evidence channel.

Every V2 attempt persists its complete ArtifactPlan plus an append-only `REVISION_HISTORY.jsonl`. If the app process restarts before completion, the latest plan and revision ledger are materialized into `recovery/` in the new sandbox so the agent can resume from the last known strategy instead of blindly restarting. Repeated identical non-infrastructure failures produce a `stagnationCount` and explicit instruction to change strategy rather than dead-horse the same plan.


Transient V2 control-plane failures are also restart-safe. A provider, hosted-sandbox, or MCP outage writes an `INFRA_RETRY.json` marker beside the revision ledger, schedules capped exponential retry, and leaves the job `blocked` only while the external dependency is unavailable. `AgentRunner.resume()` recognizes that marker after a process restart and restarts the job automatically. Permanent `agent-v2-configuration` failures deliberately clear the marker and remain blocked until deployment configuration is corrected, preventing a bad configuration from becoming an infinite retry loop. User cancellation is terminal and cannot be overwritten by a racing failure handler.
