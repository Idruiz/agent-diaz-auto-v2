import { describe, expect, it } from "vitest";
import {
  evidenceSteeringForPrompt,
  TEACHING_CONTENT_RESEARCH_INSTRUCTION,
} from "../skills";

describe("artifact evidence steering", () => {
  it("adds the exact content-research instruction for a teaching request", () => {
    expect(
      evidenceSteeringForPrompt(
        "Create a teaching presentation for Grade 8 students to practice French present tense with Four Corners.",
      ),
    ).toBe(
      "Research the *content* the students will encounter (cultural facts, authentic examples, places, foods, customs, sample sentences, image-worthy subjects with their real locations) and 3–5 credible sources for that content. Do not research pedagogy policy or curriculum documents unless the user asks for them.",
    );
    expect(
      evidenceSteeringForPrompt(
        "Create a teaching presentation for Grade 8 students.",
      ),
    ).toBe(TEACHING_CONTENT_RESEARCH_INSTRUCTION);
  });

  it("does not add teaching-content steering to a non-teaching request", () => {
    expect(
      evidenceSteeringForPrompt(
        "Create a three-page website comparing quarterly revenue and operating margin.",
      ),
    ).toBe("");
  });
});
