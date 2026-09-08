# JEFE//AUTO V2 — Cloudflare Native Architecture

Status: implementation branch architecture contract

Baseline preserved from Render production line:

- Repository: `Idruiz/agent-diaz-auto-v2`
- Frozen source SHA: `21a247d1aa2d63edf876250c04afaaefe9712e5d`
- Cloudflare branch: `cloudflare/worker-native-v2`
- Render `main` is intentionally unchanged by this work.

## 1. Non-negotiable preservation contract

This is a platform adaptation, not an Agent Díaz rewrite.

The Cloudflare line MUST preserve the hard-earned V2 behavior already present in the baseline:

- OpenAI Agents SDK orchestration.
- `SandboxAgent` filesystem/tool behavior.
- `build_and_validate_artifact` as the deterministic artifact authority.
- `accept_validated_artifact` as the only terminal acceptance gate.
- Unlimited artifact repair strategy within the generous outer agent bound.
- Revision ledger, recovery files, failure classification and stagnation detection.
- Streaming tool telemetry and five-second human-readable heartbeat.
- Uploads, personas, conversation continuity, approvals and retry semantics.
- PPTX/PDF/HTML presentation output plus existing DOCX/site artifacts.
- LibreOffice, Poppler, Chromium and all deterministic artifact validators where they are actually required.
- Reviewed MCP security boundary. Arbitrary production stdio remains denied unless explicitly enabled.
- No secrets in model-visible state, receipts, logs or source.

The Render deployment remains a known rollback/reference implementation. The Cloudflare branch must never obtain a green result by deleting a working capability from the baseline.

## 2. The failure model we are designing against

The previous Cloudflare direction had several ways to look alive while useful work had actually stopped:

1. A long agent operation was too closely coupled to one HTTP request lifetime.
2. A sandbox could become idle while the model was reasoning or while a remote tool was quiet.
3. A container filesystem could be mistaken for durable storage even though container disks are ephemeral.
4. Browser processes could compete with the artifact runtime for memory/CPU.
5. A transport timeout could strand a job without a durable owner that knows where to resume.
6. Progress depended too much on live process memory rather than durable state.

The architecture below removes those failure classes instead of increasing arbitrary timeouts.

## 3. Core rule: requests are not jobs

An incoming Worker request is allowed to do only short control-plane work:

- authenticate
- validate input
- create/read durable job state
- enqueue/start durable execution
- return a job identifier
- stream or fetch already-persisted progress

A Worker request MUST NOT be the lifetime owner of an artifact run.

Artifact work is owned by a durable Workflow instance keyed by `jobId`. The browser may disconnect, the edge isolate may disappear, a deployment may roll, or a container may restart without changing job ownership.

## 4. Target topology

```text
Browser / JEFE UI
        |
        v
Cloudflare Edge Worker
  - auth / CSRF / request validation
  - 202 job creation
  - artifact downloads
  - progress WebSocket/SSE gateway
        |
        +--------------------------+
        |                          |
        v                          v
Job Durable Object            Cloudflare Workflow (1 per job)
  - canonical job state          - durable orchestration
  - monotonic event sequence     - retry/checkpoint boundaries
  - latest heartbeat             - resume after interruption
  - cancellation/approval        - no dependency on client socket
  - event replay                 - job lease/watchdog
        |                          |
        +------------+-------------+
                     |
                     v
        JEFE Application Container
        - existing Node 22 app/runtime
        - OpenAI Agents SDK
        - deterministic builders/validators
        - LibreOffice/Poppler where required
        - no browser Chromium in steady-state target
                     |
             +-------+-------+
             |               |
             v               v
       Sandbox SDK         Browser Run
       per job             remote Chrome
       - shell/files       - Playwright/CDP
       - /workspace        - DevTools MCP
       - R2 mount          - bounded sessions
       - keepAlive         - no artifact RAM contention
             |
             v
             R2
       - uploads
       - artifacts
       - recovery ledger
       - immutable receipts
       - workspace checkpoints
```

