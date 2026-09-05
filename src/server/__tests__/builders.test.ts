import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { buildArtifact } from "../builders";
import { compileArtifactPlan } from "../artifact-compiler";
import type { Config } from "../config";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-builders-"));
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
const plan = {
  title: "Validation artifact",
  subtitle: "Builder smoke test",
  requirements: [{ id: "R1", text: "Build a validated visual artifact", mandatory: true }],
  sections: [
    {
      heading: "Evidence chart",
      body: "This section visualizes executed values.",
      bullets: ["One verified point", "A second verified point"],
      speakerNotes: "Presenter note",
      requirementIds: ["R1"],
      layout: "data" as const,
      chart: {
        title: "Quarterly result",
        type: "bar" as const,
        labels: ["Q1", "Q2", "Q3"],
        series: [{ name: "Score", values: [31, 44, 57] }],
        unit: "points",
        sourceNote: "Fixture data",
      },
    },
    {
      heading: "Evidence table",
      body: "The same evidence is available as an exact table.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "data" as const,
      table: {
        title: "Exact results",
        headers: ["Period", "Score"],
        rows: [
          ["Q1", "31"],
          ["Q2", "44"],
          ["Q3", "57"],
        ],
      },
    },
    {
      heading: "Process",
      body: "The workflow is made explicit.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "process" as const,
      diagram: {
        title: "Validated workflow",
        nodes: ["Evidence", "Analysis", "Artifact"],
        caption: "Every stage is checked.",
      },
    },
  ],
  pages: [
    {
      slug: "index",
      title: "Overview",
      description: "Evidence overview",
      sectionHeadings: ["Evidence chart"],
    },
    {
      slug: "details",
      title: "Details",
      description: "Exact evidence table",
      sectionHeadings: ["Evidence table"],
    },
    {
      slug: "process",
      title: "Process",
      description: "Validated workflow",
      sectionHeadings: ["Process"],
    },
  ],
  sources: [{ title: "OpenAI", url: "https://openai.com" }],
};
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("artifact builders", () => {
  for (const kind of [
    "research",
    "analysis",
    "presentation",
    "document",
    "website",
  ] as const)
    it(`builds a visual ${kind}`, async () => {
      const out = await buildArtifact(config, kind, plan);
      expect(fs.existsSync(out.path)).toBe(true);
      expect(out.size).toBeGreaterThan(kind === "website" ? 1500 : 8000);
      expect(path.dirname(out.path)).toBe(config.artifactDir);
    }, 15_000);
  it("uses schema-safe rendered charts while keeping diagrams and text native", async () => {
    const out = await buildArtifact(config, "presentation", plan);
    const zip = new AdmZip(out.path),
      names = zip.getEntries().map((entry) => entry.entryName),
      slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
      slideText = slideNames
        .map((name) => zip.getEntry(name)!.getData().toString("utf8"))
        .join("\n");
    const compiledPlan = compileArtifactPlan("presentation", plan).plan;
    expect(slideNames).toHaveLength(compiledPlan.sections.length + 2);
    expect(names.some((name) => name.startsWith("ppt/charts/") && name.endsWith(".xml"))).toBe(false);
    expect(names.some((name) => name.startsWith("ppt/media/") && !name.endsWith("/"))).toBe(true);
    expect(slideText).not.toContain(" / 3");
    expect(slideText.match(/>Sources</g)).toHaveLength(1);
    expect(slideText).toContain("Validated workflow");
  });
  it("generates print-safe Word structure with fixed tables and a distinct cover", async () => {
    const out = await buildArtifact(config, "document", plan);
    const zip = new AdmZip(out.path),
      documentXml = zip
        .getEntry("word/document.xml")!
        .getData()
        .toString("utf8"),
      numberingXml = zip
        .getEntry("word/numbering.xml")!
        .getData()
        .toString("utf8");
    expect(documentXml).toContain('w:type="fixed"');
    expect(documentXml).toContain('w:w="9360"');
    expect(documentXml).toContain("<w:titlePg");
    expect(documentXml).toContain("<w:keepNext");
    expect(numberingXml).toContain('w:val="bullet"');
    const drawingIds = [
      ...documentXml.matchAll(/<wp:docPr\b[^>]*\bid="([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(drawingIds.length).toBeGreaterThanOrEqual(2);
    expect(drawingIds.every((id) => /^\d+$/.test(id))).toBe(true);
    expect(new Set(drawingIds).size).toBe(drawingIds.length);
    expect(out.validationReceipt.generatorVersion).toBe("docx 9.7.1");
  });
  it("renders every DOCX activity field with a real 2x2 Four Corners grid and no silent truncation", async () => {
    const activityPlan = {
      title: "Four Corners activity document",
      subtitle: "Complete activity rendering",
      requirements: [
        {
          id: "R1",
          text: "Render every activity field in Word",
          mandatory: true,
        },
      ],
      sections: [
        {
          heading: "Four Corners",
          body:
            "Students move, justify a choice, and use complete target-language sentences.",
          bullets: [
            "Keep the four choices visible.",
            "Record one reason from each corner.",
          ],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "four_corners" as const,
          activity: {
            type: "four_corners" as const,
            durationMinutes: 8,
            directions: [
              "Read all four choices.",
              "Move to the corner that matches your answer.",
              "Explain your choice to a partner.",
            ],
            prompts: [
              "Quel lieu préfères-tu ?",
              "Pourquoi préfères-tu ce lieu ?",
            ],
            sentenceFrames: [
              "Je préfère ___ parce que ___.",
              "Dans ce lieu, je ___.",
            ],
            cornerLabels: [
              "le café",
              "le marché",
              "le musée",
              "le parc",
            ],
          },
        },
      ],
      pages: undefined,
      sources: [],
    };

    const out = await buildArtifact(
      config,
      "document",
      activityPlan,
      "Create a Four Corners classroom activity document",
    );
    const zip = new AdmZip(out.path);
    const documentXml = zip
      .getEntry("word/document.xml")!
      .getData()
      .toString("utf8");

    for (const visible of [
      "Read all four choices.",
      "Move to the corner that matches your answer.",
      "Explain your choice to a partner.",
      "Quel lieu préfères-tu ?",
      "Pourquoi préfères-tu ce lieu ?",
      "Je préfère ___ parce que ___.",
      "Dans ce lieu, je ___.",
      "le café",
      "le marché",
      "le musée",
      "le parc",
    ])
      expect(documentXml).toContain(visible);

    const fourCornersIndex = documentXml.indexOf("Four Corners");
    expect(fourCornersIndex).toBeGreaterThanOrEqual(0);
    const activityTableStart = documentXml.indexOf("<w:tbl", fourCornersIndex);
    const activityTableEnd = documentXml.indexOf("</w:tbl>", activityTableStart);
    const activityTableXml = documentXml.slice(
      activityTableStart,
      activityTableEnd + "</w:tbl>".length,
    );
    expect(activityTableXml.match(/<w:tr\b/g)).toHaveLength(2);
    const rows = activityTableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.match(/<w:tc\b/g)).toHaveLength(2);

    const receipt = out.validationReceipt as any;
    expect(receipt.document).toEqual({
      activitiesRendered: 1,
      activityTypes: ["four_corners"],
      truncations: [],
    });
  }, 15_000);

  it("packages phone-portable website pages with one shared stylesheet and exact planned assignments", async () => {
    const out = await buildArtifact(config, "website", plan);
    const zip = new AdmZip(out.path);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("OPEN_ME_FIRST.html");
    expect(names).toContain("index.html");
    expect(names).toContain("details.html");
    expect(names).toContain("process.html");
    expect(names).toContain("assets/styles.css");
    expect(names).not.toContain("styles.css");

    const expectedByPage = new Map([
      ["index.html", ["Evidence chart"]],
      ["details.html", ["Evidence table"]],
      ["process.html", ["Process"]],
    ]);
    for (const [name, headings] of expectedByPage) {
      const html = zip.getEntry(name)!.getData().toString("utf8");
      expect(html).toContain('href="assets/styles.css"');
      const head = html.match(/<head>[\s\S]*?<\/head>/i)?.[0] ?? "";
      expect(head).not.toContain("<style>");
      expect(html).not.toMatch(/data:image\//i);
      for (const heading of headings) expect(html).toContain(heading);
      for (const other of [...expectedByPage.values()].flat().filter((heading) => !headings.includes(heading)))
        expect(html).not.toContain(`<h2>${other}</h2>`);
    }
    const receipt = out.validationReceipt as any;
    expect(receipt.website).toEqual({
      plannedPages: ["index", "details", "process"],
      renderedPages: 3,
      sectionAssignments: 3,
      uniqueImageFiles: 0,
      sharedStylesheet: "assets/styles.css",
      brokenInternalResources: 0,
    });
  });

  it("stores identical website image bytes once and references the shared asset without base64 duplication", async () => {
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
    const imagePlan = structuredClone(plan) as any;
    imagePlan.sections[0].imageQuery = "Paris classroom evidence";
    imagePlan.sections[1].imageQuery = "French evidence table classroom";
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
                    pageid: 101,
                    title: "Shared route image",
                    categories: [{ title: "Category:Education in France" }],
                    imageinfo: [
                      {
                        thumburl: "https://images.example.test/shared-site.jpg",
                        descriptionurl:
                          "https://commons.wikimedia.org/wiki/File:Shared_site.jpg",
                        width: 1200,
                        height: 800,
                        extmetadata: {
                          ObjectName: { value: "Shared route image" },
                          ImageDescription: {
                            value: "Students working with evidence in France.",
                          },
                          Artist: { value: "Fixture photographer" },
                          LicenseShortName: { value: "CC BY 4.0" },
                        },
                      },
                    ],
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        if (url === "https://images.example.test/shared-site.jpg")
          return new Response(imageBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        throw new Error(`Unexpected website image fetch: ${url}`);
      });

    try {
      const out = await buildArtifact(
        config,
        "website",
        imagePlan,
        "Create a three-page evidence website for a school audience",
      );
      const zip = new AdmZip(out.path);
      expect(zip.getEntry("MAIN_HOMEPAGE.html")).not.toBeNull();
      expect(zip.getEntry("OPEN_ME_FIRST_HOME_PAGE.html")).not.toBeNull();
      const detailsHtml = zip.getEntry("details.html")!.getData().toString("utf8");
      expect(detailsHtml).toContain('href="MAIN_HOMEPAGE.html"');
      const imageEntries = zip
        .getEntries()
        .filter((entry) => /^assets\/images\/[^/]+\.jpg$/.test(entry.entryName));
      expect(imageEntries).toHaveLength(1);
      const assetPath = imageEntries[0]!.entryName;

      for (const name of ["index.html", "details.html"]) {
        const html = zip.getEntry(name)!.getData().toString("utf8");
        expect(html).toContain(`src="${assetPath}"`);
        expect(html).not.toMatch(/data:image\//i);
      }
      const receipt = out.validationReceipt as any;
      expect(receipt.website.uniqueImageFiles).toBe(1);
      expect(receipt.images).toMatchObject({
        requested: 2,
        fetched: 2,
        placed: 2,
      });
    } finally {
      imageFetch.mockRestore();
    }
  }, 15_000);
});
