import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("artifact build progress contract", () => {
  it("bridges deterministic builder stages into live job messages", () => {
    const agent = fs.readFileSync(path.join(process.cwd(), "src/server/openai-agent.ts"), "utf8");
    const builders = fs.readFileSync(path.join(process.cwd(), "src/server/builders.ts"), "utf8");
    expect(agent).toContain("artifact.build_progress");
    expect(agent).toContain("event.message");
    expect(builders).toContain("Finding visual ${requestIndex + 1} of ${total}");
    expect(builders).toContain("Image provider rate-limited — waiting");
    expect(builders).toContain("Rendering ${pages.length} website pages");
    expect(builders).toContain("Checking website package, links");
  });
});
