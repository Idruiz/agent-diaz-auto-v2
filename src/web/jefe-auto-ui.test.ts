import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("JEFE//AUTO UI contract", () => {
  it("keeps the autonomous light identity and Orbitron display type", () => {
    const main = fs.readFileSync("src/web/main.tsx", "utf8");
    const styles = fs.readFileSync("src/web/styles.css", "utf8");
    const chat = fs.readFileSync("src/web/chat.css", "utf8");
    expect(main).toContain("JEFE//AUTO");
    expect(main).toContain("@fontsource/orbitron/800.css");
    expect(styles).toContain("--jefe-bg: #f6f8fc");
    expect(styles).toContain("font-family: \"Orbitron\"");
    expect(styles + chat).not.toMatch(/#57d795|#39ff14|#00ff00/i);
  });
});
