import { describe, expect, it } from "vitest";
import { chartRenderMode, chartSvg, diagramRenderMode, diagramSvg } from "../visuals.js";
import { planArtifactVisuals } from "../artifact-visual-plan.js";
import type { ArtifactPlan } from "../../shared/contracts.js";

describe("content-responsive visual builders", () => {
  it("splits a giant chart outlier instead of flattening the useful values", () => {
    const chart = {
      title: "Cifras esenciales del patrimonio español",
      type: "bar" as const,
      labels: ["Bienes Patrimonio", "Bienes culturales", "Bienes naturales", "Bienes mixtos", "Ciudades Patrimonio", "Bienes de Interés Cultural"],
      series: [{ name: "Cantidad", values: [50, 44, 4, 2, 15, 17000] }],
      sourceNote: "UNESCO World Heritage Convention y Spain.info.",
    };
    expect(chartRenderMode(chart)).toBe("outlier-split");
    const svg = chartSvg(chart);
    expect(svg).toContain("shown separately because its scale");
    expect(svg).toContain("17000");
    expect(svg).toContain("Bienes de Interés");
  });

  it("reflows six long diagram nodes and wraps their text", () => {
    const nodes = ["Prehistoria", "Roma", "Edad Media y al-Ándalus", "Edad Moderna", "Siglos XIX y XX", "España democrática contemporánea"];
    expect(diagramRenderMode(nodes)).toBe("grid");
    const svg = diagramSvg({ title: "Historia", nodes, caption: "Recorrido" });
    expect(svg.match(/<rect x=/g)?.length).toBeGreaterThanOrEqual(6);
    expect(svg).toContain("<tspan");
    expect(svg).toContain("España democrática");
  });
});

describe("visual acquisition budget", () => {
  const planWithImages = (count: number): ArtifactPlan => ({
    title: "Raíces de España",
    subtitle: "",
    requirements: [{ id: "R1", text: "Create an image-rich website", mandatory: true }],
    sections: Array.from({ length: count }, (_, index) => ({
      heading: `Historic place ${index + 1} in Spain`,
      body: `Culture, architecture, history and regional traditions in Spain number ${index + 1}.`,
      bullets: [], speakerNotes: "", requirementIds: ["R1"], layout: "gallery" as const,
      imageQuery: `Spain historic place photograph ${index + 1}`,
    })),
    pages: [
      { slug: "index", title: "Inicio", description: "", sectionHeadings: ["Historic place 1 in Spain"] },
      { slug: "history", title: "Historia", description: "", sectionHeadings: ["Historic place 2 in Spain"] },
      { slug: "culture", title: "Cultura", description: "", sectionHeadings: ["Historic place 3 in Spain"] },
    ],
    sources: [],
  });

  it("does not let model-authored imageQuery fields fan out without bound", () => {
    const result = planArtifactVisuals("website", planWithImages(20), "Create a robust image-rich website with many relevant photographs");
    expect(result.receipt.plannedSlots).toBeLessThanOrEqual(12);
    expect(result.receipt.suppressedExplicitQueries).toBe(8);
  });

  it("honors an exact user-requested photograph count", () => {
    const result = planArtifactVisuals("website", planWithImages(18), "Create a website with exactly 15 photographs");
    expect(result.receipt.plannedSlots).toBe(15);
  });
});
