import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type {
  JobKind,
  JobStatus,
  JobView,
  ConversationView,
  MessageView,
  ModelMode,
  MessageStatus,
  Persona,
} from "../shared/contracts.js";
import { log } from "./log.js";
import type {
  ArtifactAttemptReceipt,
  ArtifactValidationReceipt,
} from "./artifact-quality.js";

export interface ArtifactRunState {
  startedAt: string;
  llmCalls: number;
  maxLlmCalls: number;
  attempts: ArtifactAttemptReceipt[];
  evidenceNumericValues?: string[];
  evidencePythonExecuted?: boolean;
}

export interface Db {
  raw: Database.Database;
  close(): void;
  createSession(id: string, hash: string, expiresAt: string): void;
  getSession(hash: string): { id: string; expiresAt: string } | undefined;
  deleteSession(hash: string): void;
  createJob(input: {
    id: string;
    kind: JobKind;
    prompt: string;
    conversationId: string;
    fileIds: string[];
    recordUserMessage?: boolean;
    modelMode?: ModelMode;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high";
    persona?: Persona;
  }): JobView;
  getJob(id: string): JobView | undefined;
  listJobs(limit?: number): JobView[];
  updateJob(
    id: string,
    patch: Partial<
      Pick<JobView, "status" | "progress" | "message" | "outputText" | "error">
    > & { providerResponseId?: string | null },
  ): void;
  getProviderResponseId(id: string): string | null;
  getArtifactRunState(id: string): ArtifactRunState | null;
  setArtifactRunState(id: string, state: ArtifactRunState): void;
  addArtifact(row: {
    id: string;
    jobId: string;
    name: string;
    mime: string;
    size: number;
    path: string;
    receipt: ArtifactValidationReceipt;
  }): void;
  listArtifacts(
    jobId?: string,
  ): Array<{
    id: string;
    jobId: string;
    name: string;
    mime: string;
    size: number;
    createdAt: string;
    receipt: ArtifactValidationReceipt | null;
  }>;
  getArtifact(
    id: string,
  ):
    | {
        id: string;
        jobId: string;
        name: string;
        mime: string;
        size: number;
        path: string;
        receipt: ArtifactValidationReceipt | null;
      }
    | undefined;
  addUpload(row: {
    id: string;
    name: string;
    mime: string;
    size: number;
    path: string;
    openaiFileId: string;
  }): void;
  getUploads(
    ids: string[],
  ): Array<{
    id: string;
    name: string;
    mime: string;
    size: number;
    path: string;
    openaiFileId: string;
  }>;
  getJobFileIds(id: string): string[];
  createApproval(row: {
    id: string;
    jobId: string;
    tool: string;
    summary: string;
    argumentsJson: string;
    providerItemId: string;
    providerResponseId: string;
  }): void;
  listApprovals(
    jobId?: string,
  ): Array<{
    id: string;
    jobId: string;
    tool: string;
    summary: string;
    arguments: unknown;
    status: string;
    createdAt: string;
  }>;
  decideApproval(
    id: string,
    status: "approved" | "rejected",
    argumentsJson?: string,
  ): void;
  getApproval(
    id: string,
  ):
    | {
        id: string;
        jobId: string;
        status: string;
        providerItemId: string;
        providerResponseId: string;
      }
    | undefined;
  createConversation(id: string, title: string): ConversationView;
  listConversations(): ConversationView[];
  getConversation(id: string): ConversationView | undefined;
  setConversationMode(id: string, mode: ModelMode): ConversationView;
  setConversationSettings(
    id: string,
    patch: { modelMode?: ModelMode; persona?: Persona },
  ): ConversationView;
  addMessage(row: {
    id: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    jobId?: string | null;
    status?: MessageStatus;
    error?: string | null;
    fileIds?: string[];
    persona?: Persona | null;
  }): void;
  updateMessage(
    id: string,
    patch: { content?: string; status?: MessageStatus; error?: string | null },
  ): void;
  addVoiceTurn(row: {
    conversationId: string;
    userId: string;
    assistantId: string;
    userText: string;
    assistantText: string;
    persona: Persona;
  }): void;
  listMessages(conversationId: string): MessageView[];
  archiveOverflow(): ConversationView[];
  setConversationSummary(id: string, summary: string): void;
  listArchiveSummaries(
    limit?: number,
  ): Array<{ title: string; summary: string; updatedAt: string }>;
}

