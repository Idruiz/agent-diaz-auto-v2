import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import {
  judgeImageCandidates,
  setImageJudgeProviderForTests,
} from "../image-judge";
import {
  imageCandidateRejectionReason,
  type CommonsImageCandidate,
} from "../real-images";

const config = {
  root: "/tmp",
  storageRoot: "/tmp",
  dataDir: "/tmp/data",
  artifactDir: "/tmp/artifacts",
  uploadDir: "/tmp/uploads",
  NODE_ENV: "test",
  PORT: 3000,
  BASE_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test-key",
  ADMIN_PASSWORD: "test-password",
  OPENAI_MODEL: "test",
  OPENAI_FAST_MODEL: "test",
  OPENAI_REALTIME_MODEL: "test",
  STORAGE_DIR: "",
  SESSION_DAYS: 7,
  MAX_UPLOAD_MB: 25,
  IMAGE_PROVIDER: "wikimedia",
  MCP_SERVER_URL: "",
  MCP_SERVER_LABEL: "workspace",
  MCP_AUTHORIZATION: "",
} satisfies Config;

const candidate = (
  id: string,
  title: string,
  description: string,
  categories: string[],
): CommonsImageCandidate => ({
  id,
  title,
  description,
  categories,
  creator: "Commons contributor",
  license: "CC BY-SA 4.0",
  width: 1600,
  height: 1000,
  thumbUrl: `https://images.example.test/${id}.jpg`,
  sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
  query: "marché en France",
});

afterEach(() => {
  setImageJudgeProviderForTests(null);
});

describe("artifact image relevance", () => {
  it("uses one artifact-level judge call and does not choose the New Orleans sleeping-bench result for a French market section", async () => {
    const bench = candidate(
      "new-orleans-bench",
      "New Orleans French Market Guitar Nap",
      "A sleeping person on a bench in the French Market, New Orleans, Louisiana.",
      ["French Quarter", "Sleeping people", "New Orleans"],
    );
    const paris = candidate(
      "paris-market",
      "Marché d'Aligre, Paris",
      "Produce stalls and shoppers at the Marché d'Aligre in Paris, France.",
      ["Markets in Paris", "Food markets in France"],
    );
    const provider = vi.fn(async () => [
      {
        sectionIndex: 0,
        chosenCandidate: paris.id,
        reason:
          "The Paris market depicts the requested subject in France; the New Orleans bench is the wrong country and shows a sleeping person.",
        fallbackQueries: [
          "marché alimentaire Paris France",
          "étals marché français Paris",
        ] as [string, string],
      },
    ]);
    setImageJudgeProviderForTests(provider);

    const result = await judgeImageCandidates(config, [
      {
        sectionIndex: 0,
        heading: "Au marché",
        body: "Students observe a French food market and describe what people buy.",
        audience: "Grade 8 classroom",
        query: "marché en France",
        candidates: [bench, paris],
      },
    ]);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.judgeCalls).toBe(1);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        sectionIndex: 0,
        chosenCandidate: "paris-market",
      }),
    ]);
    expect(result.decisions[0]!.chosenCandidate).not.toBe(
      "new-orleans-bench",
    );
  });

  it("rejects non-CC/PD, distress/exclusion metadata, undersized, and extreme-aspect candidates before judgment", () => {
    const base = candidate(
      "safe",
      "Paris market",
      "A market in Paris.",
      ["Markets in Paris"],
    );
    expect(imageCandidateRejectionReason(base)).toBeNull();

    expect(
      imageCandidateRejectionReason({
        ...base,
        id: "copyrighted",
        license: "All rights reserved",
      }),
    ).toMatch(/not CC\/PD/);

    expect(
      imageCandidateRejectionReason({
        ...base,
        id: "distress",
        title: "Sleeping person at market",
      }),
    ).toMatch(/exclusion list/);

    expect(
      imageCandidateRejectionReason({
        ...base,
        id: "small",
        width: 400,
        height: 300,
      }),
    ).toMatch(/below/);

    expect(
      imageCandidateRejectionReason({
        ...base,
        id: "panorama",
        width: 4000,
        height: 500,
      }),
    ).toMatch(/aspect ratio/);
  });
});
