import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../db";
import type { Config } from "../config";
const dirs: string[] = [];
function database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-memory-"));
  dirs.push(root);
  const config = {
    root,
    dataDir: path.join(root, "data"),
    artifactDir: path.join(root, "artifacts"),
    uploadDir: path.join(root, "uploads"),
  } as Config;
  return openDatabase(config);
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
describe("conversation memory", () => {
  it("persists ordered turns and connects jobs to conversations", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "New conversation");
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Remember the blue folder",
      conversationId: c.id,
      fileIds: [],
    });
    db.addMessage({
      id: crypto.randomUUID(),
      conversationId: c.id,
      role: "assistant",
      content: "I will remember it.",
      jobId: j.id,
    });
    expect(db.listMessages(c.id).map((m) => m.content)).toEqual([
      "Remember the blue folder",
      "I will remember it.",
    ]);
    expect(db.getJob(j.id)?.conversationId).toBe(c.id);
    expect(db.getConversation(c.id)?.title).toBe("Remember the blue folder");
    db.close();
  });
  it("keeps five detailed conversations and archives overflow", () => {
    const db = database();
    for (let i = 1; i <= 6; i++)
      db.createConversation(crypto.randomUUID(), `Conversation ${i}`);
    const overflow = db.archiveOverflow();
    expect(overflow).toHaveLength(1);
    const archived = overflow[0]!;
    db.setConversationSummary(archived.id, "Durable compact summary");
    const rows = db.listConversations();
    expect(rows.filter((c) => c.status === "active")).toHaveLength(5);
    expect(rows.find((c) => c.id === archived.id)?.summary).toBe(
      "Durable compact summary",
    );
    db.close();
  });
  it("persists provider linkage for approval continuation", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Action");
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Perform the approved action",
      conversationId: c.id,
      fileIds: [],
    });
    const id = crypto.randomUUID();
    db.createApproval({
      id,
      jobId: j.id,
      tool: "calendar:create",
      summary: "Create event",
      argumentsJson: '{"title":"Review"}',
      providerItemId: "mcpr_test",
      providerResponseId: "resp_test",
    });
    expect(db.getApproval(id)).toMatchObject({
      jobId: j.id,
      status: "pending",
      providerItemId: "mcpr_test",
      providerResponseId: "resp_test",
    });
    db.decideApproval(id, "approved");
    expect(db.getApproval(id)?.status).toBe("approved");
    db.close();
  });
  it("retries without duplicating the failed user message", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Retry");
    db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Please identify yourself",
      conversationId: c.id,
      fileIds: [],
    });
    db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Please identify yourself",
      conversationId: c.id,
      fileIds: [],
      recordUserMessage: false,
    });
    expect(
      db
        .listMessages(c.id)
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["Please identify yourself"]);
    db.close();
  });
  it("persists a model mode and attachment on the visible user turn", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Files");
    db.setConversationMode(c.id, "deep");
    const uploadId = crypto.randomUUID();
    db.addUpload({
      id: uploadId,
      name: "evidence.png",
      mime: "image/png",
      size: 1234,
      path: "/tmp/evidence.png",
      openaiFileId: "file_test",
    });
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Inspect this image",
      conversationId: c.id,
      fileIds: [uploadId],
      modelMode: "deep",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(db.getConversation(c.id)?.modelMode).toBe("deep");
    expect(db.getJob(job.id)).toMatchObject({
      modelMode: "deep",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(db.listMessages(c.id)[0]?.attachments).toEqual([
      { id: uploadId, name: "evidence.png", mime: "image/png", size: 1234 },
    ]);
    db.close();
  });
  it("shares one conversation while snapshotting each selected persona", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Personas");
    const javierConversation = db.setConversationSettings(c.id, {
      persona: "javier",
    });
    expect(javierConversation.persona).toBe("javier");
    const javierJob = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Solve the generator problem",
      conversationId: c.id,
      fileIds: [],
    });
    db.addMessage({
      id: crypto.randomUUID(),
      conversationId: c.id,
      role: "assistant",
      content: "Asere, vamos a resolverlo.",
      jobId: javierJob.id,
      persona: javierJob.persona,
    });
    db.setConversationSettings(c.id, { persona: "vega" });
    const vegaJob = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Check the evidence",
      conversationId: c.id,
      fileIds: [],
    });
    expect(javierJob.persona).toBe("javier");
    expect(vegaJob.persona).toBe("vega");
    expect(db.getConversation(c.id)?.persona).toBe("vega");
    expect(
      db.listMessages(c.id).find((message) => message.role === "assistant")
        ?.persona,
    ).toBe("javier");
    db.close();
  });
  it("stores each voice exchange as one atomic user-assistant pair", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "New conversation");
    db.addVoiceTurn({
      conversationId: c.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText: "Can you hear me?",
      assistantText: "Loud and clear.",
      persona: "diaz",
    });
    expect(db.listMessages(c.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "Can you hear me?"],
      ["assistant", "Loud and clear."],
    ]);
    expect(db.listMessages(c.id)[1]?.persona).toBe("diaz");
    expect(db.getConversation(c.id)?.title).toBe("Can you hear me?");
    db.close();
  });
  it("repairs only the exact 3.2.4 transcription-prompt leak on restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-voice-repair-"));
    dirs.push(root);
    const config = {
      root,
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      uploadDir: path.join(root, "uploads"),
    } as Config;
    let db = openDatabase(config);
    const c = db.createConversation(crypto.randomUUID(), "Voice repair");
    db.addVoiceTurn({
      conversationId: c.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText:
        "Natural English, Spanish, or Cuban Spanish. Preserve Cuban words and names accurately, including asere, qué volá, hijadeputá, mariconá, comemierda, comepinga, morronga, carajo, pinga, and coño.",
      assistantText: "A beige answer generated from the contaminated turn.",
      persona: "javier",
    });
    db.addVoiceTurn({
      conversationId: c.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText: "Qué volá con el bloqueo",
      assistantText: "Asere, ahora sí va la respuesta de verdad, coño.",
      persona: "javier",
    });
    db.close();
    db = openDatabase(config);
    expect(db.listMessages(c.id).map((message) => message.content)).toEqual([
      "Qué volá con el bloqueo",
      "Asere, ahora sí va la respuesta de verdad, coño.",
    ]);
    db.close();
  });
  it("marks an interrupted live stream retryable after reopening storage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-recovery-"));
    dirs.push(root);
    const config = {
      root,
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      uploadDir: path.join(root, "uploads"),
    } as Config;
    let db = openDatabase(config);
    const c = db.createConversation(crypto.randomUUID(), "Recovery");
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Long answer",
      conversationId: c.id,
      fileIds: [],
    });
    const assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: c.id,
      role: "assistant",
      content: "Partial",
      jobId: job.id,
      status: "streaming",
    });
    db.updateJob(job.id, { status: "running" });
    db.close();
    db = openDatabase(config);
    expect(db.getJob(job.id)?.status).toBe("failed");
    expect(
      db.listMessages(c.id).find((m) => m.id === assistantId),
    ).toMatchObject({ status: "failed", content: "Partial" });
    db.close();
  });
  it("migrates a 3.1 database to persona-aware storage without losing conversations", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "diaz-persona-migration-"),
    );
    dirs.push(root);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const sqlitePath = path.join(dataDir, "agent-diaz.sqlite");
    const legacy = new Database(sqlitePath);
    legacy.exec(`
      CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',summary TEXT,model_mode TEXT NOT NULL DEFAULT 'balanced',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT NOT NULL,conversation_id TEXT NOT NULL,file_ids_json TEXT NOT NULL,provider_response_id TEXT,progress INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',output_text TEXT,error TEXT,model_mode TEXT NOT NULL DEFAULT 'balanced',model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',reasoning_effort TEXT NOT NULL DEFAULT 'medium',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,delivery_status TEXT NOT NULL DEFAULT 'complete',error TEXT,created_at TEXT NOT NULL);
    `);
    const conversationId = crypto.randomUUID();
    legacy
      .prepare(
        "INSERT INTO conversations VALUES(?,?,'active',NULL,'balanced',?,?)",
      )
      .run(
        conversationId,
        "Legacy conversation",
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      );
    legacy.close();
    const db = openDatabase({
      root,
      dataDir,
      artifactDir: path.join(root, "artifacts"),
      uploadDir: path.join(root, "uploads"),
    } as Config);
    expect(db.getConversation(conversationId)).toMatchObject({
      title: "Legacy conversation",
      persona: "diaz",
    });
    expect(
      (db.raw.prepare("PRAGMA table_info(jobs)").all() as any[]).map(
        (column) => column.name,
      ),
    ).toContain("persona");
    expect(
      (db.raw.prepare("PRAGMA table_info(messages)").all() as any[]).map(
        (column) => column.name,
      ),
    ).toContain("persona");
    db.close();
  });
});
