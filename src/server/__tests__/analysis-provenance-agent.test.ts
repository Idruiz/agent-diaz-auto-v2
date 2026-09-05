import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, modelProfileFor } from "../openai-agent";
import { openDatabase } from "../db";
import type { Config } from "../config";
import { csvAnalysisGolden } from "./fixtures/artifact-golden-plans";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-analysis-provenance-"));
  roots.push(root);
  const config = {
    root,
    storageRoot: root,
    dataDir: path.join(root, "data"),
    artifactDir: path.join(root, "artifacts"),
    uploadDir: path.join(root, "uploads"),
    NODE_ENV: "test",
    PORT: 3000,
    BASE_URL: "http://localhost:3000",
    OPENAI_API_KEY: crypto.randomUUID(),
    ADMIN_PASSWORD: crypto.randomUUID(),
    OPENAI_MODEL: "gpt-5.6",
    OPENAI_FAST_MODEL: "gpt-5.6-terra",
    OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
    STORAGE_DIR: "",
    SESSION_DAYS: 7,
    MAX_UPLOAD_MB: 25,
    IMAGE_PROVIDER: "wikimedia",
    MCP_SERVER_URL: "",
    MCP_SERVER_LABEL: "workspace",
    MCP_AUTHORIZATION: "",
  } satisfies Config;
  fs.mkdirSync(config.artifactDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return { config, db: openDatabase(config) };
}

describe("AgentRunner analysis provenance", () => {
  it("repairs a JSON-only invented number without rerunning spreadsheet evidence", async () => {
    const { config, db } = harness();
    const conversation = db.createConversation(
      crypto.randomUUID(),
      "Analysis provenance repair",
    );
    const uploadId = crypto.randomUUID();
    const csvPath = path.join(config.uploadDir, "values.csv");
    fs.writeFileSync(csvPath, csvAnalysisGolden.csv ?? "");
    db.addUpload({
      id: uploadId,
      name: "values.csv",
      mime: "text/csv",
      size: fs.statSync(csvPath).size,
      path: csvPath,
      openaiFileId: "file_analysis_values",
    });
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "analysis",
      prompt: csvAnalysisGolden.prompt,
      conversationId: conversation.id,
      fileIds: [uploadId],
      ...modelProfileFor("balanced"),
    });

    const inventedPlan = structuredClone(csvAnalysisGolden.plan);
    inventedPlan.sections[0]!.body += " The projected value is 999.";

    let call = 0;
    const create = vi.fn(async (request: any) => {
      call++;
      if (call === 1)
        return {
          id: "resp_analysis_evidence",
          status: "completed",
          output_text:
            "Executed Python findings: January 12, February 15, March 18, April 24; month-to-month changes 3, 3, 6; net increase 12.",
          output: [
            {
              id: "ci_analysis_values",
              type: "code_interpreter_call",
              status: "completed",
              code: "# analyze uploaded values.csv",
              outputs: [
                {
                  type: "logs",
                  logs: "values=12,15,18,24; changes=3,3,6; net=12",
                },
              ],
            },
          ],
        };
      if (call === 2)
        return {
          id: "resp_analysis_structure_bad",
          status: "completed",
          output_text: JSON.stringify(inventedPlan),
          output: [],
        };
      expect(request.previous_response_id).toBe("resp_analysis_structure_bad");
      expect(request.tools).toBeUndefined();
      return {
        id: "resp_analysis_repair",
        status: "completed",
        output_text: JSON.stringify(csvAnalysisGolden.plan),
        output: [],
      };
    });

    const runner = new AgentRunner(config, db);
    (runner as any).client = {
      responses: { create, retrieve: vi.fn() },
    };

    await (runner as any).run(job.id);

    expect(create).toHaveBeenCalledTimes(3);
    const evidenceCalls = create.mock.calls.filter(
      ([request]) => Array.isArray((request as any).tools) && (request as any).tools.length,
    );
    expect(evidenceCalls).toHaveLength(1);
    const evidenceRequest = evidenceCalls[0]![0] as any;
    expect(evidenceRequest.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "code_interpreter" }],
    });
    expect(
      evidenceRequest.tools.find((tool: any) => tool.type === "code_interpreter")
        ?.container?.file_ids,
    ).toContain("file_analysis_values");

    expect(db.getJob(job.id)).toMatchObject({
      status: "completed",
      progress: 100,
      error: null,
    });
    const artifacts = db.listArtifacts(job.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.receipt).toMatchObject({
      llmCalls: 3,
      analysisProvenance: {
        source: "prompt+evidence",
        pythonExecuted: true,
        unmatchedNumericClaims: [],
      },
    });
    expect(
      (artifacts[0]!.receipt as any).analysisProvenance.numericClaimsChecked,
    ).toBeGreaterThan(0);

    const runState = db.getArtifactRunState(job.id)!;
    expect(runState.evidencePythonExecuted).toBe(true);
    expect(runState.evidenceNumericValues).toEqual(
      expect.arrayContaining(["12", "15", "18", "24", "3", "6"]),
    );
    expect(runState.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureClass: "PLAN_CONTENT",
          ruleOrPart: "analysis-numeric-provenance",
          strategy: "plan-repair",
        }),
      ]),
    );
    db.close();
  }, 20_000);
});
