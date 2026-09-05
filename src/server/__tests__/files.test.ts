import { describe, expect, it } from "vitest";
import { safeJoin } from "../files";
describe("safeJoin", () => {
  it("contains paths", () => {
    expect(safeJoin("/tmp/safe", "../../etc/passwd")).toBe("/tmp/safe/passwd");
  });
  it("normalizes hostile names", () => {
    expect(safeJoin("/tmp/safe", "a<script>.txt")).toBe(
      "/tmp/safe/a_script_.txt",
    );
  });
});
