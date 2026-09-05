import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeLicensedImage } from "../real-images";
describe("licensed image normalization", () => {
  it("decodes and rewrites provider bytes to a bounded JPEG before artifact libraries inspect them", async () => {
    const source = await sharp({
      create: { width: 1200, height: 800, channels: 4, background: "#2f739c" },
    })
      .png()
      .toBuffer();
    const normalized = await normalizeLicensedImage(source);
    const metadata = await sharp(normalized).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBeLessThanOrEqual(1600);
    expect(metadata.height).toBeLessThanOrEqual(1200);
  });
  it("rejects tiny non-image payloads", async () => {
    await expect(
      normalizeLicensedImage(Buffer.from("not an image")),
    ).rejects.toThrow("unexpectedly small");
  });
});
