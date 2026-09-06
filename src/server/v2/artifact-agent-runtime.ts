import fs from "node:fs";
import path from "node:path";
import {
  codeInterpreterTool,
  run,
  tool,
  webSearchTool,
} from "@openai/agents";
import {
  Manifest,
  SandboxAgent,
  file,
  localFile,
} from "@openai/agents/sandbox";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  buildArtifact,
  type ArtifactBuildProgress,
  type BuiltFile,
} from "../builders.js";
import {
  ArtifactPipelineError,
  type ArtifactFailureClass,
} from "../artifact-quality.js";
import { log } from "../log.js";
import {
  closeV2McpServers,
  connectV2McpServers,
  createV2McpRuntime,
} from "./mcp-runtime.js";
import { buildFailureToolOutput } from "./diagnostic-evidence.js";
import {
  appendV2RevisionEntry,
  listV2RecoveryFiles,
  writeV2AttemptPlan,
} from "./revision-ledger.js";
import { createV2SandboxRuntime } from "./sandbox-runtime.js";
import {
  cloudflareSandboxIdFromSession,
  prepareCloudflareWorkspace,
} from "./cloudflare-workspace.js";
import {
  ArtifactPlanSchema,
  type ArtifactPlan,
  type JobKind,
} from "../../shared/contracts.js";

export interface V2ArtifactAttachment {
  name: string;
  mime: string;
  path: string;
  size: number;
}

export interface V2AgentProgress {
  progress: number;
  stage: "agent";
  message: string;
  elapsedMs?: number;
  idleMs?: number;
  tool?: string;
}

export interface V2ArtifactRuntimeInput {
  config: Config;
  jobId: string;
  kind: JobKind;
  prompt: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  attachments?: V2ArtifactAttachment[];
  priorContext?: string;
  signal?: AbortSignal;
  onProgress?: (event: ArtifactBuildProgress | V2AgentProgress) => void;
}

export interface V2ArtifactRuntimeResult {
  file: BuiltFile;
  attempts: number;
  finalOutput: unknown;
}

interface ClassifiedFailure {
  failureClass: ArtifactFailureClass;
  ruleOrPart: string;
  message: string;
  diagnosticPath?: string;
}

const BuildToolResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    buildId: z.string(),
    attempt: z.number().int().positive(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    validation: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ok: z.literal(false),
    attempt: z.number().int().positive(),
    failureClass: z.enum(["PLAN_CONTENT", "PLAN_NORMALIZABLE", "ASSET", "BUILD", "INFRA"]),
    ruleOrPart: z.string(),
    message: z.string(),
    diagnosticPath: z.string().optional(),
    retryAdvice: z.string(),
  }),
]);

const AcceptToolResultSchema = z.object({
  ok: z.literal(true),
  buildId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
});

