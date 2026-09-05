import { describe, expect, it } from "vitest";
import {
  isInternalTranscriptionEcho,
  RealtimeVoiceTracker,
  runCanonicalVoiceTurn,
  splitSpeechText,
  voiceEventError,
} from "./realtime-voice";

describe("Android-safe Realtime voice tracking", () => {
  it("shows input transcript deltas and persists when final events arrive out of order", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "item-1" });
    expect(
      tracker.handle({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "Asere, ",
      }).userText,
    ).toBe("Asere, ");
    tracker.handle({
      type: "response.output_audio_transcript.done",
      transcript: "¡Dime, qué volá!",
    });
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Asere, ¿me oyes?",
    });
    expect(tracker.takeCompletedTurn()).toEqual({
      userText: "Asere, ¿me oyes?",
      assistantText: "¡Dime, qué volá!",
    });
  });

  it("does not combine a persisted turn with the next turn", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "First",
    });
    tracker.handle({
      type: "response.output_audio_transcript.done",
      transcript: "Answer one",
    });
    expect(tracker.takeCompletedTurn()?.userText).toBe("First");
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "two" });
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "two",
      transcript: "Second",
    });
    expect(tracker.snapshot()).toMatchObject({
      userText: "Second",
      assistantText: "",
    });
  });

  it("preserves an interrupted assistant transcript when the user barges in", () => {
    const tracker = new RealtimeVoiceTracker();
    tracker.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "Stop there",
    });
    tracker.handle({
      type: "response.output_audio_transcript.delta",
      delta: "The part you heard before interrupting.",
    });
    tracker.handle({ type: "input_audio_buffer.speech_started", item_id: "two" });
    expect(tracker.takeCompletedTurn()).toEqual({
      userText: "Stop there",
      assistantText: "The part you heard before interrupting.",
    });
    expect(tracker.snapshot().userText).toBe("");
  });

  it("surfaces the dedicated transcription failure instead of failing silently", () => {
    expect(
      voiceEventError({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "Audio was unintelligible" },
      }),
    ).toContain("transcription failed: Audio was unintelligible");
  });

  it("blocks the exact internal hint that 3.2.4 leaked into the user's chat", () => {
    expect(
      isInternalTranscriptionEcho(
        "Natural English, Spanish, or Cuban Spanish. Preserve Cuban words and names accurately, including asere, qué volá, hijadeputá, mariconá, comemierda, comepinga, morronga, carajo, pinga, and coño.",
      ),
    ).toBe(true);
    expect(isInternalTranscriptionEcho("Qué volá con el bloqueo")).toBe(false);
    expect(isInternalTranscriptionEcho("Qué volá")).toBe(false);
  });

  it("splits a long Javier answer without dropping or reordering any words", () => {
    const text = Array.from(
      { length: 240 },
      (_, index) => `Frase ${index} con candela y contexto.`,
    ).join(" ");
    const chunks = splitSpeechText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("routes the exact Android transcript through canonical chat and plays every final TTS chunk", async () => {
    const userText = "Qué volá con el bloqueo",
      finalText = Array.from(
        { length: 420 },
        (_, index) => `Golpe cubano ${index}, coño, sin bajar la cabeza.`,
      ).join(" "),
      streamedUsers: string[] = [],
      synthesized: string[] = [],
      played: string[] = [];
    const result = await runCanonicalVoiceTurn({
      userText,
      signal: new AbortController().signal,
      streamChat: async (text, onEvent) => {
        streamedUsers.push(text);
        onEvent({ type: "ready", jobId: "job-canonical" });
        onEvent({ type: "delta", delta: "Asere…" });
        onEvent({ type: "done", content: finalText });
      },
      synthesize: async (chunk) => {
        synthesized.push(chunk);
        return new Blob([chunk], { type: "audio/mpeg" });
      },
      play: async (audio) => {
        played.push(await audio.text());
      },
    });
    expect(streamedUsers).toEqual([userText]);
    expect(result).toBe(finalText);
    expect(synthesized.length).toBeGreaterThan(1);
    expect(synthesized.every((chunk) => chunk.length <= 3800)).toBe(true);
    expect(synthesized.join(" ")).toBe(finalText);
    expect(played).toEqual(synthesized);
  });

  it("never sends the leaked internal transcription prompt to canonical chat", async () => {
    let streamed = false;
    await expect(
      runCanonicalVoiceTurn({
        userText:
          "Natural English, Spanish, or Cuban Spanish. Preserve Cuban words and names accurately, including asere.",
        signal: new AbortController().signal,
        streamChat: async () => {
          streamed = true;
        },
        synthesize: async () => new Blob(),
        play: async () => undefined,
      }),
    ).rejects.toThrow("Internal transcription hint was blocked");
    expect(streamed).toBe(false);
  });
});
