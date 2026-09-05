import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-runtime-smoke-")),
  password = randomBytes(24).toString("base64url"),
  openAiKey = randomBytes(24).toString("base64url");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const value = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolve(value)));
  });
});
const base = `http://127.0.0.1:${port}`,
  child = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      BASE_URL: base,
      OPENAI_API_KEY: openAiKey,
      ADMIN_PASSWORD: password,
      STORAGE_DIR: storage,
      RENDER_GIT_COMMIT: "runtime-smoke-sha",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk));
child.stderr.on("data", (chunk) => (logs += chunk));
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy. Logs: ${logs}`);
};
try {
  await waitForHealth();
  const health = await fetch(`${base}/healthz`),
    csp = health.headers.get("content-security-policy") || "";
  if (!/media-src[^;]*blob:/.test(csp))
    throw new Error(`CSP blocks generated voice Blob URLs: ${csp}`);
  const versionResponse = await fetch(`${base}/version`),
    versionBody = await versionResponse.json();
  if (
    !versionResponse.ok ||
    versionBody.buildSha !== "runtime-smoke-sha" ||
    versionBody.packageVersion !== "3.4.0" ||
    versionBody.pptxgenjs !== "4.0.1" ||
    versionBody.validator !== "0.3.0"
  )
    throw new Error(`Version endpoint failed: ${JSON.stringify(versionBody)}`);
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`Login failed (${login.status})`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Login cookie missing");
  const mutationHeaders = {
    "content-type": "application/json",
    origin: base,
    cookie,
  };
  const created = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: mutationHeaders,
    body: "{}",
  });
  if (created.status !== 201)
    throw new Error(`Conversation creation failed (${created.status})`);
  const conversation = await created.json();
  const mode = await fetch(
      `${base}/api/conversations/${conversation.id}/settings`,
      {
        method: "PATCH",
        headers: mutationHeaders,
        body: JSON.stringify({ modelMode: "deep", persona: "javier" }),
      },
    ),
    modeBody = await mode.json();
  if (modeBody.modelMode !== "deep")
    throw new Error("Conversation mode did not persist");
  if (modeBody.persona !== "javier")
    throw new Error("Conversation persona did not persist");
  const storageResponse = await fetch(`${base}/api/system/storage`, {
      headers: { cookie },
    }),
    storageBody = await storageResponse.json();
  if (!storageBody.writable || !storageBody.database)
    throw new Error(`Storage probe failed: ${JSON.stringify(storageBody)}`);
  const artifactId = crypto.randomUUID(),
    jobId = crypto.randomUUID(),
    artifactName = "runtime-smoke.txt",
    artifactPath = path.join(storage, "artifacts", artifactName),
    artifactBytes = "authenticated artifact download passed",
    now = new Date().toISOString();
  fs.writeFileSync(artifactPath, artifactBytes);
  const database = new Database(
    path.join(storage, "data", "agent-diaz.sqlite"),
  );
  database
    .prepare(
      "INSERT INTO jobs(id,kind,status,prompt,conversation_id,file_ids_json,progress,message,output_text,model_mode,model,reasoning_effort,created_at,updated_at) VALUES(?, 'document', 'completed', 'Runtime smoke', ?, '[]', 100, 'Completed', 'Ready', 'deep', 'gpt-5.6-sol', 'high', ?, ?)",
    )
    .run(jobId, conversation.id, now, now);
  database
    .prepare(
      "INSERT INTO artifacts(id,job_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      artifactId,
      jobId,
      artifactName,
      "text/plain",
      Buffer.byteLength(artifactBytes),
      artifactPath,
      now,
    );
  database.close();
  const download = await fetch(`${base}/api/artifacts/${artifactId}/download`, {
    headers: { cookie },
  });
  if (!download.ok || (await download.text()) !== artifactBytes)
    throw new Error("Authenticated artifact download failed");
  const page = await fetch(base),
    html = await page.text();
  if (!page.ok || !html.includes('id="root"'))
    throw new Error("Production frontend was not served");
  console.log(
    `[smoke] health/version/CSP voice playback, authentication, conversation mode/persona, durable storage, artifact download, and production frontend passed on port ${port}.`,
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  fs.rmSync(storage, { recursive: true, force: true });
}