## 5. Cloudflare service responsibilities

### 5.1 Edge Worker — control plane only

The edge Worker is deliberately boring.

It owns:

- authentication boundary
- request IDs
- schema validation
- short API routing
- job creation
- job/status reads
- cancel/approval commands
- authenticated artifact download routing
- progress stream attachment/re-attachment

It does not own:

- long OpenAI runs
- LibreOffice rendering
- artifact validation
- local Chromium
- a mutable workspace
- the authoritative job loop

A client receives `202 Accepted` once a durable job has been created. Reconnecting to the UI attaches to existing durable state rather than creating a second run.

### 5.2 Job Durable Object — state and live events

Use one SQLite-backed Durable Object per job (or a carefully bounded shard keyed by job ID).

Canonical fields include at minimum:

- `jobId`
- `conversationId`
- `kind`
- `status`
- `phase`
- `progress`
- `message`
- `lastEventAt`
- `lastHeartbeatAt`
- `lastTool`
- `workflowInstanceId`
- `attempt`
- `acceptedBuildId`
- `cancelRequested`
- `approvalState`
- `errorClass`
- `errorMessage`
- `eventSequence`
- `artifactRefs`

Every visible telemetry event receives a monotonically increasing sequence number and is committed before broadcast. A newly connected UI can replay missed events and then continue live.

No important job state exists only in JavaScript memory.

### 5.3 Workflow — durable owner of the job

Use one Workflow instance per artifact job with `instance id == jobId`.

The Workflow does not attempt to serialize the entire OpenAI Agents SDK object graph. It owns coarse, recoverable phases:

1. acquire job lease
2. prepare execution container
3. prepare/restore job workspace
4. invoke an agent execution slice
5. persist result/checkpoint
6. if still active, continue from persisted state
7. package accepted artifact
8. finalize job
9. cleanup execution resources

External calls and side effects are isolated behind idempotent Workflow steps. Retried steps must be safe to execute more than once.

Do not wrap the entire artifact lifecycle in one giant Workflow step. Long model/tool work must expose checkpoints often enough that a platform interruption does not erase an hour of progress.

### 5.4 JEFE application container — compatibility execution plane

The existing Node/Express runtime contains substantial working code that should not be reimplemented inside a Worker isolate merely for architectural purity.

The first Cloudflare production milestone therefore runs the existing Node 22 artifact/runtime code in a Cloudflare Container. This preserves:

- native Node dependencies
- `better-sqlite3` during the compatibility phase
- LibreOffice / Poppler
- existing validators
- current OpenAI Agents SDK integration
- existing artifact builders

Important: the container disk is scratch space, not authoritative persistence.

The compatibility container must expose narrow authenticated internal endpoints for Workflow orchestration instead of being treated as a public forever-running web server.

The longer-term migration may move ordinary CRUD/chat state to Durable Object SQLite/D1. That migration is explicitly secondary to proving the Cloudflare execution plane without regressing artifact quality.

### 5.5 Sandbox SDK — isolated job workspace

A dedicated sandbox remains the agent shell/filesystem environment.

Per-job layout:

```text
/workspace/                 fast ephemeral Linux workspace
/workspace/persist/         R2-mounted durable namespace
/workspace/persist/recovery/
/workspace/persist/output/
/workspace/persist/logs/
```

R2 prefix:

```text
jobs/<jobId>/...
```

Rules:

- `keepAlive` is enabled while the job owns the sandbox.
- setup failure disables keepAlive immediately.
- normal/failure/cancel completion releases keepAlive in a guaranteed cleanup path.
- task-scoped browser MCP processes are stopped on release while the compatibility implementation still uses them.
- durable notes and recovery state go under `/workspace/persist`.
- `/workspace` is rebuildable scratch and must never be the only copy of important state.

The current branch implements the managed keepAlive/release contract immediately because it directly removes an observed pause class without waiting for the larger migration.

### 5.6 R2 — durable bytes, never a fake SSD

R2 is the byte store for:

