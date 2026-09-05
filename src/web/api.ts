import type {
  JobKind,
  JobView,
  ConversationView,
  MessageView,
  ModelMode,
  Persona,
  Voice,
} from "../shared/contracts";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data as T;
}
export const api = {
  session: () => call<{ authenticated: boolean }>("/api/session"),
  login: (password: string) =>
    call("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => call("/api/logout", { method: "POST", body: "{}" }),
  jobs: () => call<JobView[]>("/api/jobs"),
  skills: () => call<SkillView[]>("/api/skills"),
  conversations: () => call<ConversationView[]>("/api/conversations"),
  conversation: (id: string) =>
    call<ConversationView & { messages: MessageView[] }>(
      `/api/conversations/${id}`,
    ),
  createConversation: (title?: string) =>
    call<ConversationView>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  updateConversationSettings: (
    id: string,
    settings: { modelMode?: ModelMode; persona?: Persona },
  ) =>
    call<ConversationView>(`/api/conversations/${id}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  job: (id: string) =>
    call<JobView & { artifacts: ArtifactView[]; approvals: ApprovalView[] }>(
      `/api/jobs/${id}`,
    ),
  jobLogs: async (id: string): Promise<string> => {
    const response = await fetch(`/api/jobs/${id}/logs`, {
      headers: { Accept: "text/plain" },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text || `Log request failed (${response.status})`;
      try {
        message = JSON.parse(text).error || message;
      } catch {}
      throw new Error(message);
    }
    return text;
  },
  createJob: (input: {
    prompt: string;
    kind: JobKind;
    fileIds: string[];
    conversationId: string;
  }) =>
    call<JobView>("/api/jobs", { method: "POST", body: JSON.stringify(input) }),
  retry: (id: string) =>
    call<JobView>(`/api/jobs/${id}/retry`, { method: "POST", body: "{}" }),
  cancel: (id: string) =>
    call(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" }),
  upload: async (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return call<UploadBatchView>("/api/uploads", { method: "POST", body: fd });
  },
  decide: (id: string, decision: "approved" | "rejected") =>
    call(`/api/approvals/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  realtimeToken: (conversationId: string) =>
    call<RealtimeTokenView>("/api/realtime/token", {
      method: "POST",
      body: JSON.stringify({ conversationId }),
    }),
  speech: async (
    conversationId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<Blob> => {
    const response = await fetch("/api/voice/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({ conversationId, text }),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Speech failed (${response.status})`);
    }
    const contentType = response.headers.get("content-type") || "",
      bytes = await response.arrayBuffer(),
      header = new TextDecoder("ascii").decode(bytes.slice(0, 12));
    if (
      bytes.byteLength < 44 ||
      !contentType.toLowerCase().startsWith("audio/wav") ||
      !header.startsWith("RIFF") ||
      header.slice(8, 12) !== "WAVE"
    )
      throw new Error(
        `Díaz received invalid speech audio (${contentType || "missing MIME"}, ${bytes.byteLength} bytes)`,
      );
    return new Blob([bytes], { type: "audio/wav" });
  },
  saveVoiceTurn: (
    conversationId: string,
    persona: Persona,
    userText: string,
    assistantText: string,
  ) =>
    call("/api/voice/turns", {
      method: "POST",
      body: JSON.stringify({ conversationId, persona, userText, assistantText }),
    }),
  streamChat: async (
    input: {
      conversationId: string;
      prompt?: string;
      fileIds?: string[];
      retryJobId?: string;
    },
    handlers: { onEvent: (event: ChatStreamEvent) => void },
    signal: AbortSignal,
  ) => {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, fileIds: input.fileIds ?? [] }),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Chat failed (${response.status})`);
    }
    if (!response.body)
      throw new Error("This browser did not expose the chat stream");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = packet
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) handlers.onEvent(JSON.parse(data) as ChatStreamEvent);
      }
      if (done) break;
    }
  },
};
export interface UploadView {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface UploadBatchView {
  uploads: UploadView[];
  errors: Array<{ name: string; error: string }>;
}
export interface ArtifactView {
  id: string;
  jobId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}
export interface ApprovalView {
  id: string;
  jobId: string;
  tool: string;
  summary: string;
  arguments: unknown;
  status: string;
  createdAt: string;
}
export interface SkillView {
  id: string;
  kind: JobKind;
  name: string;
  description: string;
  tools: string[];
  artifact: string;
  minVisuals: number;
  validation: string[];
  approvalPolicy: string;
}
export interface RealtimeTokenView {
  value: string;
  expiresAt: number;
  model: string;
  voice: Voice;
  persona: Persona;
}
export type ChatStreamEvent =
  | {
      type: "ready";
      jobId: string;
      assistantMessageId: string;
      model: string;
      mode: ModelMode;
      reasoningEffort: string;
      persona: Persona;
    }
  | { type: "delta"; delta: string }
  | { type: "approval"; jobId: string; count: number }
  | { type: "done"; jobId: string; content: string }
  | { type: "error"; jobId?: string; error: string };
