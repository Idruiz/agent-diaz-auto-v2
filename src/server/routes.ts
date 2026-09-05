import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { AgentRunner } from "./openai-agent.js";
import {
  CreateJobSchema,
  CreateConversationSchema,
  ApprovalDecisionSchema,
  UpdateConversationSettingsSchema,
  StreamChatSchema,
  RealtimeTokenSchema,
  SpeechSchema,
  VoiceTurnSchema,
} from "../shared/contracts.js";
import { safeJoin } from "./files.js";
import { skills } from "./skills.js";
import { modelProfileFor } from "./openai-agent.js";
import { log } from "./log.js";
import { readArtifactRunLog } from "./artifact-run-log.js";

export function apiRoutes(
  config: Config,
  db: Db,
  runner: AgentRunner,
  auth: ReturnType<typeof import("./auth.js").createAuth>,
): Router {
  const r = Router();
  const uploadsExist = (ids: string[]) =>
    new Set(ids).size === ids.length &&
    db.getUploads(ids).length === ids.length;
  r.use(auth.verifyOrigin);
  r.post("/login", (req, res) => {
    const password = String(req.body?.password || "");
    if (!auth.login(password, res))
      return res.status(401).json({ error: "Invalid credentials" });
    res.json({ ok: true });
  });
  r.post("/logout", auth.requireAuth, (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  r.get("/session", (req, res) =>
    auth.requireAuth(req, res, () => res.json({ authenticated: true })),
  );
  r.use(auth.requireAuth);
  r.get("/skills", (_req, res) =>
    res.json(skills.map(({ instructions, ...publicSkill }) => publicSkill)),
  );
  r.get("/system/storage", (_req, res) => {
    const probe = path.join(
      config.storageRoot,
      `.diaz-write-${crypto.randomUUID()}`,
    );
    let writable = false;
    try {
      fs.writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
      fs.unlinkSync(probe);
      writable = true;
    } catch (error) {
      log("error", "storage.probe_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    res.json({
      writable,
      storageRoot: config.storageRoot,
      database: fs.existsSync(path.join(config.dataDir, "agent-diaz.sqlite")),
      uploads: (
        db.raw.prepare("SELECT COUNT(*) count FROM uploads").get() as {
          count: number;
        }
      ).count,
      artifacts: (
        db.raw.prepare("SELECT COUNT(*) count FROM artifacts").get() as {
          count: number;
        }
      ).count,
      conversations: (
        db.raw.prepare("SELECT COUNT(*) count FROM conversations").get() as {
          count: number;
        }
      ).count,
    });
  });
  r.get("/conversations", (_req, res) => res.json(db.listConversations()));
  r.post("/conversations", async (req, res, next) => {
    try {
      const p = CreateConversationSchema.safeParse(req.body);
      if (!p.success)
        return res.status(400).json({ error: "Invalid conversation" });
      const c = db.createConversation(
        crypto.randomUUID(),
        p.data.title || "New conversation",
      );
      const archived = db.archiveOverflow();
      for (const old of archived) await runner.compactConversation(old.id);
      res.status(201).json(c);
    } catch (e) {
      next(e);
    }
  });
  r.get("/conversations/:id", (req, res) => {
    const c = db.getConversation(req.params.id);
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    res.json({ ...c, messages: db.listMessages(c.id) });
  });
  r.patch("/conversations/:id/settings", (req, res) => {
    const parsed = UpdateConversationSettingsSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid conversation settings" });
    const conversation = db.getConversation(req.params.id);
    if (!conversation || conversation.status !== "active")
      return res.status(404).json({ error: "Active conversation not found" });
    res.json(db.setConversationSettings(conversation.id, parsed.data));
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) =>
        cb(
          null,
          `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
        ),
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  });
  r.post("/uploads", upload.array("files", 10), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length)
      return res.status(400).json({ error: "Select at least one file" });
    const rows = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const f of files) {
      try {
        const openaiFileId = await runner.upload({
          path: f.path,
          name: f.originalname,
        });
        const id = crypto.randomUUID();
        db.addUpload({
          id,
          name: f.originalname,
          mime: f.mimetype,
          size: f.size,
          path: f.path,
          openaiFileId,
        });
        rows.push({ id, name: f.originalname, mime: f.mimetype, size: f.size });
        log("info", "upload.ready", {
          id,
          name: f.originalname,
          mime: f.mimetype,
          size: f.size,
        });
      } catch (error) {
        try {
          fs.unlinkSync(f.path);
        } catch {}
        const message =
          error instanceof Error
            ? error.message
            : "OpenAI could not prepare this file";
        errors.push({ name: f.originalname, error: message });
        log("error", "upload.failed", {
          name: f.originalname,
          mime: f.mimetype,
          size: f.size,
          error: message,
        });
      }
    }
    res.status(errors.length ? 207 : 201).json({ uploads: rows, errors });
  });
  r.post("/chat/stream", async (req, res, next) => {
    const parsed = StreamChatSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid chat request", details: parsed.error.issues });
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    try {
      const conversation = db.getConversation(parsed.data.conversationId);
      if (!conversation || conversation.status !== "active")
        return res.status(404).json({ error: "Active conversation not found" });
      const active = db.raw
        .prepare(
          "SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval','building')",
        )
        .get(conversation.id);
      if (active)
        return res
          .status(409)
          .json({ error: "This conversation already has an active task" });
      let prompt = parsed.data.prompt ?? "",
        fileIds = parsed.data.fileIds,
        recordUserMessage = true,
        excludeAssistantJobId: string | undefined;
      if (!parsed.data.retryJobId && !uploadsExist(fileIds))
        return res
          .status(400)
          .json({ error: "One or more attachments are missing or duplicated" });
      if (parsed.data.retryJobId) {
        const original = db.getJob(parsed.data.retryJobId);
        if (
          !original ||
          original.kind !== "chat" ||
          original.conversationId !== conversation.id
        )
          return res.status(404).json({ error: "Retry source not found" });
        if (!["completed", "failed", "cancelled"].includes(original.status))
          return res
            .status(409)
            .json({ error: "This response is not ready to retry" });
        prompt = original.prompt;
        fileIds = db.getJobFileIds(original.id);
        recordUserMessage = false;
        excludeAssistantJobId = original.id;
      }
      const profile = modelProfileFor(conversation.modelMode);
      const job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt,
        conversationId: conversation.id,
        fileIds,
        recordUserMessage,
        modelMode: profile.mode,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
      });
      const assistantMessageId = crypto.randomUUID();
      db.addMessage({
        id: assistantMessageId,
        conversationId: conversation.id,
        role: "assistant",
        content: "",
        jobId: job.id,
        status: "streaming",
        persona: job.persona,
      });
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const send = (event: unknown) => {
        if (!res.writableEnded && !res.destroyed)
          res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
      }, 15_000);
      await runner.streamChat(
        job.id,
        assistantMessageId,
        {
          onReady: (data) =>
            send({
              type: "ready",
              ...data,
              model: profile.model,
              mode: profile.mode,
              reasoningEffort: profile.reasoningEffort,
              persona: job.persona,
            }),
          onDelta: (delta) => send({ type: "delta", delta }),
          onApproval: (count) =>
            send({ type: "approval", jobId: job.id, count }),
          onDone: (content) => send({ type: "done", jobId: job.id, content }),
          onError: (error) => send({ type: "error", jobId: job.id, error }),
        },
        controller.signal,
        excludeAssistantJobId,
      );
      clearInterval(keepAlive);
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (error) {
      if (keepAlive) clearInterval(keepAlive);
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(
            `data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Chat failed" })}\n\n`,
          );
          res.end();
        }
      } else next(error);
    }
  });
  r.post("/realtime/token", async (req, res, next) => {
    try {
      const parsed = RealtimeTokenSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "Invalid voice settings" });
      res.json(
        await runner.createRealtimeToken(parsed.data.conversationId),
      );
    } catch (error) {
      next(error);
    }
  });
  r.post("/voice/speech", async (req, res, next) => {
    try {
      const parsed = SpeechSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "Invalid speech request" });
      const audio = await runner.createSpeech(
        parsed.data.conversationId,
        parsed.data.text,
      );
      res.set({
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(audio);
    } catch (error) {
      next(error);
    }
  });
  r.post("/voice/turns", (req, res) => {
    const parsed = VoiceTurnSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid voice transcript" });
    const conversation = db.getConversation(parsed.data.conversationId);
    if (!conversation || conversation.status !== "active")
      return res.status(404).json({ error: "Active conversation not found" });
    db.addVoiceTurn({
      conversationId: conversation.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText: parsed.data.userText,
      assistantText: parsed.data.assistantText,
      persona: parsed.data.persona,
    });
    log("info", "voice.turn_saved", {
      conversationId: conversation.id,
      userCharacters: parsed.data.userText.length,
      assistantCharacters: parsed.data.assistantText.length,
      persona: parsed.data.persona,
    });
    res.status(201).json({ ok: true });
  });
  r.get("/jobs", (_req, res) => res.json(db.listJobs()));
  r.post("/jobs", (req, res) => {
    const parsed = CreateJobSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid job", details: parsed.error.issues });
    if (!parsed.data.conversationId)
      return res.status(400).json({ error: "conversationId is required" });
    if (parsed.data.kind === "chat")
      return res
        .status(400)
        .json({ error: "Use the streaming chat endpoint for ordinary chat" });
    const conversation = db.getConversation(parsed.data.conversationId);
    if (!conversation || conversation.status !== "active")
      return res.status(404).json({ error: "Active conversation not found" });
    if (!uploadsExist(parsed.data.fileIds))
      return res
        .status(400)
        .json({ error: "One or more attachments are missing or duplicated" });
    const active = db.raw
      .prepare(
        "SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval','building')",
      )
      .get(parsed.data.conversationId);
    if (active)
      return res
        .status(409)
        .json({ error: "This conversation already has an active task" });
    const profile = modelProfileFor(conversation.modelMode);
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: parsed.data.kind,
      prompt: parsed.data.prompt,
      conversationId: parsed.data.conversationId,
      fileIds: parsed.data.fileIds,
      modelMode: profile.mode,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
    });
    runner.start(j.id);
    res.status(202).json(j);
  });
  r.get("/jobs/:id", (req, res) => {
    const j = db.getJob(req.params.id);
    if (!j) return res.status(404).json({ error: "Job not found" });
    res.json({
      ...j,
      artifacts: db.listArtifacts(j.id),
      approvals: db.listApprovals(j.id),
    });
  });
  r.get("/jobs/:id/logs", (req, res) => {
    const j = db.getJob(req.params.id);
    if (!j) return res.status(404).json({ error: "Job not found" });
    if (j.kind === "chat")
      return res.status(400).json({ error: "Run logs are available for artifact jobs only" });
    const logs = readArtifactRunLog(config, j.id);
    res.type("text/plain; charset=utf-8").send(
      logs ||
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          event: "artifact.run_log_empty",
          jobId: j.id,
          status: j.status,
          message: "No structured artifact logs have been recorded for this run yet.",
        }) + "\n",
    );
  });
  r.post("/jobs/:id/retry", (req, res) => {
    const original = db.getJob(req.params.id);
    if (!original) return res.status(404).json({ error: "Job not found" });
    if (original.kind === "chat")
      return res.status(400).json({ error: "Use inline chat retry" });
    if (!["failed", "cancelled"].includes(original.status))
      return res
        .status(409)
        .json({ error: "Only failed or cancelled tasks can be retried" });
    const active = db.raw
      .prepare(
        "SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval','building')",
      )
      .get(original.conversationId);
    if (active)
      return res
        .status(409)
        .json({ error: "This conversation already has an active task" });
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: original.kind,
      prompt: original.prompt,
      conversationId: original.conversationId,
      fileIds: db.getJobFileIds(original.id),
      recordUserMessage: false,
      modelMode: original.modelMode,
      model: original.model,
      reasoningEffort: original.reasoningEffort,
    });
    runner.start(j.id);
    res.status(202).json(j);
  });
  r.post("/jobs/:id/cancel", async (req, res) => {
    const j = db.getJob(req.params.id);
    if (!j) return res.status(404).json({ error: "Job not found" });
    await runner.cancel(j.id);
    res.json({ ok: true });
  });
  r.get("/artifacts", (_req, res) => res.json(db.listArtifacts()));
  r.get("/artifacts/:id/download", (req, res) => {
    const a = db.getArtifact(req.params.id);
    if (!a) return res.status(404).json({ error: "Artifact not found" });
    const target = safeJoin(config.artifactDir, a.name);
    if (path.resolve(a.path) !== target || !fs.existsSync(target))
      return res.status(404).json({ error: "Artifact bytes missing" });
    res.download(target, a.name);
  });
  r.get("/approvals", (_req, res) => res.json(db.listApprovals()));
  r.post("/approvals/:id", async (req, res, next) => {
    try {
      const p = ApprovalDecisionSchema.safeParse(req.body);
      if (!p.success)
        return res.status(400).json({ error: "Invalid approval decision" });
      if (p.data.editedArguments)
        return res.status(400).json({
          error:
            "Editing MCP arguments is not supported; approve the exact request or reject it",
        });
      await runner.continueApproval(req.params.id, p.data.decision);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
