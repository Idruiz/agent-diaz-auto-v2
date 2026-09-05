import { describe, expect, it } from "vitest";
import { clearsKarenRewriteFloor, inspectKarenStyle, karenStyleScore } from "../karen-style";
import { personaInstructions } from "../personas";

describe("Karen runtime style gate", () => {
  it("recognizes explosive Canadian-English outrage", () => {
    const report = inspectKarenStyle("Oh, seriously, what the fucking fuck is this garbage? Sorry, bud, this bullshitty clusterfuck got fuckered by some shitweasel, and now the whole thing is a mindfucking, dickweed-built disaster! What a pathetic mess, eh?");
    expect(report.passes).toBe(true);
    expect(report.canadianTexture).toBeGreaterThanOrEqual(2);
    expect(report.profanityVariety).toBeGreaterThanOrEqual(2);
    expect(report.profanityClusters).toBeGreaterThanOrEqual(2);
    expect(report.morphologicalHits).toBeGreaterThanOrEqual(2);
  });
  it("rejects scattered profanity without local insult chains", () => {
    const report = inspectKarenStyle("Oh, fuck. The policy is bad. Seriously, this is shit. Sorry, bud, the process is ridiculous and unacceptable.");
    expect(report.passes).toBe(false);
    expect(report.profanityClusters).toBeLessThan(2);
  });
  it("rejects a single decorative swear in long polished prose", () => {
    const report = inspectKarenStyle("Oh, what the fuck. The proposal contains several considerations and should be evaluated carefully because different stakeholders may have different perspectives on the matter and a measured response would be appropriate.");
    expect(report.passes).toBe(false);
    expect(report.profanityVariety).toBeLessThan(3);
  });
  it("rejects a beige institutional answer", () => {
    const report = inspectKarenStyle("It is important to note that there are valid arguments on the other hand. In conclusion, it depends on the context.");
    expect(report.passes).toBe(false);
    expect(report.formalMarkers.length).toBeGreaterThan(0);
    expect(clearsKarenRewriteFloor(report)).toBe(false);
  });
  it("keeps Karen's contract independent from Javier's", () => {
    const instructions = personaInstructions("karen");
    expect(instructions).toContain("English-speaking pop-culture Karen on steroids");
    expect(instructions).toContain("rage-baited and rage-baiting");
    expect(instructions).toContain("Swear like an angry Canadian English speaker");
    expect(karenStyleScore(inspectKarenStyle("Oh, seriously, what the fuck is this crap?"))).toBeGreaterThan(0);
  });
});
