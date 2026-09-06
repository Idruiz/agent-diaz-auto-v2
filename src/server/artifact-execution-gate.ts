import { log } from "./log.js";

const ARTIFACT_KINDS = new Set([
  "research",
  "analysis",
  "presentation",
  "document",
  "website",
]);

const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "building",
  "waiting_approval",
]);

export interface ArtifactExecutionGateOptions {
  pollMs?: number;
  cleanupGraceMs?: number;
}

interface GateJob {
  id: string;
  kind: string;
  status: string;
}

interface GateDb {
  getJob(jobId: string): GateJob | undefined | null;
}

interface GateRunner {
  start(jobId: string): void;
}

/**
 * Serializes heavyweight artifact runtimes inside one service instance.
 *
 * Render's V2 runtime can spawn Chromium-backed MCP processes for an artifact.
 * Starting multiple artifact jobs concurrently on a 512 MB instance can trigger
 * an OOM restart. The database remains the durable queue: queued/running/building
 * jobs are recovered by AgentRunner.resume() after a process restart, and every
 * recovered call to runner.start() passes through this gate again.
 *
 * Chat remains concurrent because it does not create the heavyweight artifact
 * browser/runtime stack.
 */
export function installArtifactExecutionGate(
  runner: GateRunner,
  db: GateDb,
  options: ArtifactExecutionGateOptions = {},
): void {
  // Keep the production default deliberately conservative, while honoring
  // explicit lower intervals used by deterministic tests and callers.
  const pollMs = Math.max(1, options.pollMs ?? 500);
  const cleanupGraceMs = Math.max(0, options.cleanupGraceMs ?? 3_000);
  const originalStart = runner.start.bind(runner);
  const queued: string[] = [];
  const queuedIds = new Set<string>();
  let activeArtifactJobId: string | null = null;
  let draining = false;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const drain = async (): Promise<void> => {
    if (draining || activeArtifactJobId) return;
    draining = true;
    try {
      while (!activeArtifactJobId && queued.length) {
        const jobId = queued.shift()!;
        queuedIds.delete(jobId);
        const job = db.getJob(jobId);
        if (!job || ["completed", "cancelled", "failed"].includes(job.status))
          continue;

        activeArtifactJobId = jobId;
        log("info", "artifact.execution_gate_started", {
          jobId,
          kind: job.kind,
          queuedBehind: queued.length,
        });
        originalStart(jobId);

        void (async () => {
          for (;;) {
            await sleep(pollMs);
            const current = db.getJob(jobId);
            if (!current || !ACTIVE_STATUSES.has(current.status)) break;
          }

          // AgentRunner updates the DB before its runtime finally-block closes
          // browser MCP processes. Give those child processes a short grace
          // period to exit before launching the next Chromium-backed job.
          if (cleanupGraceMs) await sleep(cleanupGraceMs);
          const finished = db.getJob(jobId);
          log("info", "artifact.execution_gate_released", {
            jobId,
            status: finished?.status ?? "missing",
            queuedBehind: queued.length,
          });
          activeArtifactJobId = null;
          void drain();
        })();
      }
    } finally {
      draining = false;
    }
  };

  runner.start = ((jobId: string) => {
    const job = db.getJob(jobId);
    if (!job || !ARTIFACT_KINDS.has(job.kind)) {
      originalStart(jobId);
      return;
    }
    if (activeArtifactJobId === jobId || queuedIds.has(jobId)) return;
    queued.push(jobId);
    queuedIds.add(jobId);
    log("info", "artifact.execution_gate_queued", {
      jobId,
      kind: job.kind,
      activeArtifactJobId,
      queueDepth: queued.length,
    });
    void drain();
  }) as GateRunner["start"];
}
