import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ArtifactPipelineError,
  assertArtifactPlanQuality,
  assertPresentationPackage,
  assertWebsitePackage,
  estimatePptxEmptyCanvasRatio,
  validateBuiltArtifact,
} from "../artifact-quality";
import type { ArtifactPlan } from "../../shared/contracts";
import type { Config } from "../config";
import { buildArtifact } from "../builders";
import { compileArtifactPlan } from "../artifact-compiler";
import {
  FOUR_CORNERS_LABEL_REPAIR_MESSAGE,
  hasVisibleVisualReference,
  reconcilePresentationPlan,
} from "../reconcile";

const exactPrompt =
  "create a taching presentation slide deck to teach the present tense in french, connect it to french culture and include slides to get the students to practice such as speed dating and 4 corners";

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-exact-prompt-"));
const config = {
  root: artifactRoot,
  storageRoot: artifactRoot,
  dataDir: path.join(artifactRoot, "data"),
  artifactDir: path.join(artifactRoot, "artifacts"),
  uploadDir: path.join(artifactRoot, "uploads"),
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
afterAll(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));

const EMU_PER_INCH = 914_400;

interface TextShapeBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shrinkFit: boolean;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function textShapeBoxes(xml: string): TextShapeBox[] {
  return [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)]
    .map((match): TextShapeBox | null => {
      const shape = match[1]!;
      if (!shape.includes("<p:txBody>")) return null;
      const transform = shape.match(
        /<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>[\s\S]*?<\/a:xfrm>/,
      );
      if (!transform) return null;
      return {
        text: decodeXml(
          [...shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
            .map((text) => text[1])
            .join(" ")
            .trim(),
        ),
        x: Number(transform[1]),
        y: Number(transform[2]),
        width: Number(transform[3]),
        height: Number(transform[4]),
        shrinkFit: /<a:normAutofit\b/.test(shape),
      };
    })
    .filter((shape): shape is TextShapeBox => Boolean(shape?.text));
}

function overlappingTextPairs(boxes: TextShapeBox[]): string[][] {
  const overlaps: string[][] = [];
  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > 1_000 && overlapY > 1_000)
        overlaps.push([a.text, b.text]);
    }
  }
  return overlaps;
}

function frenchTeachingPlan(): ArtifactPlan {
  const base = (heading: string, body: string, requirementIds: string[]) => ({
    heading,
    body,
    bullets: ["A complete audience-facing example", "A clear student check"],
    speakerNotes: "Use this slide to model the language, check understanding, and invite a complete response.",
    requirementIds,
    layout: "standard" as const,
  });
  return {
    title: "La France au présent",
    subtitle: "Parler de la vie francophone avec précision",
    requirements: [
      { id: "R1", text: "Teach the French present tense", mandatory: true },
      { id: "R2", text: "Connect grammar to French culture", mandatory: true },
      { id: "R3", text: "Include Speed Dating student practice", mandatory: true },
      { id: "R4", text: "Include Four Corners student practice", mandatory: true },
    ],
    sections: [
      {
        ...base("Objectifs et mise en route", "Students notice present-tense verbs in authentic descriptions of daily life in France.", ["R1", "R2"]),
        imageQuery: "French morning market shoppers",
      },
      {
        ...base("Construire le présent", "Subject pronouns and regular present-tense endings are modelled with complete examples.", ["R1"]),
        layout: "conjugation",
        table: {
          title: "Parler au présent",
          headers: ["Pronom", "Forme", "Exemple"],
          rows: [["je", "parle", "Je parle français."], ["nous", "parlons", "Nous parlons au café."]],
        },
        imageQuery: "French classroom conjugation practice",
      },
      {
        ...base("Verbes essentiels", "Être, avoir, aller and faire support practical communication in the present.", ["R1"]),
        imageQuery: "Paris students cafe conversation",
      },
      {
        ...base("La culture au quotidien", "Examples connect the present tense to meals, school, transport and leisure across the Francophone world.", ["R1", "R2"]),
        imageQuery: "Francophone community daily life",
      },
      {
        ...base("Four Corners", "Choose the statement that best represents your routine, move, and justify your choice in French.", ["R1", "R2", "R4"]),
        layout: "four_corners",
        activity: {
          type: "four_corners",
          durationMinutes: 8,
          directions: ["Read the four choices.", "Move to one corner.", "Explain and compare your choice."],
          prompts: ["Quelle activité représente le mieux ta journée?"],
          sentenceFrames: ["Je choisis… parce que…", "Dans ma vie, je…"],
          cornerLabels: ["Je mange", "Je voyage", "J'étudie", "Je fais du sport"],
        },
      },
      {
        ...base("Speed Dating", "Rotate through short conversations and answer every partner using complete present-tense sentences.", ["R1", "R2", "R3"]),
        layout: "speed_dating",
        activity: {
          type: "speed_dating",
          durationMinutes: 12,
          directions: ["Face one partner.", "Ask and answer one prompt.", "Rotate when the timer sounds."],
          prompts: ["Que fais-tu le matin?", "Où vas-tu le week-end?", "Qu'est-ce que tu manges?", "Avec qui parles-tu français?"],
          sentenceFrames: ["D'habitude, je…", "Le week-end, nous…"],
          cornerLabels: [],
        },
        imageQuery: "French students conversation classroom",
      },
      {
        ...base("Billet de sortie", "Students produce and check two original present-tense sentences connected to a cultural context.", ["R1", "R2"]),
        layout: "exit_ticket",
        activity: {
          type: "exit_ticket",
          durationMinutes: 4,
          directions: ["Write independently.", "Check the subject and ending."],
          prompts: ["Écris une phrase sur ta routine.", "Écris une phrase sur une pratique culturelle francophone."],
          sentenceFrames: [],
          cornerLabels: [],
        },
      },
    ],
    pages: undefined,
    sources: [{ title: "TV5MONDE Langue française", url: "https://langue-francaise.tv5monde.com/" }],
  };
}

