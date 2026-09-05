import { describe, expect, it } from "vitest";
import {
  assertAnalysisNumericProvenance,
  canonicalNumericToken,
  completedCodeInterpreterCalls,
  evidenceNumericValues,
  extractNumericTokens,
  inspectAnalysisNumericProvenance,
} from "../artifact-provenance";
import { csvAnalysisGolden } from "./fixtures/artifact-golden-plans";

describe("analysis numeric provenance", () => {
  it("canonicalizes executed numeric evidence without treating alphanumeric labels or URLs as findings", () => {
    expect(canonicalNumericToken("+3.0")).toBe("3");
    expect(canonicalNumericToken("1,234.50")).toBe("1234.5");
    expect(extractNumericTokens("Q1 rose +3.0 to 1,234.50 and 12% in https://example.com/2026/42")).toEqual([
      "3",
      "1234.5",
      "12%",
    ]);
  });

  it("requires every analytical number in the finished plan to exist in the prompt or executed evidence", () => {
    const response = {
      output: [
        {
          type: "code_interpreter_call",
          status: "completed",
          outputs: [
            {
              type: "logs",
              logs: "values=12,15,18,24; changes=3,3,6; net=12",
            },
          ],
        },
      ],
    };
    const evidence =
      "Python analysis found values 12, 15, 18, 24; month-to-month changes 3, 3, 6; net increase 12.";
    const values = evidenceNumericValues(evidence, response);
    expect(completedCodeInterpreterCalls(response)).toBe(1);
    const receipt = assertAnalysisNumericProvenance({
      plan: csvAnalysisGolden.plan,
      prompt: csvAnalysisGolden.prompt,
      evidenceNumericValues: values,
      pythonExecuted: true,
    });
    expect(receipt).toMatchObject({
      source: "prompt+evidence",
      pythonExecuted: true,
      unmatchedNumericClaims: [],
    });
    expect(receipt.numericClaimsChecked).toBeGreaterThan(0);
  });

  it("rejects a number introduced only by the JSON structuring phase", () => {
    const plan = structuredClone(csvAnalysisGolden.plan);
    plan.sections[0]!.body += " The projected value is 999.";
    const evidence = evidenceNumericValues(
      "Executed values: 12, 15, 18, 24. Changes: 3, 3, 6. Net increase: 12.",
    );
    const report = inspectAnalysisNumericProvenance({
      plan,
      prompt: csvAnalysisGolden.prompt,
      evidenceNumericValues: evidence,
      pythonExecuted: true,
    });
    expect(report.unmatchedNumericClaims).toEqual(["999"]);
    expect(() =>
      assertAnalysisNumericProvenance({
        plan,
        prompt: csvAnalysisGolden.prompt,
        evidenceNumericValues: evidence,
        pythonExecuted: true,
      }),
    ).toThrow(/999/);
  });

  it("does not count a failed interpreter call as executed Python", () => {
    expect(
      completedCodeInterpreterCalls({
        output: [{ type: "code_interpreter_call", status: "failed" }],
      }),
    ).toBe(0);
  });
});
