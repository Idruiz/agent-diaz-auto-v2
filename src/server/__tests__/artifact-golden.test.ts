import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, modelProfileFor } from "../openai-agent";
import { openDatabase } from "../db";
import { setImageJudgeProviderForTests } from "../image-judge";
import { compileArtifactPlan } from "../artifact-compiler";
import { planArtifactVisuals } from "../artifact-visual-plan";
import type { Config } from "../config";
import {
  artifactGoldenCases,
  type ArtifactGoldenCase,
} from "./fixtures/artifact-golden-plans";

const roots: string[] = [];
const writeCheckpoint3 = process.env.WRITE_CHECKPOINT_3 === "1";
const checkpoint3Root = path.join(
  process.cwd(),
  "storage",
  "diagnostics",
  "checkpoint-3",
);

function checkpointArtifactName(
  golden: ArtifactGoldenCase,
  artifactPath: string,
): string {
  return `${golden.id}${path.extname(artifactPath)}`;
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-golden-"));
  roots.push(root);
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
    OPENAI_MODEL: "gpt-5.6",
    OPENAI_FAST_MODEL: "gpt-5.6-terra",
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
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return { config, db: openDatabase(config) };
}

function sourceText(plan: ArtifactGoldenCase["plan"]): string {
  return plan.sources
    .map((source) => `${source.title}: ${source.url}`)
    .join("\n");
}