- uploads
- final artifacts
- diagnostic artifacts
- revision/recovery files
- immutable validation receipts
- structured run-log archives
- optional workspace backups/checkpoints

R2 is NOT used as a mounted database file for SQLite.

Never place the live `better-sqlite3` database on an R2 FUSE mount. Object storage semantics/latency are wrong for a transactional SQLite database and doing so creates a corruption/locking trap disguised as persistence.

During the compatibility-container milestone, local SQLite must have an explicit replication/restore plan before that milestone can be called production-safe. The preferred end state is durable state in Durable Object SQLite/D1, while binary artifacts remain in R2.

### 5.7 Browser Run — steady-state browser execution

The final Cloudflare line should not run a full Chromium for each browser MCP beside the artifact runtime.

Browser target:

- Playwright via Browser Run/CDP or Cloudflare Playwright MCP.
- Chrome DevTools MCP connected to Browser Run's CDP WebSocket.
- Puppeteer/Playwright direct CDP when the task needs programmatic browser control.
- explicit bounded browser session keep-alive.
- close sessions in `finally`.

Benefits:

- browser memory is outside the application/artifact container
- no competing local Chromium processes
- browser crashes do not kill the artifact process
- browser lifetime is independently measurable and retryable

The existing in-sandbox browser MCP remains a compatibility fallback until the Browser Run path passes the same real tool proof.

## 6. Anti-pause / anti-hang contract

### 6.1 Sandbox lifecycle

While a job is active:

- call `sandbox.setKeepAlive(true)`
- platform sends its own keepalive heartbeat
- release with `setKeepAlive(false)` after the job
- never leave keepAlive pinned after setup failure

This is already implemented in the Cloudflare branch's first adaptation patch.

### 6.2 Durable heartbeat

The current five-second human-readable runtime heartbeat remains, but its durable form must be written to the Job Durable Object.

At minimum persist on:

- agent start
- every tool start
- every tool completion
- every build start
- every validation result
- every infrastructure retry
- every approval wait/resume
- artifact acceptance
- cleanup

A UI heartbeat may repeat the last durable event with increasing elapsed/idle time. It must not invent fake progress percentages.

### 6.3 Watchdog

A watchdog is based on `lastEventAt`, phase and expected timeout, not on a single global timer.

Examples:

- model reasoning: tolerate quiet interval, continue sandbox keepAlive
- MCP call: enforce tool-specific timeout
- browser session: bounded connect/action timeout
- build/render: use builder-specific timeout plus process liveness
- workflow/container RPC: retry idempotently

When a deadline expires:

1. classify `INFRA`
2. persist diagnostic context
3. terminate only the failed subordinate resource if possible
4. restore from durable checkpoint
5. retry with exponential backoff + jitter
6. after repeated identical infrastructure failure, change execution strategy or fail loudly with evidence

Never silently sit at 42% forever.

### 6.4 Idempotency

Every side effect has a deterministic idempotency key.

Examples:

- Workflow ID: `jobId`
- workspace R2 prefix: `jobs/<jobId>/`
- artifact attempt: `<jobId>/<attempt>`
- build record: validated `buildId`
- event: `<jobId>/<sequence>`
- accepted artifact object: content SHA / build ID

A retry must discover an already-completed side effect instead of duplicating it.

## 7. Browser migration sequence

Do not remove the current browser implementation first.

1. Add Browser Run credentials/bindings to the Cloudflare control plane.
2. Implement Playwright Browser Run smoke.
3. Implement Chrome DevTools MCP over Browser Run CDP.
4. Run a real agent task through both.
5. Compare tool semantics to current reviewed MCP definitions.
6. Switch Cloudflare default to Browser Run.
7. Keep in-sandbox Chromium as temporary fallback behind an explicit provider flag.
8. Remove only after a full release cycle proves Browser Run parity.

## 8. State migration sequence

### Milestone A — preserved compatibility

