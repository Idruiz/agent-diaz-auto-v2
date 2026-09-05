import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { buildArtifact } from "../builders";
import type { Config } from "../config";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-visual-build-"));
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

describe("visual-plan builder integration", () => {
  it("turns a cultural website with zero model image queries into a multi-image bundled site", async () => {
    const headings = [
      "Montréal aujourd'hui",
      "Cuisine québécoise",
      "Le Vieux-Québec",
      "La francophonie mondiale",
      "Festival et musique",
      "Architecture urbaine",
      "Communautés francophones",
      "Voyager au Québec",
    ];
    const plan = {
      title: "La Francophonie en mouvement",
      subtitle: "Culture and communities",
      requirements: [{ id: "R1", text: "Build a cultural website", mandatory: true }],
      sections: headings.map((heading) => ({
        heading,
        body: "Un exemple culturel concret aide le public à comprendre les lieux, les personnes et les traditions francophones.",
        bullets: [],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard" as const,
      })),
      pages: [
        { slug: "index", title: "Accueil", description: "Introduction", sectionHeadings: headings.slice(0, 3) },
        { slug: "culture", title: "Culture", description: "Culture", sectionHeadings: headings.slice(3, 6) },
        { slug: "voyage", title: "Voyage", description: "Voyage", sectionHeadings: headings.slice(6) },
      ],
      sources: [],
    };

    let searchCounter = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("commons.wikimedia.org/w/api.php")) {
        const id = 1000 + searchCounter++;
        return new Response(JSON.stringify({
          query: {
            pages: {
              [id]: {
                pageid: id,
                title: `Québec cultural image ${id}`,
                categories: [{ title: "Category:Culture of Quebec" }],
                imageinfo: [{
                  thumburl: `https://images.example.test/${id}.jpg`,
                  descriptionurl: `https://commons.wikimedia.org/wiki/File:Quebec_${id}.jpg`,
                  width: 1200,
                  height: 800,
                  extmetadata: {
                    ObjectName: { value: `Québec cultural image ${id}` },
                    ImageDescription: { value: "A cultural place in Québec." },
                    Artist: { value: "Fixture photographer" },
                    LicenseShortName: { value: "CC BY 4.0" },
                  },
                }],
              },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const imageMatch = url.match(/https:\/\/images\.example\.test\/(\d+)\.jpg$/);
      if (imageMatch) {
        const id = Number(imageMatch[1]);
        const imageBytes = await sharp({
          create: {
            width: 1200,
            height: 800,
            channels: 3,
            background: {
              r: (id * 37) % 255,
              g: (id * 71) % 255,
              b: (id * 109) % 255,
            },
          },
        }).jpeg().toBuffer();
        return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      throw new Error(`Unexpected visual-build fetch: ${url}`);
    });

    try {
      const out = await buildArtifact(
        config,
        "website",
        plan,
        "Create a cultural website about Québec and Francophone communities with engaging visuals",
      );
      const zip = new AdmZip(out.path);
      const imageEntries = zip.getEntries().filter((entry) => /^assets\/images\/[^/]+\.jpg$/.test(entry.entryName));
      const receipt = out.validationReceipt as any;
      expect(receipt.images.requested).toBeGreaterThanOrEqual(4);
      expect(receipt.images.fetched).toBeGreaterThanOrEqual(4);
      expect(receipt.images.placed).toBeGreaterThanOrEqual(4);
      expect(imageEntries.length).toBeGreaterThanOrEqual(4);
      expect(zip.getEntry("MAIN_HOMEPAGE.html")).not.toBeNull();
      expect(zip.getEntry("OPEN_ME_FIRST_HOME_PAGE.html")).not.toBeNull();
      for (const name of ["culture.html", "voyage.html"])
        expect(zip.getEntry(name)!.getData().toString("utf8")).toContain('href="MAIN_HOMEPAGE.html"');
    } finally {
      fetchMock.mockRestore();
    }
  }, 20_000);
});
