import { tool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactPlanSchema } from "../../shared/contracts";
import {
  V2ArtifactPlanToolInputSchema,
  normalizeV2ArtifactPlanToolInput,
} from "../v2/artifact-tool-contract";

describe("Agent Díaz V2 strict artifact tool contract", () => {
  it("accepts the null representation emitted by the SDK strict schema and normalizes it canonically", () => {
    const buildTool = tool({
      name: "build_and_validate_artifact_contract_probe",
      description: "Contract probe only",
      parameters: z.object({ plan: V2ArtifactPlanToolInputSchema }),
      execute: async ({ plan }) => ({
        title: normalizeV2ArtifactPlanToolInput(plan).title,
      }),
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

    const toolParsed = V2ArtifactPlanToolInputSchema.safeParse(strictPayload);
    expect(toolParsed.success).toBe(true);
    if (!toolParsed.success) return;

    const parsed = normalizeV2ArtifactPlanToolInput(toolParsed.data);
    expect(parsed).toMatchObject({
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
    expect(parsed.pages).toBeUndefined();
    expect(parsed.sections[0]?.activity).toBeUndefined();
    expect(parsed.sections[0]?.table).toBeUndefined();
    expect(parsed.sections[0]?.chart).toBeUndefined();
    expect(parsed.sections[0]?.diagram).toBeUndefined();
    expect(parsed.sections[0]?.imageQuery).toBeUndefined();
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