function safeWorkspaceName(name: string, index: number): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || `upload_${index + 1}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function streamToolName(event: any): string | null {
  const rawName = event?.item?.rawItem?.name;
  if (typeof rawName !== "string" || !rawName.trim()) return null;
  return rawName.replaceAll("__", " → ");
}

export function classifyV2BuildFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ArtifactPipelineError)
    return {
      failureClass: error.failureClass,
      ruleOrPart: error.ruleOrPart,
      message: error.message,
      ...(error.diagnosticPath ? { diagnosticPath: error.diagnosticPath } : {}),
    };

  const message = error instanceof Error ? error.message : String(error);
  if (/(?:rate[_ -]?limit|5\d\d|ECONN|ETIMEDOUT|network|provider unavailable|spawn|ENOENT)/i.test(message))
    return {
      failureClass: "INFRA",
      ruleOrPart: "agent-v2-infrastructure",
      message,
    };
  if (/(?:image|photograph|asset|wikimedia|commons|license)/i.test(message))
    return {
      failureClass: "ASSET",
      ruleOrPart: "agent-v2-asset-resolution",
      message,
    };
  return {
    failureClass: "BUILD",
    ruleOrPart: "agent-v2-build",
    message,
  };
}

export function v2ArtifactAgentInstructions(kind: JobKind): string {
  return [
    `You are Agent Díaz V2, a production artifact engineer responsible for a finished ${kind}.`,
    "You are operating inside a real sandbox workspace with filesystem editing and shell access. Use the workspace actively: keep research notes, a current plan, and revision notes instead of trying to hold the entire job in chat context. In the hosted Cloudflare runtime, /workspace is the fast Linux workspace and /workspace/persist is an R2-backed filesystem mount that survives sandbox destruction; keep durable notes and browser outputs under /workspace/persist.",
    "You have web search and code execution. Research factual/current claims when needed; use code execution for uploaded datasets and quantitative work. Never invent evidence or numbers.",
    "If MCP tools are present, use them when they materially improve the task. Treat MCP as an external capability layer, not as a substitute for the sandbox filesystem.",
    "The build_and_validate_artifact tool is the only authority on whether an artifact is technically ready. It runs the real Agent Díaz renderer and deterministic validators.",
    "Work iteratively. Create a complete ArtifactPlan, call build_and_validate_artifact, read the exact failure, revise the plan or retry the infrastructure operation as appropriate, and call the tool again. Do not abandon a valid user requirement to make validation easier.",
    "If failureClass is INFRA, do not rewrite good content merely to dodge infrastructure; retry after doing any useful independent work. If failureClass is ASSET, improve image queries or retry. If failureClass is PLAN_CONTENT or BUILD, revise the plan/layout/content based on the reported rule.",
    "There is no arbitrary two-repair or six-call ceiling in this V2 loop. Continue until a build returns ok:true unless the user cancels or an unrecoverable external dependency makes progress impossible.",
    "If recovery/REVISION_HISTORY.jsonl or recovery/LATEST_PLAN.json exists, inspect it before restarting work so a process restart does not erase the last known revision strategy.",
    "A rejected build may include the exact failed artifact and a rendered diagnostic PDF as tool outputs. Inspect those files with code execution when the failure is visual, structural, or otherwise unclear before changing the plan.",
    "Do not dead-horse an unchanged rejected plan. If stagnationCount is 2 or greater, materially change the plan, layout, asset strategy, or diagnostic approach before rebuilding unless the failure is explicitly transient infrastructure.",
    "A successful build is not final until you call accept_validated_artifact with the exact buildId returned by the successful build. Never claim completion before that acceptance call succeeds.",
    "Preserve explicit user requirements, requested language, audience, pedagogy, visual intent, and requested deliverable type. Finished visible copy must be audience-facing, not production notes or placeholders.",
    "For presentations specifically: avoid rigid text stuffing. Prefer reflow, pagination, shorter visible copy, speaker notes, and responsive visual layouts. Every image must be relevant to its section and every fetched image must be placed or explicitly rejected before acceptance.",
  ].join("\n\n");
}

function validationSummary(file: BuiltFile): Record<string, unknown> {
  const receipt = file.validationReceipt as unknown as Record<string, unknown>;
  return {
    buildSha: receipt.buildSha ?? null,
    artifactSha256: receipt.artifactSha256 ?? null,
    scores: receipt.scores ?? null,
    images: receipt.images ?? null,
    knownBenignFindings: receipt.knownBenignFindings ?? [],
    normalizations: receipt.normalizations ?? [],
  };
}

function retryAdvice(failure: ClassifiedFailure): string {
  switch (failure.failureClass) {
    case "INFRA":
      return "Keep the current good plan. Retry the build/tool operation; do not degrade content to work around infrastructure.";
    case "ASSET":
      return "Revise weak or overly narrow image queries, or retry if the provider failure is transient. Preserve the requested visual coverage.";
    case "PLAN_CONTENT":
      return "Repair the ArtifactPlan so every explicit requirement is represented and structurally valid, then rebuild.";
    default:
      return "Use the reported rule/diagnostic to revise layout or content, then rebuild the complete artifact.";
  }
}

export async function runV2ArtifactRuntime(
  input: V2ArtifactRuntimeInput,
): Promise<V2ArtifactRuntimeResult> {
  const attachments = input.attachments ?? [];
  const workRoot = path.join(
    input.config.artifactDir,
    ".agent-v2",
    input.jobId,
  );
  fs.mkdirSync(workRoot, { recursive: true });

  let attempt = 0;
  let acceptedBuildId: string | null = null;
  const successfulBuilds = new Map<string, BuiltFile>();
  const failureFingerprints = new Map<string, number>();
  const startedAt = Date.now();
  let lastProgress = 20;
  let lastActivity = "Preparing agent workspace";
  let lastActivityAt = startedAt;
  let lastTool: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const emitAgentProgress = (
    progress: number,
    message: string,
    extra: Partial<Omit<V2AgentProgress, "progress" | "stage" | "message">> = {},
  ) => {
    lastProgress = Math.max(lastProgress, Math.min(99, progress));
    lastActivity = message;
    lastActivityAt = Date.now();
    const event: V2AgentProgress = {
      progress: lastProgress,
      stage: "agent",
      message,
      elapsedMs: Date.now() - startedAt,
      ...extra,
    };
    input.onProgress?.(event);
    log("info", "agent_v2.telemetry", {
      jobId: input.jobId,
      kind: input.kind,
      ...event,
    });
  };

  const emitBuildProgress = (event: ArtifactBuildProgress) => {
    lastProgress = Math.max(lastProgress, Math.min(99, event.progress));
    lastActivity = event.message;
    lastActivityAt = Date.now();
    input.onProgress?.({ ...event, progress: lastProgress });
  };

  const startHeartbeat = () => {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivityAt;
      const message = `Agent active · ${formatElapsed(now - startedAt)} elapsed · ${lastActivity}${idleMs >= 5_000 ? ` · ${formatElapsed(idleMs)} since last event` : ""}`;
      input.onProgress?.({
        progress: lastProgress,
        stage: "agent",
        message,
        elapsedMs: now - startedAt,
        idleMs,
        ...(lastTool ? { tool: lastTool } : {}),
      });
      log("info", "agent_v2.heartbeat", {
        jobId: input.jobId,
        kind: input.kind,
        elapsedMs: now - startedAt,
        idleMs,
        progress: lastProgress,
        lastActivity,
        lastTool,
      });
    }, 5_000);
    heartbeat.unref?.();
  };

  const stopHeartbeat = () => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const buildTool = tool({
    name: "build_and_validate_artifact",
    description:
      "Render a complete Agent Díaz artifact candidate and run the real deterministic production validators. On failure, returns the exact failure class/rule so you can revise and try again. On success, returns a buildId that can be accepted.",
    parameters: z.object({
      plan: ArtifactPlanSchema,
    }),
    async execute({ plan }: { plan: ArtifactPlan }) {
      if (input.signal?.aborted) throw new Error("Agent Díaz V2 run cancelled");
      attempt += 1;
      emitAgentProgress(50, `Build attempt ${attempt} started · rendering and validating`);
      const { attemptDir, planSha } = writeV2AttemptPlan(
        workRoot,
        attempt,
        plan,
      );
      log("info", "agent_v2.artifact_build_started", {
        jobId: input.jobId,
        kind: input.kind,
        attempt,
        planSha,
      });
      try {
        const built = await buildArtifact(
          { ...input.config, artifactDir: attemptDir },
          input.kind,
          plan,
          input.prompt,
          input.jobId,
          (event) => {
            if (input.signal?.aborted)
              throw new Error("Agent Díaz V2 run cancelled");
            emitBuildProgress(event);
          },
        );
        const buildId = crypto.randomUUID();
        successfulBuilds.set(buildId, built);
        appendV2RevisionEntry(workRoot, {
          attempt,
          planSha,
          status: "validated",
          buildId,
        });
        emitAgentProgress(94, `Build attempt ${attempt} passed validation · awaiting explicit acceptance`);
        log("info", "agent_v2.artifact_build_validated", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          buildId,
          planSha,
          name: built.name,
          size: built.size,
        });
        return {
          ok: true as const,
          buildId,
          attempt,
          name: built.name,
          mime: built.mime,
          size: built.size,
          validation: validationSummary(built),
        };
      } catch (error) {
        const failure = classifyV2BuildFailure(error);
        const fingerprint = `${failure.failureClass}:${failure.ruleOrPart}:${planSha}`;
        const stagnationCount =
          failure.failureClass === "INFRA"
            ? 1
            : (failureFingerprints.get(fingerprint) ?? 0) + 1;
        if (failure.failureClass !== "INFRA")
          failureFingerprints.set(fingerprint, stagnationCount);
        const baseAdvice = retryAdvice(failure);
        const advice =
          stagnationCount >= 2 && failure.failureClass !== "INFRA"
            ? `${baseAdvice} This exact plan/failure fingerprint has repeated ${stagnationCount} times; do not submit the unchanged plan again. Inspect the diagnostic evidence and materially change strategy.`
            : baseAdvice;
        appendV2RevisionEntry(workRoot, {
          attempt,
          planSha,
          status: "rejected",
          failureClass: failure.failureClass,
          ruleOrPart: failure.ruleOrPart,
          message: failure.message,
          stagnationCount,
        });
        emitAgentProgress(
          Math.max(lastProgress, 55),
          `Build attempt ${attempt} rejected · ${failure.failureClass} · agent is revising`,
        );
        log("warn", "agent_v2.artifact_build_rejected", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          planSha,
          stagnationCount,
          ...failure,
        });
        return await buildFailureToolOutput({
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          failureClass: failure.failureClass,
          ruleOrPart: failure.ruleOrPart,
          message: failure.message,
          retryAdvice: advice,
          planSha,
          stagnationCount,
          ...(failure.diagnosticPath
            ? { diagnosticPath: failure.diagnosticPath }
            : {}),
        });
      }
    },
  });

  const acceptTool = tool({
    name: "accept_validated_artifact",
    description:
      "Accept one build that already passed build_and_validate_artifact. Call this only with an exact successful buildId. This is the terminal production-readiness gate.",
    parameters: z.object({ buildId: z.string().uuid() }),
    outputSchema: AcceptToolResultSchema,
    async execute({ buildId }) {
      const built = successfulBuilds.get(buildId);
      if (!built)
        throw new Error(
          "That buildId is not a validated build from this run. Build and validate a candidate first.",
        );
      acceptedBuildId = buildId;
      emitAgentProgress(98, `Validated artifact accepted · finalizing ${built.name}`);
      log("info", "agent_v2.artifact_accepted", {
        jobId: input.jobId,
        kind: input.kind,
        attempt,
        buildId,
        name: built.name,
      });
      return {
        ok: true as const,
        buildId,
        name: built.name,
        mime: built.mime,
        size: built.size,
      };
    },
  });

  const manifestEntries: Record<string, any> = {
    "REQUEST.md": file({
      content: [
        `# Agent Díaz V2 task`,
        ``,
        `Artifact kind: ${input.kind}`,
        ``,
        `## Current request`,
        input.prompt,
        input.priorContext
          ? `\n## Prior conversation context (reference only)\n${input.priorContext}`
          : "",
      ].join("\n"),
    }),
  };
  attachments.forEach((attachment, index) => {
    manifestEntries[`inputs/${safeWorkspaceName(attachment.name, index)}`] = localFile({
      src: attachment.path,
    });
  });

  for (const recoveryFile of listV2RecoveryFiles(workRoot))
    manifestEntries[recoveryFile.workspacePath] = localFile({
      src: recoveryFile.hostPath,
    });

  // localFile() materializes only the explicitly attached file into the sandbox.
  // Do not grant the agent its host upload directory: hosted/Docker sandboxes do
  // not need it, and Unix-local should not receive broader host filesystem access.
  const manifest = new Manifest({
    root: "/workspace",
    entries: manifestEntries,
  });

  emitAgentProgress(21, "Selecting execution plane and preparing sandbox");
  let sandboxRuntime: ReturnType<typeof createV2SandboxRuntime>;
  try {
    sandboxRuntime = createV2SandboxRuntime(input.jobId);
  } catch (error) {
    throw new ArtifactPipelineError(
      "INFRA",
      `Agent Díaz V2 configuration error: ${error instanceof Error ? error.message : String(error)}`,
      { ruleOrPart: "agent-v2-configuration", cause: error },
    );
  }

  let sandboxSession: any = null;
  let mcpRuntime: ReturnType<typeof createV2McpRuntime> | null = null;
  try {
    try {
      emitAgentProgress(23, `Creating ${sandboxRuntime.provider} workspace`);
      sandboxSession = await sandboxRuntime.client.create({ manifest });
      emitAgentProgress(25, `${sandboxRuntime.provider} workspace ready`);
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 sandbox creation failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-sandbox-create", cause: error },
      );
    }

    let internalDefinitions: import("./mcp-runtime.js").V2InternalMcpDefinition[] = [];
    let persistentPath: string | null =
      sandboxRuntime.provider === "render" ? workRoot : null;
    if (sandboxRuntime.provider === "cloudflare") {
      try {
        emitAgentProgress(27, "Preparing Cloudflare persistent workspace and browser bridge");
        const sandboxId = cloudflareSandboxIdFromSession(sandboxSession);
        const prepared = await prepareCloudflareWorkspace({
          jobId: input.jobId,
          sandboxId,
          workerUrl: process.env.CLOUDFLARE_SANDBOX_WORKER_URL ?? "",
          apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY ?? "",
          env: process.env,
          signal: input.signal,
        });
        internalDefinitions = prepared.mcpDefinitions;
        persistentPath = prepared.persistentPath;
      } catch (error) {
        throw new ArtifactPipelineError(
          "INFRA",
          `Agent Díaz V2 Cloudflare workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          { ruleOrPart: "agent-v2-cloudflare-workspace", cause: error },
        );
      }
    }

    try {
      emitAgentProgress(29, "Loading reviewed MCP capability definitions");
      mcpRuntime = createV2McpRuntime(input.config, process.env, {
        internalDefinitions,
      });
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 MCP configuration failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-configuration", cause: error },
      );
    }
    const mcpServers = mcpRuntime.servers;

    const agent = new SandboxAgent({
      name: "Agent Díaz V2 Artifact Engineer",
      model: input.model,
      instructions: v2ArtifactAgentInstructions(input.kind),
      defaultManifest: manifest,
      tools: [
        webSearchTool({ searchContextSize: "medium" }),
        codeInterpreterTool(),
        buildTool,
        acceptTool,
      ],
      mcpServers,
      mcpConfig: {
        // Browser MCP schemas contain constructs the strict converter cannot
        // normalize. The SDK falls back to the original schemas anyway, but
        // asking it to convert them floods production logs with false errors.
        convertSchemasToStrict: false,
        errorFunction: null,
        includeServerInToolNames: true,
      },
      modelSettings: {
        reasoning: { effort: input.reasoningEffort },
        toolChoice: "required",
      },
      // Force a tool on the first turn, then let the runner reset to auto so a
      // successful agent is not trapped in a required-tool loop forever.
      resetToolChoice: true,
      toolUseBehavior: { stopAtToolNames: ["accept_validated_artifact"] },
    });

    try {
      emitAgentProgress(
        31,
        mcpRuntime.descriptions.length
          ? `Connecting ${mcpRuntime.descriptions.map((item) => item.name).join(" + ")}`
          : "No MCP servers configured · continuing with sandbox tools",
      );
      await connectV2McpServers(mcpRuntime, input.jobId);
      emitAgentProgress(
        33,
        mcpRuntime.descriptions.length
          ? `MCP connected · ${mcpRuntime.descriptions.map((item) => item.name).join(" + ")}`
          : "Sandbox tools ready",
      );
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Agent Díaz V2 MCP connection failed: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "agent-v2-mcp-connect", cause: error },
      );
    }

    log("info", "agent_v2.run_started", {
      jobId: input.jobId,
      kind: input.kind,
      model: input.model,
      attachments: attachments.length,
      mcpEnabled: mcpServers.length > 0,
      mcpServers: mcpRuntime.descriptions,
      sandboxProvider: sandboxRuntime.provider,
      persistentPath,
    });

    let result: any;
    try {
      emitAgentProgress(35, "Agent reasoning started · researching and planning before first build");
      startHeartbeat();
      const stream = await run(
        agent,
        `Open REQUEST.md and complete the ${input.kind} request. Use the workspace, research/code tools as needed, and iterate build_and_validate_artifact until it passes. Finish only by calling accept_validated_artifact.`,
        {
          maxTurns: 256,
          stream: true,
          signal: input.signal,
          sandbox: { session: sandboxSession },
        },
      );

      for await (const event of stream.toStream()) {
        if (event.type === "agent_updated_stream_event") {
          emitAgentProgress(36, `Agent active · ${event.agent.name}`);
          continue;
        }
        if (event.type !== "run_item_stream_event") continue;

        if (event.item.type === "tool_call_item") {
          lastTool = streamToolName(event) ?? "tool";
          emitAgentProgress(
            38,
            `Using ${lastTool}`,
            { tool: lastTool },
          );
          log("info", "agent_v2.tool_call_started", {
            jobId: input.jobId,
            kind: input.kind,
            tool: lastTool,
            elapsedMs: Date.now() - startedAt,
          });
          continue;
        }

        if (event.item.type === "tool_call_output_item") {
          const completedTool = lastTool ?? "tool";
          emitAgentProgress(
            40,
            `${completedTool} returned · agent continuing`,
            { tool: completedTool },
          );
          log("info", "agent_v2.tool_call_completed", {
            jobId: input.jobId,
            kind: input.kind,
            tool: completedTool,
            elapsedMs: Date.now() - startedAt,
          });
          continue;
        }

        if (event.item.type === "message_output_item") {
          emitAgentProgress(42, "Agent completed a reasoning/output step · continuing toward validated artifact");
        }
      }
      await stream.completed;
      result = stream;
    } catch (error: any) {
      if (input.signal?.aborted || error?.name === "AbortError") throw error;
      if (error instanceof ArtifactPipelineError) throw error;
      const failure = classifyV2BuildFailure(error);
      throw new ArtifactPipelineError(
        failure.failureClass,
        `Agent Díaz V2 runtime failure: ${failure.message}`,
        { ruleOrPart: failure.ruleOrPart, cause: error },
      );
    } finally {
      stopHeartbeat();
    }

    if (!acceptedBuildId)
      throw new ArtifactPipelineError(
        "INFRA",
        "Agent Díaz V2 agent loop ended without accepting a validated artifact; the run will resume from its revision ledger.",
        { ruleOrPart: "agent-v2-agent-loop-ended" },
      );
    const accepted = successfulBuilds.get(acceptedBuildId);
    if (!accepted)
      throw new ArtifactPipelineError(
        "BUILD",
        "Agent Díaz V2 acceptance referenced a missing validated build.",
        { ruleOrPart: "agent-v2-accepted-build" },
      );

    const receipt = accepted.validationReceipt as unknown as Record<string, unknown>;
    receipt.agentRuntime = {
      version: "v2",
      harness: "@openai/agents",
      sandbox: sandboxRuntime.provider,
      persistentFilesystem: persistentPath,
      browserExecutionPlane:
        sandboxRuntime.provider === "cloudflare" ? "same-sandbox" : "host-compatible",
      mcp: mcpRuntime.descriptions,
      attempts: attempt,
      acceptance: "explicit-validated-build",
      recovery: "revision-ledger",
      diagnostics: "model-readable-file-output",
      telemetry: "streamed-tool-events-plus-heartbeat",
    };

    emitAgentProgress(99, `Agent run complete · ${attempt} build attempt${attempt === 1 ? "" : "s"} · packaging download`);
    log("info", "agent_v2.run_completed", {
      jobId: input.jobId,
      kind: input.kind,
      attempts: attempt,
      acceptedBuildId,
      name: accepted.name,
    });
    return {
      file: accepted,
      attempts: attempt,
      finalOutput: result.finalOutput,
    };
  } finally {
    stopHeartbeat();
    if (mcpRuntime) await closeV2McpServers(mcpRuntime, input.jobId);
    try {
      await sandboxSession?.close?.();
    } catch (error) {
      log("warn", "agent_v2.sandbox_close_failed", {
        jobId: input.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
