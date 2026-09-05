import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildArtifact } from "../builders";
import type { Config } from "../config";
import {
  judgeImageCandidates,
  setImageJudgeProviderForTests,
  type ImageJudgeSection,
} from "../image-judge";
import type { ArtifactPlan } from "../../shared/contracts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-localized-activity-"));
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

afterEach(() => {
  setImageJudgeProviderForTests(null);
  vi.restoreAllMocks();
});

function localizedSpanishPlan(): ArtifactPlan {
  const base = (heading: string, body: string, ids: string[]) => ({
    heading,
    body,
    bullets: [
      "Observa cómo cambia el verbo según el contexto y el hablante.",
      "Responde con una oración completa antes de comparar con otra persona.",
    ],
    speakerNotes: "Model the language briefly, then move quickly to student talk and formative checking.",
    requirementIds: ids,
    layout: "standard" as const,
  });
  return {
    title: "¿Qué pasó? El pretérito en acción",
    subtitle: "Narrar experiencias en el mundo hispanohablante",
    requirements: [
      { id: "R1", text: "Teach the Spanish preterite", mandatory: true },
      { id: "R2", text: "Include cultural contexts", mandatory: true },
      { id: "R3", text: "Include a Speed Dating speaking activity", mandatory: true },
    ],
    sections: [
      base(
        "El reto de hoy",
        "La clase conecta formas del pretérito con experiencias concretas para contar qué ocurrió, cuándo ocurrió y por qué fue memorable.",
        ["R1"],
      ),
      base(
        "Formas regulares",
        "Los verbos regulares presentan terminaciones previsibles que permiten construir relatos breves con precisión y suficiente fluidez.",
        ["R1"],
      ),
      base(
        "Voces y lugares",
        "Ejemplos situados en México, España y el Caribe muestran cómo una misma estructura gramatical sirve para narrar experiencias culturales distintas.",
        ["R1", "R2"],
      ),
      base(
        "Antes de hablar",
        "Primero se prepara una respuesta breve con un verbo preciso, un detalle temporal y una explicación que permita continuar la conversación.",
        ["R1"],
      ),
      {
        ...base(
          "Citas rápidas: historias de ayer",
          "Habla con varias personas, escucha un detalle de cada historia y responde usando el pretérito sin depender de una etiqueta inglesa para la actividad.",
          ["R1", "R2", "R3"],
        ),
        layout: "speed_dating" as const,
        activity: {
          type: "speed_dating" as const,
          durationMinutes: 10,
          directions: [
            "Busca una pareja y decide quién empieza.",
            "Haz una pregunta y escucha una respuesta completa.",
            "Cambia de pareja cuando suene la señal y registra un detalle nuevo.",
          ],
          prompts: [
            "¿Qué hiciste el fin de semana pasado?",
            "¿Adónde fuiste durante las últimas vacaciones?",
            "¿Qué comida probaste recientemente?",
            "¿Qué celebración o evento viste y qué ocurrió?",
          ],
          sentenceFrames: [
            "Primero…, después… y al final…",
            "Fui a… porque… y allí…",
          ],
          cornerLabels: [],
        },
      },
      base(
        "Lo que escuchamos",
        "La clase compara detalles de las conversaciones y selecciona ejemplos eficaces para explicar por qué una narración resulta clara y específica.",
        ["R1", "R3"],
      ),
      base(
        "Cierre",
        "Cada estudiante escribe una oración final que resume una experiencia real o imaginada y comprueba sujeto, verbo, tiempo y detalle cultural.",
        ["R1", "R2"],
      ),
    ],
    sources: [],
  };
}

function visiblePptxText(filePath: string): string {
  const zip = new AdmZip(filePath);
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .flatMap((entry) => [
      ...entry
        .getData()
        .toString("utf8")
        .matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g),
    ].map((match) => match[1] ?? ""))
    .join(" ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

describe("localized activity output and image fallback", () => {
  it("accepts a localized Speed Dating deck when the semantic activity and all of its visible content survive rendering", async () => {
    const prompt =
      "Create a teaching presentation about the Spanish preterite with cultural context and a Speed Dating speaking activity. Use only explicitly requested images.";
    const out = await buildArtifact(
      config,
      "presentation",
      localizedSpanishPlan(),
      prompt,
    );
    const text = visiblePptxText(out.path);
    expect(text).toContain("Citas rápidas");
    expect(text).not.toMatch(/speed[\s-]*dating/i);
    expect(text).toContain("¿Qué hiciste el fin de semana pasado?");
    expect(text).toContain("Cambia de pareja cuando suene la señal");
    expect(out.validationReceipt.kind).toBe("presentation");
    expect((out.validationReceipt as any).images).toMatchObject({
      requested: 0,
      placed: 0,
    });
  }, 20_000);

  it("uses exactly one bounded fallback search/judge pass when the first candidate set is rejected", async () => {
    let providerCalls = 0;
    setImageJudgeProviderForTests(async (sections) => {
      providerCalls++;
      return sections.map((section) => ({
        sectionIndex: section.sectionIndex,
        chosenCandidate:
          providerCalls === 1
            ? null
            : section.candidates.find((candidate) => candidate.id === "fallback-200")?.id ?? null,
        reason:
          providerCalls === 1
            ? "The first candidate set is too generic for this cultural section."
            : "The fallback candidate is a clear topical match.",
        fallbackQueries: [
          "Québec Winter Carnival ice palace crowd",
          "Carnaval de Québec festival winter",
        ],
      }));
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes("commons.wikimedia.org/w/api.php"))
        throw new Error(`Unexpected fallback fetch: ${url}`);
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              200: {
                pageid: "fallback-200",
                title: "Québec Winter Carnival ice palace",
                categories: [{ title: "Category:Quebec Winter Carnival" }],
                imageinfo: [
                  {
                    thumburl: "https://images.example.test/quebec-carnival.jpg",
                    descriptionurl: "https://commons.wikimedia.org/wiki/File:Quebec_Winter_Carnival.jpg",
                    width: 1200,
                    height: 800,
                    extmetadata: {
                      ObjectName: { value: "Québec Winter Carnival ice palace" },
                      ImageDescription: { value: "Visitors at the Québec Winter Carnival ice palace." },
                      Artist: { value: "Fixture photographer" },
                      LicenseShortName: { value: "CC BY 4.0" },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const sections: ImageJudgeSection[] = [
      {
        sectionIndex: 0,
        heading: "Le Carnaval de Québec",
        body: "Students connect the language target to a winter celebration in Québec.",
        audience: "Grade 11 classroom",
        query: "French Canadian cultural celebration",
        candidates: [
          {
            id: "initial-100",
            title: "Generic city street",
            description: "A city street with pedestrians.",
            categories: ["City streets"],
            creator: "Fixture photographer",
            license: "CC BY 4.0",
            width: 1200,
            height: 800,
            thumbUrl: "https://images.example.test/generic.jpg",
            sourceUrl: "https://commons.wikimedia.org/wiki/File:Generic.jpg",
            query: "French Canadian cultural celebration",
          },
        ],
      },
    ];

    const result = await judgeImageCandidates(config, sections);
    expect(providerCalls).toBe(2);
    expect(result.judgeCalls).toBe(2);
    expect(result.decisions[0]?.chosenCandidate).toBe("fallback-200");
    expect(sections[0]!.candidates.map((candidate) => candidate.id)).toContain(
      "fallback-200",
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});