describe("artifact quality gates", () => {
  it("preserves audience-facing content when an optional image is unavailable during RECONCILE", () => {
    const plan = frenchTeachingPlan();
    plan.sections[0]!.body =
      "Regardez l'image et décrivez la scène. Les élèves utilisent ensuite le présent pour parler de leur routine.";
    plan.sections[0]!.bullets.push("Observe the photo before responding.");
    const originalBody = plan.sections[0]!.body;
    const originalBullets = [...plan.sections[0]!.bullets];
    const result = reconcilePresentationPlan(plan, new Set());
    expect(result.reconciliations).toHaveLength(1);
    expect(result.reconciliations[0]).toMatchObject({
      sectionIndex: 0,
      heading: "Objectifs et mise en route",
      movedToSpeakerNotes: [],
      preservedVisibleReferences: expect.arrayContaining([
        "Regardez l'image et décrivez la scène.",
        "Observe the photo before responding.",
      ]),
    });
    expect(result.plan.sections[0]!.body).toBe(originalBody);
    expect(result.plan.sections[0]!.bullets).toEqual(originalBullets);
    expect(hasVisibleVisualReference(result.plan.sections[0]!.body)).toBe(true);
    expect(result.plan.sections[0]!.speakerNotes).toContain(
      "Audience-facing visual references were preserved",
    );
  });

  it("preserves a BUILD specimen in diagnostics instead of deleting evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-build-diag-"));
    const filePath = path.join(root, "broken.pptx");
    const diagnosticsRoot = path.join(root, "diagnostics");
    fs.writeFileSync(filePath, Buffer.from("not-a-zip-package"));
    let thrown: unknown;
    try {
      await validateBuiltArtifact(
        "presentation",
        exactPrompt,
        frenchTeachingPlan(),
        filePath,
        { root: diagnosticsRoot, jobId: "job-build" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArtifactPipelineError);
    expect((thrown as ArtifactPipelineError).failureClass).toBe("BUILD");
    expect(fs.existsSync(filePath)).toBe(true);
    const diagnosticDir = path.join(diagnosticsRoot, "job-build");
    const entries = fs.readdirSync(diagnosticDir);
    expect(entries.some((name) => name.endsWith(".pptx"))).toBe(true);
    expect(entries.some((name) => name.endsWith(".pptx.json"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts the exact French teaching request only when both named activities are complete", () => {
    const plan = frenchTeachingPlan();
    expect(() => assertArtifactPlanQuality("presentation", exactPrompt, plan)).not.toThrow();
  });

  it("rejects generic Four Corners labels with one batched PLAN_CONTENT repair message", () => {
    for (const labels of [
      ["Corner A", "Corner B", "Corner C", "Corner D"],
      ["Choice 1", "Choice 2", "Choice 3", "Choice 4"],
      ["A", "B", "C", "D"],
    ]) {
      const plan = frenchTeachingPlan();
      plan.sections[4]!.activity!.cornerLabels = labels;
      let thrown: unknown;
      try {
        assertArtifactPlanQuality("presentation", exactPrompt, plan);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ArtifactPipelineError);
      expect((thrown as ArtifactPipelineError).failureClass).toBe(
        "PLAN_CONTENT",
      );
      expect((thrown as Error).message).toContain(
        FOUR_CORNERS_LABEL_REPAIR_MESSAGE,
      );
      expect(
        (thrown as Error).message.match(/Four Corners labels must be/g),
      ).toHaveLength(1);
    }
  });

  it("rejects a generic manifest that does not extract the user's prompt", () => {
    const plan = frenchTeachingPlan();
    plan.requirements = [{ id: "R1", text: "Deliver the requested artifact", mandatory: false }];
    for (const section of plan.sections) section.requirementIds = [];
    expect(() => assertArtifactPlanQuality("presentation", exactPrompt, plan)).toThrow(/prompt-specific mandatory requirements/);
  });

  it("distinguishes Spanish todo from an uppercase TODO placeholder marker", () => {
    const plan = frenchTeachingPlan();
    plan.sections[0]!.body =
      "La diversidad cultural existe en todo el país y cambia según la región.";
    expect(() =>
      assertArtifactPlanQuality("presentation", exactPrompt, plan),
    ).not.toThrow();

    plan.sections[0]!.body =
      "TODO: add content about regional cultural diversity.";
    expect(() =>
      assertArtifactPlanQuality("presentation", exactPrompt, plan),
    ).toThrow(/unfinished placeholder language/);
  });

  it("builds the exact-prompt fixture with images, notes, native notesMaster ordering, and an auditable receipt", async () => {
    const plan = frenchTeachingPlan();
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
        if (url.includes("commons.wikimedia.org/w/api.php"))
          return new Response(
            JSON.stringify({
              query: {
                pages: {
                  1: {
                    title: "French classroom culture",
                    imageinfo: [
                      {
                        thumburl: "https://images.example.test/french-classroom.jpg",
                        descriptionurl:
                          "https://commons.wikimedia.org/wiki/File:French_classroom.jpg",
                        width: 1200,
                        height: 800,
                        extmetadata: {
                          ObjectName: { value: "French classroom culture" },
                          Artist: { value: "Regression photographer" },
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
        if (url === "https://images.example.test/french-classroom.jpg")
          return new Response(imageBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        throw new Error(`Unexpected fetch in exact-prompt builder test: ${url}`);
      });

    let out;
    try {
      out = await buildArtifact(config, "presentation", plan, exactPrompt);
    } finally {
      imageFetch.mockRestore();
    }

    expect(fs.existsSync(out.path)).toBe(true);
    const zip = new AdmZip(out.path);
    const slideText = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString("utf8"))
      .join("\n");
    const notesText = zip
      .getEntries()
      .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName))
      .flatMap((entry) =>
        [...entry.getData().toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(
          (match) => match[1],
        ),
      )
      .join("\n");
    const sourcedNotesXml = zip
      .getEntry("ppt/notesSlides/notesSlide2.xml")!
      .getData()
      .toString("utf8");
    const sourcedNoteParagraphs = [
      ...sourcedNotesXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g),
    ].map((match) =>
      [...match[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((textMatch) => textMatch[1])
        .join(""),
    );
    const presentationXml = zip
      .getEntry("ppt/presentation.xml")!
      .getData()
      .toString("utf8");
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .sort((a, b) =>
        a.entryName.localeCompare(b.entryName, undefined, { numeric: true }),
      );
    const boxesBySlide = slideEntries.map((entry) =>
      textShapeBoxes(entry.getData().toString("utf8")),
    );

    expect(slideText).toMatch(/Speed Dating/i);
    expect(slideText).toMatch(/Four Corners/i);
    expect(slideText).toMatch(/culture|francophone/i);
    expect(
      plan.sections.some((section) => section.heading.includes(" / ")),
    ).toBe(false);
    expect(boxesBySlide.flatMap(overlappingTextPairs)).toEqual([]);
    const frameBox = boxesBySlide
      .flat()
      .find((box) => box.text.includes("D'habitude, je"));
    expect(frameBox).toBeDefined();
    expect(frameBox!.shrinkFit).toBe(true);
    expect(frameBox!.height / EMU_PER_INCH).toBeGreaterThanOrEqual(
      (2 * 13 * 1.2) / 72,
    );
    const genericStaticText =
      /^(?:AGENT DÍAZ|VISUAL BRIEF|DIRECTIONS|PART \d+|EVIDENCE TRAIL|\d{2})$/i;
    expect(
      boxesBySlide
        .flat()
        .filter((box) => !genericStaticText.test(box.text))
        .filter((box) => !box.shrinkFit)
        .map((box) => box.text),
    ).toEqual([]);
    const compiledPlan = compileArtifactPlan("presentation", plan).plan;
    expect(
      zip.getEntries().filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)),
    ).toHaveLength(compiledPlan.sections.length + 2);
    expect(
      zip.getEntries().filter((entry) => /^ppt\/media\//.test(entry.entryName)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(presentationXml).toMatch(/<\/p:sldIdLst>\s*<p:notesMasterIdLst\b/);
    expect(presentationXml).not.toMatch(
      /<\/p:sldMasterIdLst>\s*<p:notesMasterIdLst\b/,
    );
    expect(notesText).toContain("[Sources]");
    expect(notesText).toContain(
      "https://commons.wikimedia.org/wiki/File:French_classroom.jpg",
    );
    expect(out.validationReceipt).toMatchObject({
      kind: "presentation",
      schemaValidator:
        "Open XML SDK 3.5.1 (via @xarsh/ooxml-validator 0.3.0)",
      powerPointDesktopValidated: false,
      generatorVersion: "pptxgenjs 4.0.1",
    });
    expect(out.validationReceipt.knownBenignFindings).toHaveLength(1);
    const receipt = out.validationReceipt as any;
    expect(receipt.images).toMatchObject({
      requested: 5,
      fetched: 5,
      placed: 5,
    });
    expect(receipt.presentation).toMatchObject({
      placedAssets: 5,
      titleCounts: {
        contentSlides: compiledPlan.sections.length,
        licensedVisuals: 5,
      },
      layoutFitting: {
        retried: false,
        before: null,
      },
    });
    const ratios = estimatePptxEmptyCanvasRatio(out.path).bySlide;
    expect(receipt.presentation.layoutFitting.after).toEqual(ratios);
    expect(ratios).toHaveLength(compiledPlan.sections.length + 2);
    expect(ratios.every((ratio) => ratio >= 0 && ratio <= 1)).toBe(true);
    expect(receipt.presentation.activityTemplates).toEqual(
      expect.arrayContaining([
        "four-corners-quadrants",
        "speed-dating-rotation",
        "independent-checklist",
      ]),
    );
    expect(receipt.presentation.activityTemplates).toHaveLength(3);
    expect(slideText).toContain(
      `${compiledPlan.sections.length} ideas · 5 licensed visuals`,
    );
    const noteBody = sourcedNoteParagraphs.find((paragraph) =>
      paragraph.includes("[Sources]"),
    )!;
    expect(noteBody).toContain(
      "Use this slide to model the language, check understanding, and invite a complete response.",
    );
    expect(noteBody).toContain("[Sources]");
    expect(noteBody).toContain(
      "- https://commons.wikimedia.org/wiki/File:French_classroom.jpg",
    );
    expect(noteBody).toMatch(
      /response\.\r?\n\r?\n\[Sources\]\r?\n\r?\n- https:\/\/commons\.wikimedia\.org\/wiki\/File:French_classroom\.jpg/,
    );
    expect(out.validationReceipt.knownBenignFindings[0]).toMatchObject({
      id: "Sch_UnexpectedElementContentExpectingComplex",
      path: "/ppt/presentation.xml",
      xPath: "/p:presentation[1]",
    });
    expect(out.validationReceipt.artifactSha256).toBe(
      crypto.createHash("sha256").update(fs.readFileSync(out.path)).digest("hex"),
    );
    if (process.env.CI) {
      const reviewDir = path.join(process.cwd(), "test-results");
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.copyFileSync(
        out.path,
        path.join(reviewDir, "french-present-tense-regression.pptx"),
      );
    }
  }, 20_000);

  it("publishes a structurally valid sparse deck on the first deterministic build and records sparsity as telemetry", async () => {
    const plan = frenchTeachingPlan();
    for (const section of plan.sections) section.imageQuery = undefined;
    plan.sections[1]!.table!.rows = Array.from(
      { length: 10 },
      (_, index) => [
        `sujet ${index + 1}`,
        `forme ${index + 1}`,
        `exemple ${index + 1}`,
      ],
    );

    const out = await buildArtifact(
      config,
      "presentation",
      plan,
      `${exactPrompt}. Use only explicitly requested images.`,
    );
    const receipt = out.validationReceipt as any;
    expect(receipt.images).toMatchObject({
      requested: 0,
      judgeCalls: 0,
      placed: 0,
    });
    expect(receipt.presentation.layoutFitting).toMatchObject({
      retried: false,
      before: null,
    });
    expect(receipt.qualityWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pptx_empty_canvas_metric" }),
      ]),
    );
    const compiledPlan = compileArtifactPlan("presentation", plan).plan;
    const zip = new AdmZip(out.path);
    const physicalSlideCount = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .length;
    expect(receipt.presentation.titleCounts.contentSlides).toBe(
      physicalSlideCount - 2, // title + Sources are not content slides
    );
    expect(receipt.presentation.titleCounts.contentSlides).toBeGreaterThanOrEqual(
      compiledPlan.sections.length,
    );
    const tableSlideText = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => entry.getData().toString("utf8"))
      .filter((xml) => xml.includes("Parler au présent ("));
    expect(tableSlideText).toHaveLength(2);
    expect(tableSlideText[0]).toContain("sujet 8");
    expect(tableSlideText[0]).not.toContain("sujet 9");
    expect(tableSlideText[1]).toContain("sujet 9");
    expect(tableSlideText[1]).toContain("sujet 10");
    expect(
      zip
        .getEntries()
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
        .flatMap((entry) =>
          overlappingTextPairs(
            textShapeBoxes(entry.getData().toString("utf8")),
          ),
        ),
    ).toEqual([]);
    expect(
      receipt.presentation.layoutFitting.after.some(
        (ratio: number) => ratio > 0.55,
      ),
    ).toBe(true);
  }, 20_000);

  it("rejects a deck that merely mentions Speed Dating without implementing the activity", () => {
    const plan = frenchTeachingPlan();
    plan.sections[5] = {
      ...plan.sections[5]!,
      activity: {
        type: "discussion",
        durationMinutes: 5,
        directions: ["Discuss the prompt.", "Share one answer."],
        prompts: ["Que fais-tu?"],
        sentenceFrames: [],
        cornerLabels: [],
      },
    };
    expect(() => assertArtifactPlanQuality("presentation", exactPrompt, plan)).toThrow(/requires a Speed Dating activity slide/);
  });

  it("detects invalid serialized PPTX values instead of rewriting package XML", () => {
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
    zip.addFile("_rels/.rels", Buffer.from("<Relationships/>"));
    zip.addFile(
      "ppt/_rels/presentation.xml.rels",
      Buffer.from("<Relationships/>"),
    );
    zip.addFile(
      "ppt/presentation.xml",
      Buffer.from(
        '<p:presentation xmlns:p="p"><p:sldMasterIdLst/><p:sldIdLst/></p:presentation>',
      ),
    );
    zip.addFile(
      "ppt/slides/slide1.xml",
      Buffer.from('<p:sld xmlns:p="p" xmlns:a="a"><a:off x="NaN" y="0"/></p:sld>'),
    );
    zip.addFile(
      "ppt/slides/slide2.xml",
      Buffer.from('<p:sld xmlns:p="p"><p:cSld/></p:sld>'),
    );
    expect(() => assertPresentationPackage(zip.toBuffer())).toThrow(
      /invalid serialized value in ppt\/slides\/slide1.xml/,
    );
  });

  it("pins the proven PowerPoint-compatible PptxGenJS notesMasterIdLst position", () => {
    const brokenXml = fs.readFileSync(
      path.join(process.cwd(), "corpus", "pptx", "V0.presentation.xml"),
      "utf8",
    );
    const nativeXml = fs.readFileSync(
      path.join(process.cwd(), "corpus", "pptx", "V7.order-sentinel.xml"),
      "utf8",
    );
    expect(brokenXml).toMatch(
      /<\/p:sldMasterIdLst>\s*<p:notesMasterIdLst\b[\s\S]*?<p:sldIdLst\b/,
    );
    expect(brokenXml).not.toMatch(
      /<\/p:sldIdLst>\s*<p:notesMasterIdLst\b/,
    );
    expect(nativeXml).toMatch(
      /<\/p:sldIdLst>\s*<p:notesMasterIdLst\b/,
    );
    expect(nativeXml).not.toMatch(
      /<\/p:sldMasterIdLst>\s*<p:notesMasterIdLst\b/,
    );
  });

  it("prevents presentation.xml string-rewrite surgery from re-entering the build path", () => {
    const buildersSource = fs.readFileSync(
      path.join(process.cwd(), "src/server/builders.ts"),
      "utf8",
    );
    const qualitySource = fs.readFileSync(
      path.join(process.cwd(), "src/server/artifact-quality.ts"),
      "utf8",
    );
    const rewriteOffenders = (
      fileName: string,
      sourceText: string,
    ): string[] => {
      const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const offenders: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) {
          const functionText = node.getText(sourceFile);
          if (
            functionText.includes("ppt/presentation.xml") &&
            /\.replace\s*\(/.test(functionText)
          )
            offenders.push(
              `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return offenders;
    };

    expect(buildersSource).not.toContain("repairPresentationBuffer");
    expect([
      ...rewriteOffenders("builders.ts", buildersSource),
      ...rewriteOffenders("artifact-quality.ts", qualitySource),
    ]).toEqual([]);
    expect(qualitySource).not.toContain("notesMasterLinksReordered");
  });

  it("forbids post-serialization Word document XML rewrite helpers", () => {
    const buildersSource = fs.readFileSync(
      path.join(process.cwd(), "src/server/builders.ts"),
      "utf8",
    );
    const qualitySource = fs.readFileSync(
      path.join(process.cwd(), "src/server/artifact-quality.ts"),
      "utf8",
    );
    const rewriteOffenders = (
      fileName: string,
      sourceText: string,
    ): string[] => {
      const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const offenders: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) {
          const functionText = node.getText(sourceFile);
          if (
            functionText.includes("word/document.xml") &&
            /\.replace\s*\(/.test(functionText) &&
            /\b(?:setData|updateFile|writeZip|toBuffer|atomicWrite)\b/.test(
              functionText,
            )
          )
            offenders.push(
              `${fileName}:${
                sourceFile.getLineAndCharacterOfPosition(
                  node.getStart(sourceFile),
                ).line + 1
              }`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return offenders;
    };

    expect(buildersSource).not.toContain("repairDocumentBuffer");
    expect(qualitySource).not.toContain("repairDocumentBuffer");
    expect([
      ...rewriteOffenders("builders.ts", buildersSource),
      ...rewriteOffenders("artifact-quality.ts", qualitySource),
    ]).toEqual([]);
  });

  it("keeps validation as a repair signal and never quarantines an invalid artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-retriable-artifact-"));
    const target = path.join(root, "invalid.pptx");
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
    zip.writeZip(target);

    let thrown: unknown;
    try {
      await validateBuiltArtifact(
        "presentation",
        exactPrompt,
        frenchTeachingPlan(),
        target,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArtifactPipelineError);
    expect((thrown as ArtifactPipelineError).failureClass).toBe("BUILD");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(root, "_quarantine"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a packaged website with a broken internal link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-website-quality-"));
    const target = path.join(root, "broken.zip");
    const zip = new AdmZip();
    const page = (href: string) => `<!doctype html><html><head><title>Page</title></head><body><nav><a href="MAIN_HOMEPAGE.html">Home</a><a href="${href}">Next</a></nav><main>Complete professional content for this page.</main></body></html>`;
    zip.addFile("MAIN_HOMEPAGE.html", Buffer.from(page("index.html")));
    zip.addFile("index.html", Buffer.from(page("missing.html")));
    zip.addFile("OPEN_ME_FIRST_HOME_PAGE.html", Buffer.from(page("index.html")));
    zip.addFile("OPEN_ME_FIRST.html", Buffer.from(page("index.html")));
    zip.addFile("about.html", Buffer.from(page("index.html")));
    zip.addFile("attributions.html", Buffer.from(page("index.html")));
    zip.writeZip(target);
    expect(() => assertWebsitePackage(target)).toThrow(/broken internal resource/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
