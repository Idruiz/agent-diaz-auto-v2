import { z } from "zod";
import path from "node:path";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z.string().url().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(16),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6"),
  OPENAI_FAST_MODEL: z.string().min(1).default("gpt-5.6-terra"),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2.1-mini"),
  STORAGE_DIR: z.string().optional().default(""),
  SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  IMAGE_PROVIDER: z.enum(["wikimedia"]).default("wikimedia"),
  MCP_SERVER_URL: z.string().url().optional().or(z.literal("")),
  MCP_SERVER_LABEL: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("workspace"),
  MCP_AUTHORIZATION: z.string().optional().default(""),
});

export type Config = z.infer<typeof EnvSchema> & {
  root: string;
  storageRoot: string;
  dataDir: string;
  artifactDir: string;
  uploadDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const root = process.cwd();
  const storageRoot = parsed.data.STORAGE_DIR
    ? path.resolve(parsed.data.STORAGE_DIR)
    : path.join(root, "storage");
  return {
    ...parsed.data,
    root,
    storageRoot,
    dataDir: path.join(storageRoot, "data"),
    artifactDir: path.join(storageRoot, "artifacts"),
    uploadDir: path.join(storageRoot, "uploads"),
  };
}
