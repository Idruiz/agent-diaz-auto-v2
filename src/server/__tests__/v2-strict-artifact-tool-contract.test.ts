import { tool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactPlanSchema } from "../../shared/contracts";

describe("Agent Díaz V2 strict artifact tool contract", () => {
  it("accepts the null representation emitted by the SDK strict schema", () => {
    const buildTool = tool({
      name: "build_and_validate_artifact_contract_probe",
      description: "Contract probe only",
      parameters: z.object({ plan: ArtifactPlanSchema }),
      execute: async ({ plan }) => ({ title: plan.title }),
    });

    expect(buildTool.strict).toBe(true);

    const sdkParameters = buildTool.parameters as Record<string, any>;
    const sdkPlan = sdkParameters.properties?.plan;
    const sdkSection = sdkPlan?.properties?.sections?.items;
    expect(sdkPlan?.required).toEqual(
      expect.arrayContaining([
        "title",
        "subtitle",
        "requirements",
        "sections",
        "pages",
        "sources",
      ]),
    );
    expect(sdkSection?.required).toEqual(
      expect.arrayContaining([
        "heading",
        "body",
        "bullets",
        "speakerNotes",
        "requirementIds",
        "layout",
        "activity",
        "table",
        "chart",
        "diagram",
        "imageQuery",
      ]),
    );

    const strictPayload = {
      title: "Strict contract probe",
      subtitle: null,
      requirements: [
        {
          id: "R1",
          text: "Deliver a valid website",
          mandatory: null,
        },
      ],
      sections: [
        {
          heading: "Home",
          body: "A complete landing page.",
          bullets: null,
          speakerNotes: null,
          requirementIds: null,
          layout: null,
          activity: null,
          table: null,
          chart: null,
          diagram: null,
          imageQuery: null,
        },
      ],
      pages: null,
      sources: null,
    };

    const parsed = ArtifactPlanSchema.safeParse(strictPayload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).toMatchObject({
      subtitle: "",
      requirements: [{ mandatory: true }],
      sections: [
        {
          bullets: [],
          speakerNotes: "",
          requirementIds: [],
          layout: "auto",
        },
      ],
      sources: [],
    });
    expect(parsed.data.pages).toBeUndefined();
    expect(parsed.data.sections[0]?.activity).toBeUndefined();
    expect(parsed.data.sections[0]?.table).toBeUndefined();
    expect(parsed.data.sections[0]?.chart).toBeUndefined();
    expect(parsed.data.sections[0]?.diagram).toBeUndefined();
    expect(parsed.data.sections[0]?.imageQuery).toBeUndefined();
  });

  it("allows a two-page website plan instead of imposing a three-page floor", () => {
    expect(
      ArtifactPlanSchema.safeParse({
        title: "Two-page website",
        sections: [{ heading: "Home", body: "Welcome" }],
        pages: [
          {
            slug: "home",
            title: "Home",
            sectionHeadings: ["Home"],
          },
          {
            slug: "about",
            title: "About",
            sectionHeadings: ["About"],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
