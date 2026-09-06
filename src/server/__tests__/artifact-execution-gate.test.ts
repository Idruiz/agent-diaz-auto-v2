import { describe, expect, it } from "vitest";
import { installArtifactExecutionGate } from "../artifact-execution-gate.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("artifact execution gate", () => {
  it("serializes artifact jobs while allowing chat to start immediately", async () => {
    const jobs = new Map<string, { id: string; kind: string; status: string }>([
      ["artifact-a", { id: "artifact-a", kind: "presentation", status: "queued" }],
      ["artifact-b", { id: "artifact-b", kind: "research", status: "queued" }],
      ["chat-c", { id: "chat-c", kind: "chat", status: "queued" }],
    ]);
    const started: string[] = [];
    const runner = {
      start(jobId: string) {
        started.push(jobId);
        const job = jobs.get(jobId);
        if (job) job.status = "running";
      },
    };
    const db = { getJob: (jobId: string) => jobs.get(jobId) };

    installArtifactExecutionGate(runner, db, { pollMs: 10, cleanupGraceMs: 0 });
    runner.start("artifact-a");
    runner.start("artifact-b");
    runner.start("chat-c");

    await sleep(20);
    expect(started).toEqual(["artifact-a", "chat-c"]);

    jobs.get("artifact-a")!.status = "completed";
    await sleep(30);
    expect(started).toEqual(["artifact-a", "chat-c", "artifact-b"]);
  });

  it("deduplicates repeated recovery/retry starts for the same artifact", async () => {
    const jobs = new Map<string, { id: string; kind: string; status: string }>([
      ["artifact-a", { id: "artifact-a", kind: "website", status: "queued" }],
    ]);
    const started: string[] = [];
    const runner = {
      start(jobId: string) {
        started.push(jobId);
        jobs.get(jobId)!.status = "running";
      },
    };
    installArtifactExecutionGate(
      runner,
      { getJob: (jobId: string) => jobs.get(jobId) },
      { pollMs: 10, cleanupGraceMs: 0 },
    );

    runner.start("artifact-a");
    runner.start("artifact-a");
    runner.start("artifact-a");
    await sleep(20);
    expect(started).toEqual(["artifact-a"]);
  });
});
