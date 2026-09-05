import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetImageProviderStateForTests,
  searchCommonsCandidates,
  type ImageProviderEvent,
} from "../real-images";

describe("image provider rate-limit handling", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    resetImageProviderStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetImageProviderStateForTests();
  });

  it("honors a bounded Commons cooldown and emits progress before succeeding", async () => {
    const events: ImageProviderEvent[] = [];
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls === 1)
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              1: {
                pageid: 1,
                title: "Segovia Aqueduct",
                categories: [{ title: "Category:Roman aqueducts in Spain" }],
                imageinfo: [{
                  thumburl: "https://upload.wikimedia.org/example/segovia.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Segovia_Aqueduct.jpg",
                  width: 1200,
                  height: 800,
                  extmetadata: {
                    ObjectName: { value: "Segovia Aqueduct" },
                    ImageDescription: { value: "Roman aqueduct in Segovia, Spain." },
                    Artist: { value: "Fixture photographer" },
                    LicenseShortName: { value: "CC BY 4.0" },
                  },
                }],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await searchCommonsCandidates("Segovia aqueduct Spain", 1, {
      onEvent: (event) => events.push(event),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.candidates).toHaveLength(1);
    expect(events.some((event) => event.type === "rate_limit")).toBe(true);
    expect(events.some((event) => event.type === "cooldown_wait")).toBe(true);
    expect(events.filter((event) => event.type === "rate_limit")).toHaveLength(1);
  });
});
