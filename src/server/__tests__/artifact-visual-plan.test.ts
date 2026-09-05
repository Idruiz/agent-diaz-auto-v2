import { describe, expect, it } from "vitest";
import { planArtifactVisuals } from "../artifact-visual-plan";

const basePlan = {
  title: "La Francophonie en mouvement",
  subtitle: "Culture, places, food, and communities",
  requirements: [{ id: "R1", text: "Create a visual cultural artifact", mandatory: true }],
  sections: Array.from({ length: 10 }, (_, index) => ({
    heading: [
      "Montréal aujourd'hui",
      "Cuisine québécoise",
      "Le Vieux-Québec",
      "La francophonie mondiale",
      "Festival et musique",
      "Architecture urbaine",
      "Communautés francophones",
      "Voyager au Québec",
      "Musées et arts",
      "Paysages du Canada",
    ][index]!,
    body: "Un exemple culturel concret aide le public à comprendre le lieu, les personnes, les traditions et le contexte.",
    bullets: [],
    speakerNotes: "",
    requirementIds: ["R1"],
    layout: "standard" as const,
  })),
  pages: undefined,
  sources: [],
};

describe("deterministic visual planning", () => {
  it("creates meaningful website image slots even when the model supplied none", () => {
    const result = planArtifactVisuals(
      "website",
      basePlan,
      "Create a cultural website about Francophone communities",
    );
    expect(result.receipt.explicitQueries).toBe(0);
    expect(result.receipt.derivedQueries).toBeGreaterThanOrEqual(4);
    expect(result.receipt.plannedSlots).toBeGreaterThanOrEqual(4);
    expect(result.plan.sections.filter((section) => section.imageQuery)).toHaveLength(
      result.receipt.plannedSlots,
    );
    expect(
      result.plan.sections
        .filter((section) => section.imageQuery)
        .every((section) => section.imageQuery!.split(/\s+/).length <= 7),
    ).toBe(true);
  });

  it("adds presentation imagery without assigning photographs to activity or structured slides", () => {
    const plan = structuredClone(basePlan) as any;
    plan.sections.push({
      heading: "Speed Dating",
      body: "Practice",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "speed_dating",
      activity: {
        type: "speed_dating",
        durationMinutes: 10,
        directions: ["Talk", "Rotate", "Repeat"],
        prompts: ["A", "B", "C", "D"],
        sentenceFrames: ["Je...", "Nous..."],
        cornerLabels: [],
      },
    });
    plan.sections.push({
      heading: "Exact data",
      body: "A chart already carries the visual load.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "data",
      chart: {
        title: "Data",
        type: "bar",
        labels: ["A"],
        series: [{ name: "Value", values: [1] }],
        unit: "count",
        sourceNote: "fixture",
      },
    });
    const result = planArtifactVisuals(
      "presentation",
      plan,
      "Create a teaching presentation about Québec culture",
    );
    expect(result.receipt.derivedQueries).toBeGreaterThanOrEqual(4);
    expect(result.plan.sections.at(-2)!.imageQuery).toBeUndefined();
    expect(result.plan.sections.at(-1)!.imageQuery).toBeUndefined();
  });

  it("honors explicit requests for a text-only artifact", () => {
    const result = planArtifactVisuals(
      "document",
      basePlan,
      "Create a text-only document with no images",
    );
    expect(result.receipt.disabledByPrompt).toBe(true);
    expect(result.receipt.derivedQueries).toBe(0);
  });

  it("preserves explicit image queries when derivation is disabled", () => {
    const plan = structuredClone(basePlan) as any;
    plan.sections[0].imageQuery = "Montreal skyline Quebec";
    const result = planArtifactVisuals("presentation", plan, "");
    expect(result.receipt.explicitQueries).toBe(1);
    expect(result.receipt.derivedQueries).toBe(0);
    expect(result.plan.sections[0]!.imageQuery).toBe("Montreal skyline Quebec");
  });

  it("respects an exact requested photograph count without suppressing the requested query", () => {
    const plan = structuredClone(basePlan) as any;
    plan.sections[0].imageQuery = "Montreal skyline Quebec";
    const result = planArtifactVisuals(
      "document",
      plan,
      "Create a production-ready document with one licensed photograph",
    );
    expect(result.receipt.targetSlots).toBe(1);
    expect(result.receipt.explicitQueries).toBe(1);
    expect(result.receipt.derivedQueries).toBe(0);
    expect(result.receipt.plannedSlots).toBe(1);
  });

  it("allows a caller to keep explicit visuals while disabling additional derivation", () => {
    const plan = structuredClone(basePlan) as any;
    plan.sections[0].imageQuery = "Montreal skyline Quebec";
    const result = planArtifactVisuals(
      "presentation",
      plan,
      "Create a cultural deck. Use only explicitly requested images.",
    );
    expect(result.receipt.disabledByPrompt).toBe(true);
    expect(result.receipt.explicitQueries).toBe(1);
    expect(result.receipt.derivedQueries).toBe(0);
    expect(result.receipt.plannedSlots).toBe(1);
  });

  it("does not add decorative photographs to a generic numeric analysis", () => {
    const analysisPlan = {
      ...structuredClone(basePlan),
      title: "Quarterly score analysis",
      subtitle: "Executed numeric findings",
      sections: [
        {
          heading: "Method",
          body: "Python calculated the values from the uploaded spreadsheet.",
          bullets: [],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "standard" as const,
        },
        {
          heading: "Results",
          body: "The executed values are shown in a chart and exact result table.",
          bullets: [],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "data" as const,
          chart: {
            title: "Scores",
            type: "bar" as const,
            labels: ["A", "B"],
            series: [{ name: "Score", values: [10, 20] }],
            unit: "points",
            sourceNote: "Executed fixture",
          },
        },
        {
          heading: "Conclusion",
          body: "The second value is higher than the first.",
          bullets: [],
          speakerNotes: "",
          requirementIds: ["R1"],
          layout: "standard" as const,
        },
      ],
    };
    const result = planArtifactVisuals(
      "analysis",
      analysisPlan as any,
      "Analyze the uploaded spreadsheet and explain the results",
    );
    expect(result.receipt.derivedQueries).toBe(0);
    expect(result.receipt.plannedSlots).toBe(0);
  });
});