afterEach(() => {
  setImageJudgeProviderForTests(null);
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("recorded artifact golden runs", () => {
  it("runs French deck, Spanish culture document, CSV analysis, and three-page website through AgentRunner with honest receipts", async () => {
    if (writeCheckpoint3) {
      fs.mkdirSync(checkpoint3Root, { recursive: true });
      for (const entry of fs.readdirSync(checkpoint3Root))
        fs.rmSync(path.join(checkpoint3Root, entry), {
          recursive: true,
          force: true,
        });
    }
    const imageBytes = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#2f739c",
      },
    })
      .jpeg()
      .toBuffer();

    const imageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("commons.wikimedia.org/w/api.php")) {
          const pages = Object.fromEntries(
            Array.from({ length: 4 }, (_, index) => {
              const id = 501 + index;
              return [
                id,
                {
                  pageid: id,
                  title: `Golden topical image ${index + 1}`,
                  categories: [
                    { title: "Category:Education" },
                    { title: "Category:Everyday life" },
                  ],
                  imageinfo: [
                    {
                      thumburl:
                        "https://images.example.test/golden-shared.jpg",
                      descriptionurl:
                        `https://commons.wikimedia.org/wiki/File:Golden_topical_${index + 1}.jpg`,
                      width: 1200,
                      height: 800,
                      extmetadata: {
                        ObjectName: {
                          value: `Golden topical image ${index + 1}`,
                        },
                        ImageDescription: {
                          value:
                            "A classroom-suitable documentary scene in the requested place and cultural context.",
                        },
                        Artist: {
                          value: "Golden fixture photographer",
                        },
                        LicenseShortName: { value: "CC BY 4.0" },
                      },
                    },
                  ],
                },
              ];
            }),
          );
          return new Response(JSON.stringify({ query: { pages } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://images.example.test/golden-shared.jpg")
          return new Response(imageBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        throw new Error(`Unexpected golden fetch: ${url}`);
      });

    const judge = vi.fn(async (sections: any[]) =>
      sections.map((section) => ({
        sectionIndex: section.sectionIndex,
        chosenCandidate: section.candidates[0]?.id ?? null,
        reason:
          "The candidate metadata establishes the requested place, subject, and classroom suitability.",
        fallbackQueries: [
          section.heading,
          section.query,
        ] as [string, string],
      })),
    );
    setImageJudgeProviderForTests(judge);

    const completed: Array<{
      golden: ArtifactGoldenCase;
      receipt: any;
      artifactPath: string;
      providerCalls: number;
      checkpointName: string | null;
      checkpointSha256: string | null;
    }> = [];

    try {
      for (const golden of artifactGoldenCases) {
        const { config, db } = harness();
        const conversation = db.createConversation(
          crypto.randomUUID(),
          `Golden ${golden.id}`,
        );

        let fileIds: string[] = [];
        if (golden.kind === "analysis") {
          const uploadId = crypto.randomUUID();
          const csvPath = path.join(
            config.uploadDir,
            `${golden.id}.csv`,
          );
          fs.writeFileSync(csvPath, golden.csv ?? "");
          db.addUpload({
            id: uploadId,
            name: `${golden.id}.csv`,
            mime: "text/csv",
            size: fs.statSync(csvPath).size,
            path: csvPath,
            openaiFileId: `file_${golden.id}`,
          });
          fileIds = [uploadId];
        }

        const job = db.createJob({
          id: crypto.randomUUID(),
          kind: golden.kind,
          prompt: golden.prompt,
          conversationId: conversation.id,
          fileIds,
          ...modelProfileFor("balanced"),
        });

        const create = vi.fn(async (request: any) =>
          request.tools?.length
            ? {
                id: `resp_${golden.id}_evidence`,
                status: "completed",
                output_text: [
                  "Recorded golden evidence dossier.",
                  ...(golden.kind === "analysis"
                    ? [
                        "Executed Python findings: January 12, February 15, March 18, April 24; month-to-month changes 3, 3, 6; net increase 12.",
                      ]
                    : []),
                  sourceText(golden.plan),
                ].join("\n"),
                output:
                  golden.kind === "analysis"
                    ? [
                        {
                          id: "ci_golden_analysis",
                          type: "code_interpreter_call",
                          status: "completed",
                          code: "# executed fixture analysis",
                          outputs: [
                            {
                              type: "logs",
                              logs: "values=12,15,18,24; changes=3,3,6; net=12",
                            },
                          ],
                        },
                      ]
                    : [],
              }
            : {
                id: `resp_${golden.id}_structure`,
                status: "completed",
                output_text: JSON.stringify(golden.plan),
                output: [],
              },
        );
        const runner = new AgentRunner(config, db);
        (runner as any).client = {
          responses: { create, retrieve: vi.fn() },
        };

        await (runner as any).run(job.id);

        expect(create).toHaveBeenCalledTimes(2);
        expect(db.getJob(job.id)).toMatchObject({
          status: "completed",
          progress: 100,
          error: null,
        });

        const artifacts = db.listArtifacts(job.id);
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts[0]!;
        const artifactPath = path.join(config.artifactDir, artifact.name);
        expect(fs.existsSync(artifactPath)).toBe(true);

        const receipt = artifact.receipt as any;
        const compiledGolden = compileArtifactPlan(golden.kind, golden.plan).plan;
        expect(receipt).toMatchObject({
          powerPointDesktopValidated: false,
          wordDesktopValidated: false,
          browserValidated: false,
          attempts: [],
          normalizations: expect.any(Array),
          scores: {
            layoutVariety: {
              score: expect.any(Number),
              distinctTemplates: expect.any(Number),
              contentSections: compiledGolden.sections.length,
            },
            emptyCanvasRatio: {
              bySlide: expect.any(Array),
              method: expect.any(String),
            },
            notesCoverage: {
              score: expect.any(Number),
              contentSections: compiledGolden.sections.length,
            },
            sourceTopicality: {
              score: null,
              status: "pending_qualitative_review",
            },
          },
        });
        expect(receipt.scores.layoutVariety.score).toBeGreaterThanOrEqual(0);
        expect(receipt.scores.layoutVariety.score).toBeLessThanOrEqual(1);
        expect(receipt.scores.notesCoverage.score).toBeGreaterThanOrEqual(0);
        expect(receipt.scores.notesCoverage.score).toBeLessThanOrEqual(1);

        const expectedImages = planArtifactVisuals(
          golden.kind,
          compiledGolden,
          golden.prompt,
        ).receipt.plannedSlots;
        expect(receipt.images).toMatchObject({
          requested: expectedImages,
          fetched: expectedImages,
          placed: expectedImages,
        });
        expect(receipt.images.fetched).toBe(receipt.images.placed);
        expect(receipt.llmCalls).toBe(expectedImages > 0 ? 3 : 2);
        expect(receipt.maxLlmCalls).toBe(6);
        if (golden.kind === "analysis") {
          const evidenceRequest = create.mock.calls[0]![0] as any;
          expect(evidenceRequest.tool_choice).toEqual({
            type: "allowed_tools",
            mode: "required",
            tools: [{ type: "code_interpreter" }],
          });
          expect(
            evidenceRequest.tools.find(
              (tool: any) => tool.type === "code_interpreter",
            )?.container?.file_ids,
          ).toContain(`file_${golden.id}`);
          expect(receipt.analysisProvenance).toMatchObject({
            source: "prompt+evidence",
            pythonExecuted: true,
            unmatchedNumericClaims: [],
          });
          expect(
            receipt.analysisProvenance.numericClaimsChecked,
          ).toBeGreaterThan(0);
        }

        let checkpointName: string | null = null;
        let checkpointSha256: string | null = null;
        if (writeCheckpoint3) {
          checkpointName = checkpointArtifactName(golden, artifactPath);
          const checkpointPath = path.join(
            checkpoint3Root,
            checkpointName,
          );
          fs.copyFileSync(artifactPath, checkpointPath);
          checkpointSha256 = crypto
            .createHash("sha256")
            .update(fs.readFileSync(checkpointPath))
            .digest("hex");
          expect(checkpointSha256).toBe(receipt.artifactSha256);
          fs.writeFileSync(
            path.join(checkpoint3Root, `${golden.id}.receipt.json`),
            JSON.stringify(receipt, null, 2) + "\n",
          );
        }

        completed.push({
          golden,
          receipt,
          artifactPath,
          providerCalls: create.mock.calls.length,
          checkpointName,
          checkpointSha256,
        });
        db.close();
      }
    } finally {
      imageFetch.mockRestore();
    }

    expect(completed).toHaveLength(4);
    expect(judge).toHaveBeenCalledTimes(3);

    const french = completed.find(
      (entry) => entry.golden.id === "french-present-tense",
    )!;
    const compiledFrench = compileArtifactPlan(
      french.golden.kind,
      french.golden.plan,
    ).plan;
    expect(french.receipt.presentation).toMatchObject({
      placedAssets: 6,
      reconciliations: [],
      titleCounts: {
        contentSlides: compiledFrench.sections.length,
        licensedVisuals: 6,
      },
    });
    expect(french.receipt.presentation.activityTemplates).toEqual(
      expect.arrayContaining([
        "four-corners-quadrants",
        "speed-dating-rotation",
        "independent-checklist",
      ]),
    );
    expect(
      french.receipt.scores.emptyCanvasRatio.bySlide.length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      french.receipt.scores.emptyCanvasRatio.average,
    ).toEqual(expect.any(Number));

    const frenchZip = new AdmZip(french.artifactPath);
    const frenchSlideText = frenchZip
      .getEntries()
      .filter((entry) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName),
      )
      .map((entry) => entry.getData().toString("utf8"))
      .join("\n");
    expect(frenchSlideText).toContain("Speed Dating en français");
    expect(frenchSlideText).toContain(
      "Four Corners : Qu’est-ce que tu préfères ?",
    );
    expect(frenchSlideText).toContain(
      `${compiledFrench.sections.length} ideas · 6 licensed visuals`,
    );

    const spanish = completed.find(
      (entry) => entry.golden.id === "spanish-culture-document",
    )!;
    expect(spanish.receipt.document).toEqual({
      activitiesRendered: 1,
      activityTypes: ["discussion"],
      truncations: [],
    });
    const spanishXml = new AdmZip(spanish.artifactPath)
      .getEntry("word/document.xml")!
      .getData()
      .toString("utf8");
    for (const expected of [
      "Conversación cultural",
      "Elige un ejemplo del documento.",
      "¿Qué ejemplo te parece más interesante?",
      "En el documento, ___.",
    ])
      expect(spanishXml).toContain(expected);

    const analysis = completed.find(
      (entry) => entry.golden.id === "csv-analysis-report",
    )!;
    expect(analysis.receipt.images).toMatchObject({
      requested: 0,
      fetched: 0,
      placed: 0,
      judgeCalls: 0,
    });
    expect(analysis.receipt.document.truncations).toEqual([]);
    const analysisXml = new AdmZip(analysis.artifactPath)
      .getEntry("word/document.xml")!
      .getData()
      .toString("utf8");
    expect(analysisXml).toContain("Monthly values");
    expect(analysisXml).toContain("Jan");
    expect(analysisXml).toContain("24");

    const website = completed.find(
      (entry) => entry.golden.id === "three-page-website",
    )!;
    expect(website.receipt.website).toMatchObject({
      plannedPages: ["index", "examples", "discussion"],
      renderedPages: 3,
      sectionAssignments: 5,
      uniqueImageFiles: 1,
      sharedStylesheet: "assets/styles.css",
      brokenInternalResources: 0,
    });
    const websiteZip = new AdmZip(website.artifactPath);
    const websiteNames = websiteZip
      .getEntries()
      .map((entry) => entry.entryName);
    for (const expected of [
      "index.html",
      "examples.html",
      "discussion.html",
      "attributions.html",
      "assets/styles.css",
    ])
      expect(websiteNames).toContain(expected);
    expect(
      websiteNames.filter((name) =>
        /^assets\/images\/[^/]+\.jpg$/.test(name),
      ),
    ).toHaveLength(1);

    const pageExpectations = new Map([
      [
        "index.html",
        ["What public space does", "Streets as places"],
      ],
      [
        "examples.html",
        ["Parks and edges", "Transit and gathering"],
      ],
      ["discussion.html", ["Discuss the design"]],
    ]);
    for (const [name, headings] of pageExpectations) {
      const html = websiteZip
        .getEntry(name)!
        .getData()
        .toString("utf8");
      expect(html).not.toMatch(/data:image\//i);
      expect(html).toContain('href="assets/styles.css"');
      for (const heading of headings)
        expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(
      websiteZip
        .getEntry("discussion.html")!
        .getData()
        .toString("utf8"),
    ).toContain("The design feature ___ may support ___");

    if (writeCheckpoint3) {
      const baselinePath = path.join(
        process.cwd(),
        "corpus",
        "baseline",
        "2026-09-02.json",
      );
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
      const frenchCurrent = completed.find(
        (entry) => entry.golden.id === "french-present-tense",
      )!;
      const summary = {
        checkpoint: 3,
        buildSha: frenchCurrent.receipt.buildSha,
        generatedBy: "recorded artifact golden runs",
        provider: "mocked",
        baseline: {
          recordedAt: baseline.recordedAt,
          sourceSha: baseline.source.sha,
          exactFrenchLlmCalls: baseline.llmCalls,
          planAttempts: baseline.planAttempts,
          buildAttempts: baseline.buildAttempts,
          repairAttempts: baseline.repairAttempts,
          artifactSha256: baseline.artifact.sha256,
        },
        currentExactFrench: {
          llmCalls: frenchCurrent.receipt.llmCalls,
          maxLlmCalls: frenchCurrent.receipt.maxLlmCalls,
          deltaVsBaseline:
            frenchCurrent.receipt.llmCalls - baseline.llmCalls,
          explanation:
            "Current routing adds one bounded qualitative image-judge call; evidence and structure remain one call each, and this golden run used zero plan-repair or build-repair attempts.",
          attempts: frenchCurrent.receipt.attempts,
          normalizations: frenchCurrent.receipt.normalizations,
          artifactSha256: frenchCurrent.receipt.artifactSha256,
          bytes: frenchCurrent.receipt.bytes,
          powerPointDesktopValidated:
            frenchCurrent.receipt.powerPointDesktopValidated,
        },
        artifacts: completed.map((entry) => ({
          id: entry.golden.id,
          kind: entry.golden.kind,
          file: entry.checkpointName,
          receipt: `${entry.golden.id}.receipt.json`,
          artifactSha256: entry.receipt.artifactSha256,
          exportedFileSha256: entry.checkpointSha256,
          bytes: entry.receipt.bytes,
          llmCalls: entry.receipt.llmCalls,
          maxLlmCalls: entry.receipt.maxLlmCalls,
          providerCalls: entry.providerCalls,
          imageJudgeCalls: entry.receipt.images?.judgeCalls ?? 0,
          attempts: entry.receipt.attempts,
          normalizations: entry.receipt.normalizations,
          powerPointDesktopValidated:
            entry.receipt.powerPointDesktopValidated,
          wordDesktopValidated: entry.receipt.wordDesktopValidated,
          browserValidated: entry.receipt.browserValidated,
          scores: entry.receipt.scores,
        })),
      };
      fs.writeFileSync(
        path.join(checkpoint3Root, "summary.json"),
        JSON.stringify(summary, null, 2) + "\n",
      );

      expect(summary.currentExactFrench.llmCalls).toBe(3);
      expect(summary.currentExactFrench.deltaVsBaseline).toBe(1);
      expect(summary.currentExactFrench.attempts).toEqual([]);
      expect(summary.artifacts).toHaveLength(4);
      for (const item of summary.artifacts) {
        expect(item.file).toBeTruthy();
        expect(
          fs.existsSync(path.join(checkpoint3Root, item.file!)),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(checkpoint3Root, item.receipt)),
        ).toBe(true);
        expect(item.exportedFileSha256).toBe(item.artifactSha256);
      }
    }
  }, 60_000);
});
