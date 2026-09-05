export type RealtimeVoiceEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  event_id?: string;
  error?: { message?: string; code?: string };
  response?: { status?: string; status_details?: { error?: { message?: string } } };
};

export type VoiceTurn = { userText: string; assistantText: string };

export interface VoiceSnapshot {
  userText: string;
  assistantText: string;
  speechActive: boolean;
  userComplete: boolean;
  assistantComplete: boolean;
}

const LEAKED_TRANSCRIPTION_PROMPT =
  /preserve cuban words and names accurately|natural english, spanish, or cuban spanish/i;

export function isInternalTranscriptionEcho(text: string): boolean {
  return LEAKED_TRANSCRIPTION_PROMPT.test(text.trim());
}

export function splitSpeechText(text: string, limit = 3800): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (!Number.isInteger(limit) || limit < 200)
    throw new Error("Speech chunk limit must be an integer of at least 200");
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("; "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    ].filter((index) => index >= Math.floor(limit * 0.55));
    const boundary = candidates.length ? Math.max(...candidates) + 1 : limit;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export type CanonicalVoiceChatEvent =
  | { type: "ready"; jobId: string }
  | { type: "delta"; delta: string }
  | { type: "done"; content: string }
  | { type: "error"; error: string }
  | { type: "approval"; jobId: string; count: number };

export async function runCanonicalVoiceTurn(options: {
  userText: string;
  signal: AbortSignal;
  streamChat: (
    userText: string,
    onEvent: (event: CanonicalVoiceChatEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  synthesize: (text: string, signal: AbortSignal) => Promise<Blob>;
  play: (audio: Blob, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: CanonicalVoiceChatEvent) => void;
  onSpeechChunk?: (index: number, total: number) => void;
}): Promise<string> {
  const userText = options.userText.trim();
  if (!userText) throw new Error("Voice transcript was empty");
  if (isInternalTranscriptionEcho(userText))
    throw new Error("Internal transcription hint was blocked");
  let finalText = "",
    streamError = "";
  await options.streamChat(
    userText,
    (event) => {
      options.onEvent?.(event);
      if (event.type === "done") finalText = event.content.trim();
      if (event.type === "error") streamError = event.error;
    },
    options.signal,
  );
  if (streamError) throw new Error(streamError);
  if (!finalText)
    throw new Error("The canonical chat path returned no final response.");
  const chunks = splitSpeechText(finalText);
  for (let index = 0; index < chunks.length; index++) {
    options.onSpeechChunk?.(index, chunks.length);
    const audio = await options.synthesize(chunks[index]!, options.signal);
    await options.play(audio, options.signal);
  }
  return finalText;
}

/**
 * Realtime transcription and response events are asynchronous and may arrive
 * in either order. This tracker reconciles partial/final input by item_id and
 * only releases a durable turn when both sides are complete.
 */
export class RealtimeVoiceTracker {
  private inputByItem = new Map<string, string>();
  private completedTurns: VoiceTurn[] = [];
  private currentInputId = "pending";
  private userText = "";
  private assistantText = "";
  private userComplete = false;
  private assistantComplete = false;
  private speechActive = false;

  handle(event: RealtimeVoiceEvent): VoiceSnapshot {
    const type = event.type ?? "";
    if (type === "input_audio_buffer.speech_started") {
      if (this.userComplete && this.userText.trim() && this.assistantText.trim())
        this.completedTurns.push({
          userText: this.userText.trim(),
          assistantText: this.assistantText.trim(),
        });
      this.speechActive = true;
      this.userComplete = false;
      this.assistantComplete = false;
      this.userText = "";
      this.assistantText = "";
      this.currentInputId = event.item_id || "pending";
      this.inputByItem.set(this.currentInputId, "");
    }
    if (type === "input_audio_buffer.speech_stopped")
      this.speechActive = false;

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = event.item_id || this.currentInputId;
      const next = `${this.inputByItem.get(itemId) ?? ""}${event.delta ?? ""}`;
      this.inputByItem.set(itemId, next);
      this.currentInputId = itemId;
      this.userText = next;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = event.item_id || this.currentInputId;
      const finalText = String(
        event.transcript ?? this.inputByItem.get(itemId) ?? "",
      ).trim();
      this.inputByItem.set(itemId, finalText);
      this.currentInputId = itemId;
      this.userText = finalText;
      this.userComplete = finalText.length > 0;
    }

    if (
      [
        "response.output_audio_transcript.delta",
        "response.audio_transcript.delta",
      ].includes(type)
    )
      this.assistantText += String(event.delta ?? "");

    if (
      [
        "response.output_audio_transcript.done",
        "response.audio_transcript.done",
      ].includes(type)
    ) {
      this.assistantText = String(
        event.transcript ?? this.assistantText,
      ).trim();
      this.assistantComplete = this.assistantText.length > 0;
    }
    if (type === "response.done" && this.assistantText.trim())
      this.assistantComplete = true;

    return this.snapshot();
  }

  snapshot(): VoiceSnapshot {
    return {
      userText: this.userText,
      assistantText: this.assistantText,
      speechActive: this.speechActive,
      userComplete: this.userComplete,
      assistantComplete: this.assistantComplete,
    };
  }

  takeCompletedTurn(): VoiceTurn | null {
    const queued = this.completedTurns.shift();
    if (queued) return queued;
    if (
      !this.userComplete ||
      !this.assistantComplete ||
      !this.userText.trim() ||
      !this.assistantText.trim()
    )
      return null;
    const turn = {
      userText: this.userText.trim(),
      assistantText: this.assistantText.trim(),
    };
    this.resetTurn();
    return turn;
  }

  resetTurn(): void {
    this.inputByItem.clear();
    this.completedTurns = [];
    this.currentInputId = "pending";
    this.userText = "";
    this.assistantText = "";
    this.userComplete = false;
    this.assistantComplete = false;
    this.speechActive = false;
  }
}

export function voiceEventError(event: RealtimeVoiceEvent): string | null {
  if (event.type === "conversation.item.input_audio_transcription.failed")
    return `Microphone audio reached OpenAI, but transcription failed: ${event.error?.message ?? "unknown transcription error"}`;
  if (event.type === "error")
    return `Voice error: ${event.error?.message ?? "Realtime session failed"}`;
  if (event.type === "response.done" && event.response?.status === "failed")
    return `Voice response failed: ${event.response.status_details?.error?.message ?? "OpenAI could not complete the response"}`;
  return null;
}

export function sendRealtimeEvent(
  channel: RTCDataChannel,
  event: Record<string, unknown>,
): void {
  if (channel.readyState !== "open")
    throw new Error("Voice connection is not ready. End voice and try again.");
  channel.send(JSON.stringify(event));
}
