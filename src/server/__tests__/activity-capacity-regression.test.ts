import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { ArtifactPlanSchema } from "../../shared/contracts";
import { compileArtifactPlan } from "../artifact-compiler";

vi.mock("../real-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../real-images")>();
  return {
    ...actual,
    searchCommonsCandidates: vi.fn(async () => ({ candidates: [], rejected: [] })),
  };
});

import { buildArtifact } from "../builders";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-activity-capacity-"));
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

const longDirections = [
  "Travaille avec un partenaire différent à chaque rotation et écoute sa réponse complète avant de poser une courte question de suivi en français.",
  "Quand le signal retentit, remercie ton partenaire, note une idée importante que tu as entendue, puis change rapidement de partenaire sans perdre de temps.",
  "Pour chaque nouvelle personne, choisis une question différente et réponds avec un détail précis sur une expérience réelle ou imaginaire au Québec.",
  "Utilise le passé composé dans chaque réponse, puis reformule une partie de la réponse de ton partenaire pour montrer que tu as vraiment compris son idée.",
  "À la dernière rotation, compare deux réponses entendues pendant l'activité et prépare une phrase que tu pourras partager avec toute la classe.",
];
const frames = [
  "Ce week-end, j'ai ___ parce que ___.",
  "D'abord, j'ai ___, puis j'ai ___.",
  "Mon partenaire a dit qu'il/elle a ___.",
  "Une différence entre nos week-ends est que ___.",
];
const prompts = [
  "Qu'est-ce que tu as fait samedi matin, et avec qui as-tu passé ce moment?",
  "Quel endroit au Québec as-tu visité ou aimerais-tu visiter, et qu'est-ce que tu y as fait?",
  "Quel repas québécois as-tu goûté, préparé ou choisi, et qu'en as-tu pensé?",
  "Quelle activité extérieure as-tu faite pendant le week-end, et pourquoi l'as-tu choisie?",
  "Quel moment du week-end as-tu préféré, et qu'est-ce qui l'a rendu mémorable?",
  "Qu'est-ce que tu n'as pas fait pendant le week-end mais que tu voudrais essayer la prochaine fois?",
];

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function visibleText(filePath: string): string {
  const zip = new AdmZip(filePath);
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .flatMap((entry) =>
      [...entry.getData().toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(
        (match) => decodeXml(match[1]!),
      ),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("activity capacity contract", () => {
  it("moves verbose setup copy to support slides and paginates Speed Dating prompts before rendering", () => {
    const plan = ArtifactPlanSchema.parse({
      title: "Passé composé au Québec",
      subtitle: "Speed Dating classroom practice",
      requirements: [
        {
          id: "R1",
          text: "Include complete Speed Dating practice",
          mandatory: true,
        },
      ],
      sections: [
        {
          heading: "Speed Dating : Une fin de semaine au Québec",
          body: "Interviewe plusieurs camarades afin de pratiquer le passé composé dans un contexte culturel québécois et de comparer différentes expériences de fin de semaine.",
          bullets: ["Écoute activement.", "Pose une question de suivi."],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "speed_dating",
          activity: {
            type: "speed_dating",
            durationMinutes: 12,
            directions: longDirections,
            prompts,
            sentenceFrames: frames,
            cornerLabels: [],
          },
        },
      ],
      sources: [],
    });
    const compiled = compileArtifactPlan("presentation", plan).plan;
    const activitySlides = compiled.sections.filter(
      (section) => section.activity?.type === "speed_dating",
    );
    expect(activitySlides).toHaveLength(2);
    expect(
      activitySlides.every((section) => section.activity!.directions.length === 0),
    ).toBe(true);
    expect(
      activitySlides.every(
        (section) => section.activity!.sentenceFrames.length === 0,
      ),
    ).toBe(true);
    expect(activitySlides.map((section) => section.activity!.prompts.length)).toEqual([
      4, 2,
    ]);
    const supportCopy = compiled.sections.flatMap((section) => section.bullets);
    for (const value of [...longDirections, ...frames])
      expect(supportCopy).toContain(value);
  });

  it("preserves every long French direction, frame, and prompt in the finished PPTX", async () => {
    const plan = ArtifactPlanSchema.parse({
      title: "Passé composé au Québec",
      subtitle: "Speed Dating classroom practice",
      requirements: [
        {
          id: "R1",
          text: "Include complete Speed Dating practice",
          mandatory: true,
        },
      ],
      sections: [
        {
          heading: "Speed Dating : Une fin de semaine au Québec",
          body: "Interviewe plusieurs camarades afin de pratiquer le passé composé dans un contexte culturel québécois et de comparer différentes expériences de fin de semaine.",
          bullets: ["Écoute activement.", "Pose une question de suivi."],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "speed_dating",
          activity: {
            type: "speed_dating",
            durationMinutes: 12,
            directions: longDirections,
            prompts,
            sentenceFrames: frames,
            cornerLabels: [],
          },
        },
      ],
      sources: [],
    });
    const built = await buildArtifact(
      config,
      "presentation",
      plan,
      "Create a French passé composé lesson with Speed Dating",
      "activity-capacity-regression",
    );
    const text = visibleText(built.path);
    for (const value of [...longDirections, ...frames, ...prompts])
      expect(text).toContain(value);
    const slideCount = new AdmZip(built.path)
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length;
    expect(slideCount).toBeGreaterThanOrEqual(6);
    expect((built.validationReceipt as any).attempts).toEqual([]);
  }, 30_000);
});