function mapJob(r: any): JobView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    prompt: r.prompt,
    progress: r.progress,
    message: r.message,
    outputText: r.output_text,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    conversationId: r.conversation_id,
    modelMode: r.model_mode ?? "balanced",
    model: r.model ?? "gpt-5.6-terra",
    reasoningEffort: r.reasoning_effort ?? "medium",
    persona: r.persona ?? "diaz",
  };
}

function mapConversation(r: any): ConversationView {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    summary: r.summary,
    modelMode: r.model_mode ?? "balanced",
    persona: r.persona ?? "diaz",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count ?? 0),
  };
}

export function openDatabase(config: Config): Db {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new Database(path.join(config.dataDir, "agent-diaz.sqlite"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, conversation_id TEXT NOT NULL,
      file_ids_json TEXT NOT NULL, provider_response_id TEXT, progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
      output_text TEXT, error TEXT, model_mode TEXT NOT NULL DEFAULT 'balanced', model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
      reasoning_effort TEXT NOT NULL DEFAULT 'medium', persona TEXT NOT NULL DEFAULT 'diaz', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, path TEXT NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL,
      openai_file_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, tool TEXT NOT NULL, summary TEXT NOT NULL,
      arguments_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT,
      provider_item_id TEXT, provider_response_id TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',summary TEXT,model_mode TEXT NOT NULL DEFAULT 'balanced',persona TEXT NOT NULL DEFAULT 'diaz',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,delivery_status TEXT NOT NULL DEFAULT 'complete',error TEXT,persona TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message_uploads(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,PRIMARY KEY(message_id,upload_id));
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_message_uploads_upload ON message_uploads(upload_id);
  `);
  const ensureColumn = (table: string, name: string, sql: string) => {
    const columns = (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    if (!columns.includes(name))
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  };
  ensureColumn(
    "jobs",
    "model_mode",
    "model_mode TEXT NOT NULL DEFAULT 'balanced'",
  );
  ensureColumn("jobs", "model", "model TEXT NOT NULL DEFAULT 'gpt-5.6-terra'");
  ensureColumn(
    "jobs",
    "reasoning_effort",
    "reasoning_effort TEXT NOT NULL DEFAULT 'medium'",
  );
  ensureColumn(
    "conversations",
    "model_mode",
    "model_mode TEXT NOT NULL DEFAULT 'balanced'",
  );
  ensureColumn("jobs", "persona", "persona TEXT NOT NULL DEFAULT 'diaz'");
  ensureColumn(
    "conversations",
    "persona",
    "persona TEXT NOT NULL DEFAULT 'diaz'",
  );
  ensureColumn(
    "messages",
    "delivery_status",
    "delivery_status TEXT NOT NULL DEFAULT 'complete'",
  );
  ensureColumn("messages", "error", "error TEXT");
  ensureColumn("messages", "persona", "persona TEXT");
  ensureColumn("artifacts", "receipt_json", "receipt_json TEXT");
  ensureColumn("jobs", "artifact_run_state_json", "artifact_run_state_json TEXT");
  const leakedVoiceTurns = raw
    .prepare(
      `SELECT rowid,id,conversation_id conversationId,created_at createdAt
       FROM messages
       WHERE role='user' AND job_id IS NULL
         AND LOWER(content) LIKE 'natural english, spanish, or cuban spanish.%preserve cuban words and names accurately%'`,
    )
    .all() as Array<{
      rowid: number;
      id: string;
      conversationId: string;
      createdAt: string;
    }>;
  if (leakedVoiceTurns.length) {
    let removedMessages = 0;
    raw.transaction(() => {
      for (const leaked of leakedVoiceTurns) {
        const pairedAssistant = raw
          .prepare(
            `SELECT id FROM messages
             WHERE conversation_id=? AND role='assistant' AND job_id IS NULL
               AND persona IS NOT NULL AND created_at=? AND rowid>?
             ORDER BY rowid LIMIT 1`,
          )
          .get(leaked.conversationId, leaked.createdAt, leaked.rowid) as
          | { id: string }
          | undefined;
        if (pairedAssistant) {
          raw.prepare("DELETE FROM messages WHERE id=?").run(pairedAssistant.id);
          removedMessages++;
        }
        raw.prepare("DELETE FROM messages WHERE id=?").run(leaked.id);
        removedMessages++;
      }
    })();
    log("warn", "db.leaked_voice_turns_removed", {
      contaminatedTurns: leakedVoiceTurns.length,
      removedMessages,
    });
  }
  raw
    .prepare(
      "UPDATE messages SET delivery_status='failed',error=COALESCE(error,'The live response was interrupted by a service restart. Retry is safe.') WHERE delivery_status='streaming'",
    )
    .run();
  raw
    .prepare(
      "UPDATE jobs SET status='failed',message='Interrupted by restart',error=COALESCE(error,'The live response was interrupted by a service restart. Retry is safe.'),updated_at=? WHERE kind='chat' AND status IN ('queued','running')",
    )
    .run(new Date().toISOString());
  const approvalColumns = (
    raw.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!approvalColumns.includes("provider_item_id"))
    raw.exec("ALTER TABLE approvals ADD COLUMN provider_item_id TEXT");
  if (!approvalColumns.includes("provider_response_id"))
    raw.exec("ALTER TABLE approvals ADD COLUMN provider_response_id TEXT");
  const now = () => new Date().toISOString();
  return {
    raw,
    close: () => raw.close(),
    createSession: (id, hash, expiresAt) =>
      raw
        .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
        .run(id, hash, expiresAt, now()),
    getSession: (hash) =>
      raw
        .prepare(
          "SELECT id, expires_at expiresAt FROM sessions WHERE token_hash=? AND expires_at>?",
        )
        .get(hash, now()) as any,
    deleteSession: (hash) => {
      raw.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash);
    },
    createJob: (input) => {
      if (
        !raw
          .prepare("SELECT 1 FROM conversations WHERE id=? AND status='active'")
          .get(input.conversationId)
      )
        throw new Error("Conversation is missing or archived");
      const conversation = raw
        .prepare(
          "SELECT model_mode modelMode,persona FROM conversations WHERE id=?",
        )
        .get(input.conversationId) as {
          modelMode: ModelMode;
          persona: Persona;
        };
      const modelMode = input.modelMode ?? conversation.modelMode ?? "balanced",
        model = input.model ?? "gpt-5.6-terra",
        reasoningEffort = input.reasoningEffort ?? "medium",
        persona = input.persona ?? conversation.persona ?? "diaz";
      const t = now();
      raw
        .prepare(
          `INSERT INTO jobs(id,kind,status,prompt,conversation_id,file_ids_json,progress,message,model_mode,model,reasoning_effort,persona,created_at,updated_at) VALUES(?,?,'queued',?,?,?,0,'Queued',?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.kind,
          input.prompt,
          input.conversationId,
          JSON.stringify(input.fileIds),
          modelMode,
          model,
          reasoningEffort,
          persona,
          t,
          t,
        );
      if (input.recordUserMessage !== false) {
        const messageId = crypto.randomUUID();
        raw
          .prepare(
            "INSERT INTO messages(id,conversation_id,role,content,job_id,delivery_status,persona,created_at) VALUES(?,?,'user',?,?,'complete',NULL,?)",
          )
          .run(messageId, input.conversationId, input.prompt, input.id, t);
        for (const fileId of input.fileIds)
          raw
            .prepare(
              "INSERT INTO message_uploads(message_id,upload_id) VALUES(?,?)",
            )
            .run(messageId, fileId);
      }
      raw
        .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
        .run(t, input.conversationId);
      raw
        .prepare(
          "UPDATE conversations SET title=? WHERE id=? AND title='New conversation'",
        )
        .run(
          input.prompt.replace(/\s+/g, " ").slice(0, 72),
          input.conversationId,
        );
      return mapJob(raw.prepare("SELECT * FROM jobs WHERE id=?").get(input.id));
    },
    getJob: (id) => {
      const r = raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);
      return r ? mapJob(r) : undefined;
    },
    listJobs: (limit = 50) =>
      raw
        .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit)
        .map(mapJob),
    updateJob: (id, p) => {
      const allowed: Record<string, string> = {
        status: "status",
        progress: "progress",
        message: "message",
        outputText: "output_text",
        error: "error",
        providerResponseId: "provider_response_id",
      };
      const pairs = Object.entries(p)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => `${allowed[k]}=@${k}`);
      if (!pairs.length) return;
      raw
        .prepare(
          `UPDATE jobs SET ${pairs.join(",")}, updated_at=@updatedAt WHERE id=@id`,
        )
        .run({ ...p, id, updatedAt: now() });
    },
    getProviderResponseId: (id) =>
      (
        raw
          .prepare("SELECT provider_response_id id FROM jobs WHERE id=?")
          .get(id) as any
      )?.id ?? null,
    getArtifactRunState: (id) => {
      const row = raw
        .prepare(
          "SELECT artifact_run_state_json state FROM jobs WHERE id=?",
        )
        .get(id) as { state: string | null } | undefined;
      if (!row?.state) return null;
      try {
        return JSON.parse(row.state) as ArtifactRunState;
      } catch {
        return null;
      }
    },
    setArtifactRunState: (id, state) => {
      raw
        .prepare(
          "UPDATE jobs SET artifact_run_state_json=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(state), now(), id);
    },
    addArtifact: (r) =>
      raw
        .prepare(
          "INSERT INTO artifacts(id,job_id,name,mime,size,path,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          r.id,
          r.jobId,
          r.name,
          r.mime,
          r.size,
          r.path,
          JSON.stringify(r.receipt),
          now(),
        ),
    listArtifacts: (jobId) =>
      (jobId
        ? raw
            .prepare(
              "SELECT id,job_id jobId,name,mime,size,receipt_json receiptJson,created_at createdAt FROM artifacts WHERE job_id=? ORDER BY created_at DESC",
            )
            .all(jobId)
        : raw
            .prepare(
              "SELECT id,job_id jobId,name,mime,size,receipt_json receiptJson,created_at createdAt FROM artifacts ORDER BY created_at DESC LIMIT 100",
            )
            .all()
      ).map((row: any) => ({
        id: row.id,
        jobId: row.jobId,
        name: row.name,
        mime: row.mime,
        size: row.size,
        createdAt: row.createdAt,
        receipt: row.receiptJson ? JSON.parse(row.receiptJson) : null,
      })) as any,
    getArtifact: (id) => {
      const row = raw
        .prepare(
          "SELECT id,job_id jobId,name,mime,size,path,receipt_json receiptJson FROM artifacts WHERE id=?",
        )
        .get(id) as any;
      return row
        ? {
            id: row.id,
            jobId: row.jobId,
            name: row.name,
            mime: row.mime,
            size: row.size,
            path: row.path,
            receipt: row.receiptJson ? JSON.parse(row.receiptJson) : null,
          }
        : undefined;
    },
    addUpload: (r) =>
      raw
        .prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?)")
        .run(r.id, r.name, r.mime, r.size, r.path, r.openaiFileId, now()),
    getUploads: (ids) =>
      ids.length
        ? (raw
            .prepare(
              `SELECT id,name,mime,size,path,openai_file_id openaiFileId FROM uploads WHERE id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(...ids) as any)
        : [],
    getJobFileIds: (id) => {
      const row = raw
        .prepare("SELECT file_ids_json ids FROM jobs WHERE id=?")
        .get(id) as { ids: string } | undefined;
      return row ? JSON.parse(row.ids) : [];
    },
    createApproval: (r) =>
      raw
        .prepare(
          "INSERT INTO approvals(id,job_id,tool,summary,arguments_json,status,created_at,provider_item_id,provider_response_id) VALUES(?,?,?,?,?,'pending',?,?,?)",
        )
        .run(
          r.id,
          r.jobId,
          r.tool,
          r.summary,
          r.argumentsJson,
          now(),
          r.providerItemId,
          r.providerResponseId,
        ),
    listApprovals: (jobId) =>
      (jobId
        ? raw
            .prepare(
              "SELECT * FROM approvals WHERE job_id=? ORDER BY created_at DESC",
            )
            .all(jobId)
        : raw
            .prepare(
              "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100",
            )
            .all()
      ).map((r: any) => ({
        id: r.id,
        jobId: r.job_id,
        tool: r.tool,
        summary: r.summary,
        arguments: JSON.parse(r.arguments_json),
        status: r.status,
        createdAt: r.created_at,
      })),
    decideApproval: (id, status, args) => {
      raw
        .prepare(
          "UPDATE approvals SET status=?, arguments_json=COALESCE(?,arguments_json), decided_at=? WHERE id=? AND status='pending'",
        )
        .run(status, args ?? null, now(), id);
    },
    getApproval: (id) =>
      raw
        .prepare(
          "SELECT id,job_id jobId,status,provider_item_id providerItemId,provider_response_id providerResponseId FROM approvals WHERE id=?",
        )
        .get(id) as any,
    createConversation: (id, title) => {
      const t = now();
      raw
        .prepare(
          "INSERT INTO conversations(id,title,status,model_mode,persona,created_at,updated_at) VALUES(?,?,'active','balanced','diaz',?,?)",
        )
        .run(id, title, t, t);
      return mapConversation(
        raw
          .prepare("SELECT c.*,0 message_count FROM conversations c WHERE id=?")
          .get(id),
      );
    },
    listConversations: () =>
      raw
        .prepare(
          "SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c ORDER BY status='active' DESC,updated_at DESC",
        )
        .all()
        .map(mapConversation),
    getConversation: (id) => {
      const r = raw
        .prepare(
          "SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE id=?",
        )
        .get(id);
      return r ? mapConversation(r) : undefined;
    },
    setConversationMode: (id, mode) => {
      raw
        .prepare(
          "UPDATE conversations SET model_mode=?,updated_at=? WHERE id=? AND status='active'",
        )
        .run(mode, now(), id);
      const row = raw
        .prepare(
          "SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE id=?",
        )
        .get(id);
      if (!row) throw new Error("Conversation not found");
      return mapConversation(row);
    },
    setConversationSettings: (id, patch) => {
      const updates: string[] = [];
      const params: Record<string, unknown> = { id, updatedAt: now() };
      if (patch.modelMode !== undefined) {
        updates.push("model_mode=@modelMode");
        params.modelMode = patch.modelMode;
      }
      if (patch.persona !== undefined) {
        updates.push("persona=@persona");
        params.persona = patch.persona;
      }
      if (!updates.length) throw new Error("No conversation settings supplied");
      raw
        .prepare(
          `UPDATE conversations SET ${updates.join(",")},updated_at=@updatedAt WHERE id=@id AND status='active'`,
        )
        .run(params);
      const row = raw
        .prepare(
          "SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE id=?",
        )
        .get(id);
      if (!row) throw new Error("Conversation not found");
      return mapConversation(row);
    },
    addMessage: (r) => {
      const t = now();
      raw
        .prepare(
          "INSERT INTO messages(id,conversation_id,role,content,job_id,delivery_status,error,persona,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.id,
          r.conversationId,
          r.role,
          r.content,
          r.jobId ?? null,
          r.status ?? "complete",
          r.error ?? null,
          r.persona ?? null,
          t,
        );
      for (const fileId of r.fileIds ?? [])
        raw
          .prepare(
            "INSERT INTO message_uploads(message_id,upload_id) VALUES(?,?)",
          )
          .run(r.id, fileId);
      raw
        .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
        .run(t, r.conversationId);
      if (r.role === "user")
        raw
          .prepare(
            "UPDATE conversations SET title=? WHERE id=? AND title='New conversation'",
          )
          .run(r.content.replace(/\s+/g, " ").slice(0, 72), r.conversationId);
    },
    updateMessage: (id, p) => {
      const allowed: Record<string, string> = {
        content: "content",
        status: "delivery_status",
        error: "error",
      };
      const pairs = Object.entries(p)
        .filter(([, v]) => v !== undefined)
        .map(([key]) => `${allowed[key]}=@${key}`);
      if (pairs.length)
        raw
          .prepare(`UPDATE messages SET ${pairs.join(",")} WHERE id=@id`)
          .run({ ...p, id });
    },
    addVoiceTurn: (r) => {
      const t = now();
      raw.transaction(() => {
        raw
          .prepare(
            "INSERT INTO messages(id,conversation_id,role,content,delivery_status,persona,created_at) VALUES(?,?,'user',?,'complete',NULL,?)",
          )
          .run(r.userId, r.conversationId, r.userText, t);
        raw
          .prepare(
            "INSERT INTO messages(id,conversation_id,role,content,delivery_status,persona,created_at) VALUES(?,?,'assistant',?,'complete',?,?)",
          )
          .run(r.assistantId, r.conversationId, r.assistantText, r.persona, t);
        raw
          .prepare(
            "UPDATE conversations SET updated_at=?,title=CASE WHEN title='New conversation' THEN ? ELSE title END WHERE id=?",
          )
          .run(
            t,
            r.userText.replace(/\s+/g, " ").slice(0, 72),
            r.conversationId,
          );
      })();
    },
    listMessages: (id) => {
      const rows = raw
        .prepare(
          "SELECT id,conversation_id conversationId,role,content,job_id jobId,delivery_status status,error,persona,created_at createdAt FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
        )
        .all(id) as Array<Omit<MessageView, "attachments">>;
      const attachments = raw.prepare(
        "SELECT u.id,u.name,u.mime,u.size FROM message_uploads mu JOIN uploads u ON u.id=mu.upload_id WHERE mu.message_id=? ORDER BY u.created_at",
      );
      return rows.map((row) => ({
        ...row,
        attachments: attachments.all(row.id) as any,
      }));
    },
    archiveOverflow: () => {
      const overflow = raw
        .prepare(
          "SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE status='active' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running','waiting_approval','building')) ORDER BY updated_at DESC LIMIT -1 OFFSET 5",
        )
        .all() as any[];
      const tx = raw.transaction(() => {
        for (const c of overflow)
          raw
            .prepare("UPDATE conversations SET status='archived' WHERE id=?")
            .run(c.id);
      });
      tx();
      return overflow.map(mapConversation);
    },
    setConversationSummary: (id, summary) => {
      raw
        .prepare(
          "UPDATE conversations SET summary=?,status='archived' WHERE id=?",
        )
        .run(summary, id);
    },
    listArchiveSummaries: (limit = 20) =>
      raw
        .prepare(
          "SELECT title,summary,updated_at updatedAt FROM conversations WHERE status='archived' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
        )
        .all(limit) as any,
  };
}
