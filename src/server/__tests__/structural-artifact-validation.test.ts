import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildArtifact } from "../builders";
import { compileArtifactPlan } from "../artifact-compiler";
import {
  assertPresentationStructuralCoverage,
  ArtifactPipelineError,
} from "../artifact-quality";
import {
  expectedPresentationIdentityMarkers,
  extractPresentationIdentityMarkers,
} from "../artifact-identity";
import type { ArtifactPlan } from "../../shared/contracts";
import type { Config } from "../config";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-structural-validator-"));
const config = {
  root,
  storageRoot: root,
  dataDir: path.join(root, "data"),
  artifactDir: path.join(root, "artifacts"),
  uploadDir: path.join(root, "uploads"),
  NODE_ENV: "test",
  PORT: 3000,
  BASE_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test-key",
  ADMIN_PASSWORD: "test-password",
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
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function spanishPlan(): ArtifactPlan {
  const standard = (heading: string, body: string): ArtifactPlan["sections"][number] => ({
    heading,
    body,
    bullets: ["Un ejemplo completo para la clase.", "Una comprobación breve de comprensión."],
    speakerNotes: "Modelar el ejemplo y comprobar comprensión antes de continuar.",
    requirementIds: ["R1"],
    layout: "standard",
  });
  return {
    title: "¿Qué pasó? El pretérito en el mundo hispanohablante",
    subtitle: "Narrar experiencias pasadas con contexto cultural",
    requirements: [
      { id: "R1", text: "Teach the Spanish preterite", mandatory: true },
      { id: "R2", text: "Include a Speed Dating speaking activity", mandatory: true },
    ],
    sections: [
      standard("¿Qué pasó ayer?", "Observamos cómo el pretérito permite contar acciones terminadas."),
      standard("Formas regulares", "Comparamos terminaciones frecuentes de verbos en -ar, -er e -ir."),
      standard("Verbos frecuentes", "Practicamos formas de alta frecuencia dentro de frases completas."),
      standard("Historias y cultura", "Conectamos relatos breves con experiencias del mundo hispanohablante."),
      {
        heading: "Citas rápidas: historias de ayer",
        body: "Rotamos por parejas y contamos experiencias pasadas usando frases completas.",
        bullets: [],
        speakerNotes: "Mantener las rotaciones breves y pedir una respuesta completa en cada turno.",
        requirementIds: ["R1", "R2"],
        layout: "speed_dating",
        activity: {
          type: "speed_dating",
          durationMinutes: 10,
          directions: [
            "Habla con una pareja.",
            "Haz una pregunta y escucha la respuesta.",
            "Cambia de pareja cuando suene la señal.",
          ],
          prompts: [
            "¿Qué hiciste el fin de semana?",
            "¿Adónde fuiste recientemente?",
            "¿Qué comiste ayer?",
            "¿Con quién hablaste después de clases?",
          ],
          sentenceFrames: ["Ayer yo…", "El fin de semana pasado…"],
          cornerLabels: [],
        },
      },
      standard("Comparar relatos", "Escuchamos detalles y distinguimos acciones principales de información de apoyo."),
      standard("Salida", "Escribimos dos frases originales para resumir una experiencia pasada."),
    ],
    pages: undefined,
    sources: [
      { title: "RAE", url: "https://www.rae.es/" },
    ],
  };
}

function notesText(zip: AdmZip): string {
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName))
    .flatMap((entry) =>
      [...entry.getData().toString("utf8").matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((match) => match[1] ?? ""),
    )
    .join("");
}

describe("structural artifact validation", () => {
  it("validates a Spanish-rendered Speed Dating deck by machine identity rather than English surface wording", async () => {
    const plan = spanishPlan();
    const prompt = "Create a Spanish teaching presentation with a Speed Dating activity. Use only explicitly requested images.";
    const out = await buildArtifact(config, "presentation", plan, prompt);
    const zip = new AdmZip(out.path);
    const slideText = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString("utf8"))
      .join("\n");

    expect(slideText).toContain("Citas rápidas");
    expect(slideText).not.toMatch(/Speed Dating/i);

    const compiled = compileArtifactPlan("presentation", plan).plan;
    const expected = expectedPresentationIdentityMarkers(compiled);
    const emitted = extractPresentationIdentityMarkers(notesText(zip));
    expect(expected.length).toBeGreaterThan(compiled.sections.length);
    for (const marker of expected) expect(emitted.has(marker)).toBe(true);
    expect(() => assertPresentationStructuralCoverage(out.path, compiled)).not.toThrow();
  }, 20_000);

  it("hard-fails only when a compiled presentation identity is objectively absent", async () => {
    const plan = spanishPlan();
    const prompt = "Create a Spanish teaching presentation with a Speed Dating activity. Use only explicitly requested images.";
    const out = await buildArtifact(config, "presentation", plan, prompt);
    const compiled = compileArtifactPlan("presentation", plan).plan;
    const tampered = path.join(root, `tampered-${Date.now()}.pptx`);
    const zip = new AdmZip(out.path);
    for (const entry of [...zip.getEntries()])
      if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName))
        zip.deleteFile(entry.entryName);
    zip.writeZip(tampered);

    let thrown: unknown;
    try {
      assertPresentationStructuralCoverage(tampered, compiled);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArtifactPipelineError);
    expect((thrown as ArtifactPipelineError).ruleOrPart).toBe("pptx-structural-manifest");
    expect((thrown as Error).message).toContain("act-");
    expect((thrown as Error).message).toContain("speed_dating");
  }, 20_000);
});
