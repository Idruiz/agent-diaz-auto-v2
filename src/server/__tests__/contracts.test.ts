import { describe, expect, it } from "vitest";
import {
  ArtifactPlanSchema,
  CreateJobSchema,
  RealtimeTokenSchema,
  SpeechSchema,
  StreamChatSchema,
  UpdateConversationSettingsSchema,
} from "../../shared/contracts";
import { PERSONAS } from "../../shared/personas";
import { personaInstructions } from "../personas";
import {
  isImageUpload,
  isSpreadsheetUpload,
  modelProfileFor,
  providerFailureMessage,
} from "../openai-agent";
describe("contracts", () => {
  it("rejects empty jobs", () => {
    expect(
      CreateJobSchema.safeParse({ prompt: "", kind: "chat" }).success,
    ).toBe(false);
  });
  it("requires a prompt unless chat is an explicit retry", () => {
    expect(
      StreamChatSchema.safeParse({
        conversationId: crypto.randomUUID(),
        fileIds: [],
      }).success,
    ).toBe(false);
    expect(
      StreamChatSchema.safeParse({
        conversationId: crypto.randomUUID(),
        fileIds: [],
        retryJobId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });
  it("locks the three production model profiles", () => {
    expect(modelProfileFor("quick")).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
    expect(modelProfileFor("balanced")).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    expect(modelProfileFor("deep")).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });
  it("locks seven distinct OpenAI Realtime persona voices", () => {
    expect(PERSONAS.map((persona) => persona.id)).toEqual([
      "diaz",
      "javier",
      "karen",
      "vega",
      "mara",
      "luz",
      "salcedo",
    ]);
    expect(new Set(PERSONAS.map((persona) => persona.voice)).size).toBe(7);
    expect(PERSONAS.find((persona) => persona.id === "javier")).toMatchObject({
      voice: "echo",
      voiceLabel: "Echo · Cuban cadence",
    });
    expect(PERSONAS.find((persona) => persona.id === "karen")).toMatchObject({
      voice: "shimmer",
      voiceLabel: "Shimmer · Canadian outrage",
    });
  });
  it("keeps persona selection server-owned and rejects empty settings", () => {
    expect(
      UpdateConversationSettingsSchema.safeParse({ persona: "javier" })
        .success,
    ).toBe(true);
    expect(UpdateConversationSettingsSchema.safeParse({}).success).toBe(false);
    const parsed = RealtimeTokenSchema.parse({
      conversationId: crypto.randomUUID(),
      voice: "cedar",
    });
    expect(parsed).not.toHaveProperty("voice");
  });
  it("bounds every TTS chunk so a long answer must be played completely in parts", () => {
    expect(
      SpeechSchema.safeParse({
        conversationId: crypto.randomUUID(),
        text: "A".repeat(4000),
      }).success,
    ).toBe(true);
    expect(
      SpeechSchema.safeParse({
        conversationId: crypto.randomUUID(),
        text: "A".repeat(4001),
      }).success,
    ).toBe(false);
  });
  it("defines Javier as street-educated, unfiltered, and memory-safe", () => {
    const instructions = personaInstructions("javier");
    expect(instructions).toContain("CURRENT PERSONA: Javier");
    expect(instructions).toContain("street-educated, street-smart Cuban rebel");
    expect(instructions).toContain("Swear naturally throughout almost every answer");
    expect(instructions).toContain("Default to a flowing rant or diatribe");
    expect(instructions).toContain(
      "irreverent, unhinged-but-coherent, contrarian, and subversive",
    );
    expect(instructions).toContain("Swear like a Cuban sailor");
    expect(instructions).toContain(
      "Never shorten the reasoning merely because the user is speaking",
    );
    expect(instructions).toContain(
      "Do not reflexively \"balance both sides,\"",
    );
    expect(instructions).toContain("university-trained assistant wearing Cuban slang");
    expect(instructions).toContain("refuse only the dangerous part in one blunt sentence");
    expect(instructions).toContain("not a separate factual database");
    expect(instructions).toContain("Never turn jokes, profanity");
  });
  it("routes images and spreadsheets by actual file metadata", () => {
    expect(isImageUpload("image/png")).toBe(true);
    expect(isImageUpload("application/octet-stream", "photo.webp")).toBe(true);
    expect(
      isSpreadsheetUpload("results.xlsx", "application/octet-stream"),
    ).toBe(true);
    expect(
      isSpreadsheetUpload(
        "brief.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });
  it("rejects invented non-url sources", () => {
    expect(
      ArtifactPlanSchema.safeParse({
        title: "x",
        sections: [{ heading: "h", body: "b", bullets: [] }],
        sources: [{ title: "s", url: "made up" }],
      }).success,
    ).toBe(false);
  });
  it("surfaces provider failure details", () => {
    expect(
      providerFailureMessage({
        status: "failed",
        error: { code: "server_error", message: "Temporary provider fault" },
      }),
    ).toBe("OpenAI response failed (server_error): Temporary provider fault");
  });
});