- Cloudflare branch from exact Render main SHA.
- existing app behavior unchanged.
- sandbox R2 filesystem retained.
- managed sandbox keepAlive/release implemented.
- no deployment to Render main.

### Milestone B — Cloudflare execution proof

- Cloudflare Worker gateway.
- application Container from existing production image/code.
- existing V2 runtime reaches Cloudflare Sandbox.
- R2 write/read/restart proof.
- full artifact run passes.

### Milestone C — durable job ownership

- Workflow per artifact job.
- Job Durable Object event/state model.
- client gets `202` and reconnectable event stream.
- restart/rollout during a live test resumes rather than duplicates/fails silently.

### Milestone D — Browser Run

- remote Playwright/CDP path proven.
- remote DevTools MCP proven.
- local Chromium removed from Cloudflare steady-state runtime only after parity.

### Milestone E — database durability

- move durable CRUD/job/conversation metadata to Durable Object SQLite/D1, or establish an equivalently strong explicitly tested database replication layer.
- no authoritative database on ephemeral container disk.
- no SQLite database mounted directly on R2.

### Milestone F — Cloudflare production release

- exact candidate SHA green in GitHub.
- Cloudflare deployment pinned to that SHA/build.
- kill/restart/resume test passes.
- Sandbox idle/pause test passes.
- browser tool proof passes.
- artifact revision/validation/acceptance passes.
- persistent file proof passes.
- secrets/log review passes.

Only then is the Cloudflare line production-proven.

## 9. Failure containment boundaries

The system should be able to lose one component without losing the job:

| Failure | Expected recovery |
| --- | --- |
| Client/browser tab closes | job continues; reconnect reads durable state |
| Worker isolate disappears | next request hits same DO/workflow state |
| Sandbox sleeps unexpectedly | recreate by same job ID; restore durable files |
| Browser Run session dies | recreate browser session; retry browser step |
| App container restarts | Workflow reconnects; job state and R2 recovery survive |
| Tool times out | classify INFRA; retry bounded step |
| Artifact validation fails | revise plan; not infrastructure retry |
| Deployment rolls mid-job | Workflow resumes from last successful durable step |
| Duplicate create request | same idempotency key returns existing job |

## 10. Security boundary

- OpenAI credentials stay in trusted control/application execution only.
- Cloudflare Sandbox bridge requires bearer authentication.
- Browser Run API token never enters model-visible diagnostics.
- arbitrary user-provided host stdio remains disabled in production.
- R2 bucket is private; downloads flow through authenticated application routes.
- internal Worker/container calls use service bindings or an authenticated internal request contract.
- no full environment dumps.
- error output is bounded before logs/model exposure.

## 11. CI contract for the Cloudflare branch

Keep the existing full Verify pipeline. Add Cloudflare-specific gates rather than replacing old ones.

Required additional gates:

1. Cloudflare Worker typecheck.
2. Wrangler config validation / dry-run where supported.
3. sandbox R2 mount contract.
4. sandbox keepAlive setup + release contract.
5. cleanup still runs when setup/tool fails.
6. job idempotency test.
7. Workflow resume simulation.
8. durable event ordering/replay test.
9. R2 artifact persistence test.
10. Browser Run smoke once account secrets are available.
11. production container build remains green.

No `continue-on-error` around the Cloudflare production path.

## 12. What this architecture intentionally does NOT do

- It does not rewrite Agent Díaz V2 from scratch.
- It does not turn a Worker isolate into a fake Linux server.
- It does not make a long HTTP request responsible for an agent job.
- It does not store authoritative state only on container disk.
- It does not put SQLite on R2 FUSE.
- It does not spawn redundant Chromium processes when Browser Run can own browser memory.
- It does not weaken validators or repair loops to fit platform limits.
- It does not merge into or deploy Render `main` while the Cloudflare line is under construction.

That is the central design rule for this branch: **Cloudflare owns durable orchestration and durable state; Linux containers/sandboxes do the heavy work; R2 owns durable bytes; Browser Run owns Chrome; the existing V2 artifact intelligence remains intact.**
