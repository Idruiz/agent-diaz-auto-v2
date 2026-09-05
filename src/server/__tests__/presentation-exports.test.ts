import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../config";
import { buildArtifact } from "../builders";
import {
  browserPresentationHtml,
  ensurePresentationExports,
  presentationArtifactViews,
} from "../presentation-exports";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-presentation-exports-"));
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

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const plan = {
  title: "Classroom presentation export",
  subtitle: "PPTX, HTML, and PDF",
  requirements: [
    {
      id: "R1",
      text: "Create a classroom presentation in portable formats",
      mandatory: true,
    },
  ],
  sections: [
    {
      heading: "Evidence chart",
      body: "Three exact values make the slide visually substantial.",
      bullets: ["Q1 is 31", "Q2 is 44", "Q3 is 57"],
      speakerNotes: "Explain that every value comes from the fixture.",
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
      body: "The same values remain readable as a native table.",
      bullets: [],
      speakerNotes: "Compare the exact numbers.",
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
      heading: "Validated process",
      body: "The same validated deck becomes the PDF and browser presentation.",
      bullets: [],
      speakerNotes: "Emphasize that PowerPoint remains unchanged.",
      requirementIds: ["R1"],
      layout: "process" as const,
      diagram: {
        title: "One source, three downloads",
        nodes: ["Validated PPTX", "PDF export", "HTML browser view"],
        caption: "The additional formats are additive.",
      },
    },
  ],
  pages: undefined,
  sources: [{ title: "OpenAI", url: "https://openai.com" }],
};

describe("presentation companion exports", () => {
  it("rejects an empty slide-image set before creating a browser presentation", () => {
    expect(() => browserPresentationHtml("Broken", [])).toThrow(/no slide images/i);
  });

  it("creates a standalone browser deck from rendered slide images rather than embedding a PDF viewer", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const html = browserPresentationHtml("Parity", [jpeg, jpeg]);
    expect(html).toContain('id="slide-1"');
    expect(html).toContain('id="slide-2"');
    expect(html).toContain("data:image/jpeg;base64,");
    expect(html).toContain("requestFullscreen");
    expect(html).not.toContain('id="pdf-data"');
    expect(html).not.toContain("<iframe");
  });

  it("keeps the validated PPTX and adds portable PDF plus standalone HTML downloads", async () => {
    const pptx = await buildArtifact(
      config,
      "presentation",
      plan,
      "Create a classroom presentation in portable formats",
    );
    const source = {
      name: pptx.name,
      path: pptx.path,
      mime: pptx.mime,
    };
    const exports = await ensurePresentationExports(config, source);

    expect(fs.existsSync(pptx.path)).toBe(true);
    expect(fs.existsSync(exports.pdf.path)).toBe(true);
    expect(fs.existsSync(exports.html.path)).toBe(true);
    expect(fs.readFileSync(exports.pdf.path).subarray(0, 5).toString("ascii")).toBe(
      "%PDF-",
    );

    const html = fs.readFileSync(exports.html.path, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="slide-1"');
    expect(html).toContain("data:image/jpeg;base64,");
    expect(html).toContain("Exact PPTX/PDF visual parity");
    expect(html).toContain("requestFullscreen");
    expect(html).not.toContain('id="pdf-data"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/https?:\/\//i);

    const views = presentationArtifactViews(config, [
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        jobId: "job-1",
        name: pptx.name,
        mime: pptx.mime,
        size: pptx.size,
      },
    ]);
    expect(views.map((item) => item.name)).toEqual([
      pptx.name,
      pptx.name.replace(/\.pptx$/i, ".html"),
      pptx.name.replace(/\.pptx$/i, ".pdf"),
    ]);
    expect(views.map((item) => item.id)).toEqual([
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000--html",
      "123e4567-e89b-12d3-a456-426614174000--pdf",
    ]);
    expect(views[1]!.size).toBeGreaterThan(3_000);
    expect(views[2]!.size).toBe(exports.pdf.size);
  }, 30_000);
});
