import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
describe("durable storage configuration", () => {
  it("defaults to the writable storage directory when STORAGE_DIR is unset", () => {
    const config = loadConfig({
      OPENAI_API_KEY: crypto.randomUUID(),
      ADMIN_PASSWORD: crypto.randomUUID(),
    });
    const storageRoot = path.join(process.cwd(), "storage");
    expect(config.storageRoot).toBe(storageRoot);
    expect(config.dataDir).toBe(path.join(storageRoot, "data"));
    expect(config.uploadDir).toBe(path.join(storageRoot, "uploads"));
    expect(config.artifactDir).toBe(path.join(storageRoot, "artifacts"));
  });

  it("places every durable directory under one mounted root", () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-storage-"));
    roots.push(storageRoot);
    const config = loadConfig({
      OPENAI_API_KEY: crypto.randomUUID(),
      ADMIN_PASSWORD: crypto.randomUUID(),
      STORAGE_DIR: storageRoot,
    });
    expect(config.storageRoot).toBe(path.resolve(storageRoot));
    expect(config.dataDir).toBe(path.join(storageRoot, "data"));
    expect(config.uploadDir).toBe(path.join(storageRoot, "uploads"));
    expect(config.artifactDir).toBe(path.join(storageRoot, "artifacts"));
  });
});
