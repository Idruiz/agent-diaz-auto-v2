import { describe, expect, it } from "vitest";
import { ArtifactPlanSchema } from "../../shared/contracts";
import { compileArtifactPlan } from "../artifact-compiler";
import { assertArtifactPlanQuality } from "../artifact-quality";

function basePlan() {
  return ArtifactPlanSchema.parse({
    title: "Trust regression",
    subtitle: "Deterministic content contract",
    requirements: [{ id: "R1", text: "Deliver all requested content", mandatory: true }],
    sections: [
      {
        heading: "Dense audience-facing explanation",
        body: Array.from({ length: 120 }, (_, i) => `sentence${i}`).join(" "),
        bullets: Array.from({ length: 12 }, (_, i) => `Complete bullet ${i + 1} with preserved content`),
        speakerNotes: "Explain the evidence.",
        requirementIds: ["R1"],
        layout: "standard",
      },
    ],
    sources: [],
  });
}

describe("artifact trust contract", () => {
  it("paginates presentation copy before rendering without silently deleting body words or bullets", () => {
    const input = basePlan();
    const compiled = compileArtifactPlan("presentation", input);
    expect(compiled.plan.sections.length).toBeGreaterThan(1);
    expect(compiled.plan.sections.every((section) => section.body.length <= 440)).toBe(true);
    expect(compiled.plan.sections.every((section) => section.bullets.length <= 5)).toBe(true);
    const originalWords = input.sections[0]!.body.replace(/\s+/g, " ").trim();
    const compiledWords = compiled.plan.sections.map((s) => s.body).filter(Boolean).join(" ");
    expect(compiledWords).toBe(originalWords);
    expect(compiled.plan.sections.flatMap((s) => s.bullets)).toEqual(input.sections[0]!.bullets);
  });

  it("moves structured narrative to context exactly once instead of duplicating or dropping it", () => {
    const raw = basePlan();
    raw.sections = [
      {
        heading: "Evidence table",
        body: "This narrative explains how to interpret the evidence table.",
        bullets: ["Preserve this interpretation point."],
        speakerNotes: "Explain the table.",
        requirementIds: ["R1"],
        layout: "data",
        table: {
          title: "Evidence matrix",
          headers: ["Item", "Result"],
          rows: [["A", "Complete"]],
        },
      },
    ];
    const input = ArtifactPlanSchema.parse(raw);
    const compiled = compileArtifactPlan("presentation", input);
    const tableSlide = compiled.plan.sections.find((section) => section.table);
    const contextSlides = compiled.plan.sections.filter((section) => !section.table);
    expect(tableSlide).toBeTruthy();
    expect(tableSlide!.body).toBe("");
    expect(tableSlide!.bullets).toEqual([]);
    expect(contextSlides.map((section) => section.body).filter(Boolean)).toEqual([
      input.sections[0]!.body,
    ]);
    expect(contextSlides.flatMap((section) => section.bullets)).toEqual(
      input.sections[0]!.bullets,
    );
  });

  it("materializes every Four Corners prompt and preserves template-overflow copy instead of slicing it", () => {
    const raw = basePlan();
    raw.sections = [
      {
        heading: "Four Corners choice rounds",
        body: "Choose a corner and justify your answer with a complete sentence.",
        bullets: ["Listen to a classmate before changing corners."],
        speakerNotes: "Run all planned rounds.",
        requirementIds: ["R1"],
        layout: "four_corners",
        activity: {
          type: "four_corners",
          durationMinutes: 12,
          directions: ["Choose one corner.", "Explain your choice to a partner."],
          prompts: [
            "Which setting would you prefer?",
            "Which activity would you choose?",
            "Which option best fits your routine?",
          ],
          sentenceFrames: [
            "Je préfère ___ parce que ___.",
            "À mon avis, ___ est mieux.",
            "Je choisis ___ car ___.",
            "Pour moi, la meilleure option est ___.",
          ],
          cornerLabels: ["A", "B", "C", "D"],
        },
      },
    ];
    const input = ArtifactPlanSchema.parse(raw);
    const source = input.sections[0]!;
    const compiled = compileArtifactPlan("presentation", input);
    const rounds = compiled.plan.sections.filter(
      (section) => section.activity?.type === "four_corners",
    );
    const context = compiled.plan.sections.filter((section) => !section.activity);

    expect(rounds).toHaveLength(source.activity!.prompts.length);
    expect(rounds.flatMap((section) => section.activity!.prompts)).toEqual(
      source.activity!.prompts,
    );
    expect(rounds.every((section) => section.activity!.prompts.length === 1)).toBe(true);
    expect(
      rounds.every((section) => section.activity!.directions.length === 0),
    ).toBe(true);
    expect(
      rounds.every((section) => section.activity!.sentenceFrames.length === 0),
    ).toBe(true);
    expect(context.flatMap((section) => section.bullets)).toEqual([
      ...source.bullets,
      ...source.activity!.directions,
      ...source.activity!.sentenceFrames,
    ]);
    expect(
      compiled.plan.sections.filter((section) => section.body === source.body),
    ).toHaveLength(1);
    expect(compiled.normalizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation_activity_paginated" }),
      ]),
    );
  });

  it("does not fail a valid plan merely because it misses a nonmandatory visual target", () => {
    const plan = basePlan();
    expect(() =>
      assertArtifactPlanQuality(
        "document",
        "Create a professional document",
        plan,
      ),
    ).not.toThrow();
  });

  it("enforces atomic activity sizes at the schema boundary instead of truncating in the renderer", () => {
    const raw = basePlan();
    const section = raw.sections[0]!;
    section.activity = {
      type: "discussion",
      durationMinutes: 10,
      directions: ["d1", "d2"],
      prompts: Array.from({ length: 7 }, (_, i) => `Prompt ${i + 1}`),
      sentenceFrames: [],
      cornerLabels: [],
    };
    expect(() => ArtifactPlanSchema.parse(raw)).toThrow();
  });
});
