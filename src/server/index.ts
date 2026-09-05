import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createAuth } from "./auth.js";
import { ensureDirs } from "./files.js";
import { apiRoutes } from "./routes.js";
import { presentationExportRoutes } from "./presentation-exports.js";
import { AgentRunner } from "./openai-agent.js";
import { log } from "./log.js";
import { inspectV2RuntimeReadiness } from "./v2/runtime-readiness.js";

const config = loadConfig();
ensureDirs(config.dataDir, config.artifactDir, config.uploadDir);
const db = openDatabase(config);
const auth = createAuth(config, db);
const runner = new AgentRunner(config, db);
const packageMeta = JSON.parse(fs.readFileSync(path.join(config.root, "package.json"), "utf8")) as { version: string; dependencies?: Record<string, string> };
const exactDependencyVersion = (name: string) => String(packageMeta.dependencies?.[name] ?? "unknown").replace(/^[^0-9]*/, "");
const agentRuntimeReadiness = inspectV2RuntimeReadiness(process.env);
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestId = crypto.randomUUID(),
    started = Date.now();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () =>
    log(
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      "http.request",
      {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      },
    ),
  );
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "https://api.openai.com"],
      },
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz", (_req, res) =>
  res.status(agentRuntimeReadiness.ready ? 200 : 503).json(agentRuntimeReadiness),
);
app.get("/version", (_req, res) =>
  res.json({
    buildSha: process.env.RENDER_GIT_COMMIT?.trim() || "unknown",
    packageVersion: packageMeta.version,
    pptxgenjs: exactDependencyVersion("pptxgenjs"),
    validator: exactDependencyVersion("@xarsh/ooxml-validator"),
    agentsSdk: exactDependencyVersion("@openai/agents"),
    agentRuntime: agentRuntimeReadiness.runtime,
    agentReady: agentRuntimeReadiness.ready,
    sandboxProvider: agentRuntimeReadiness.sandboxProvider,
    mcpServerCount: agentRuntimeReadiness.mcpServerCount,
  }),
);
// Companion PDF/HTML presentation routes are additive and deliberately mounted
// before the canonical API routes. A failed companion export never replaces,
// delays, or invalidates the already accepted PPTX artifact.
app.use("/api", presentationExportRoutes(config, db, auth));
app.use("/api", apiRoutes(config, db, runner, auth));
app.use((err: any, _req: any, res: any, _next: any) => {
  log("error", "http.error", {
    requestId: res.locals.requestId,
    error: err?.message,
  });
  res.status(err?.status || 500).json({
    error:
      config.NODE_ENV === "production"
        ? "Request failed"
        : err?.message || "Request failed",
    requestId: res.locals.requestId,
  });
});
const publicDir = path.join(config.root, "dist", "public");
if (config.NODE_ENV === "production" && fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.use((_req, res) => res.sendFile(path.join(publicDir, "index.html")));
}
const server = app.listen(config.PORT, () => {
  log("info", "server.started", {
    port: config.PORT,
    env: config.NODE_ENV,
    agentRuntimeReadiness,
  });
  runner.resume();
});
const stop = () =>
  server.close(() => {
    db.close();
    process.exit(0);
  });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
