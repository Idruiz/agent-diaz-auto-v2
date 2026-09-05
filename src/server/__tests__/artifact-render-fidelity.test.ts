import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { ArtifactPlanSchema } from "../../shared/contracts";

vi.mock("../real-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../real-images")>();
  return {
    ...actual,
    searchCommonsCandidates: vi.fn(async () => ({ candidates: [], rejected: [] })),
  };
});

import { buildArtifact } from "../builders";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-render-fidelity-"));
const config = {
  root,
  storageRoot: root,
  dataDir: path.join(root, "data"),
  artifactDir: path.join(root, "artifacts"),
  uploadDir: path.join(root, "uploads"),
  NODE_ENV: "test",
  PORT: 3000,
  BASE_URL: "http://localhost:3000",
  OPENAI_API_KEY: crypto.randomUUID(),
  ADMIN_PASSWORD: crypto.randomUUID(),
  OPENAI_MODEL: "test",
  OPENAI_FAST_MODEL: "test",
  OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
  STORAGE_DIR: "",
  SESSION_DAYS: 7,
  MAX_UPLOAD_MB: 25,
  IMAGE_PROVIDER: "wikimedia",
  MCP_SERVER_URL: "",
  MCP_SERVER_LABEL: "workspace",
  MCP_AUTHORIZATION: "",
} satisfies Config;
fs.mkdirSync(config.artifactDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function pptxVisibleText(filePath: string): string {
  const zip = new AdmZip(filePath);
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .map((entry) => entry.getData().toString("utf8"))
    .join("\n");
}

describe("finished artifact fidelity", () => {
  it("renders every Four Corners prompt and overflow frame into the final PPTX", async () => {
    const plan = ArtifactPlanSchema.parse({
      title: "Four Corners fidelity",
      subtitle: "Every planned classroom instruction survives rendering",
      requirements: [
        { id: "R1", text: "Deliver complete Four Corners practice", mandatory: true },
      ],
      sections: [
        {
          heading: "Four Corners choice rounds",
          body: "Choose a corner and justify your answer with a complete sentence before listening to another perspective.",
          bullets: ["Listen to a classmate before deciding whether to change corners."],
          speakerNotes: "Run every planned round.",
          requirementIds: ["R1"],
          layout: "four_corners",
          activity: {
            type: "four_corners",
            durationMinutes: 12,
            directions: ["Choose one corner.", "Explain your choice to a partner."],
            prompts: [
              "Which setting would you prefer for a weekend?",
              "Which activity would you choose after school?",
              "Which option best fits your daily routine?",
            ],
            sentenceFrames: [
              "Je préfère ___ parce que ___.",
              "À mon avis, ___ est mieux.",
              "Je choisis ___ car ___.",
              "Pour moi, la meilleure option est ___.",
            ],
            cornerLabels: ["À la maison", "Au parc", "Au café", "Au cinéma"],
          },
        },
      ],
      sources: [],
    });

    const built = await buildArtifact(
      config,
      "presentation",
      plan,
      "Create complete Four Corners classroom practice",
      "render-fidelity-four-corners",
    );
    const xml = pptxVisibleText(built.path);
    for (const value of [
      ...plan.sections[0]!.activity!.prompts,
      ...plan.sections[0]!.activity!.sentenceFrames,
      ...plan.sections[0]!.activity!.cornerLabels,
      ...plan.sections[0]!.bullets,
      plan.sections[0]!.body,
    ]) expect(xml).toContain(value.replace(/&/g, "&amp;"));
    expect((built.validationReceipt as any).attempts).toEqual([]);
  }, 30_000);

  it("counts and attempts every explicitly user-requested image query instead of silently capping it", async () => {
    const sections = Array.from({ length: 13 }, (_, index) => ({
      heading: `Image evidence section ${index + 1}`,
      body: `Complete audience-facing explanation for image evidence section ${index + 1}, retained even when no licensed photo candidate is available.`,
      bullets: [`Evidence point ${index + 1} remains visible without the optional photograph.`],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "standard" as const,
      imageQuery: `licensed classroom evidence photograph ${index + 1}`,
    }));
    const plan = ArtifactPlanSchema.parse({
      title: "Image request fidelity",
      subtitle: "No silent request cap",
      requirements: [
        { id: "R1", text: "Preserve every requested image slot and all text", mandatory: true },
      ],
      sections,
      sources: [],
    });

    const built = await buildArtifact(
      config,
      "document",
      plan,
      "Create a professional document with exactly 13 licensed photographs",
      "render-fidelity-images",
    );
    expect((built.validationReceipt as any).images).toMatchObject({
      requested: 13,
      fetched: 0,
      placed: 0,
      judged: 13,
    });
  }, 30_000);
});
