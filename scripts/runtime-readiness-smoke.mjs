import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import Database from "better-sqlite3";

// Executed inside the production image, as its real runtime user, by Verify.
const child = spawn(process.execPath, ["dist/server/index.js"], {
  env: { ...process.env, PORT: "3000", OPENAI_API_KEY: "ci-readiness-no-provider-calls",
    ADMIN_PASSWORD: "ci-readiness-no-real-secret", AGENT_RUNTIME: "v2",
    AGENT_SANDBOX_PROVIDER: "render", AGENT_BROWSER_AUTONOMY: "both", STORAGE_DIR: "/var/data" },
  stdio: ["ignore", "inherit", "inherit"],
});
const exited = once(child, "exit");
try {
  let response;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      response = await fetch("http://127.0.0.1:3000/readyz", { signal: AbortSignal.timeout(2_000) });
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert(response, "Readiness endpoint did not respond before deadline");
  const body = await response.json();
  const expectReady = process.env.EXPECT_READY !== "false";
  assert.equal(response.status, expectReady ? 200 : 503);
  assert.equal(body.ready, expectReady);
  assert.equal(body.storageWritable, true);
  assert.equal(body.persistentPath, "/var/data");
  assert.equal(body.mcpServerCount, 2);
  if (expectReady) {
    assert.equal(body.home.path, "/home/diaz");
    assert.equal(body.home.writable, true);
    assert.equal(body.chromium.available, true);
    assert.equal(body.chromium.launchVerified, true);
    assert.equal((await fetch("http://127.0.0.1:3000/api/workspace/open", { method: "POST" })).status, 401);
    const login = await fetch("http://127.0.0.1:3000/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ci-readiness-no-real-secret" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const database = new Database("/var/data/data/agent-diaz.sqlite");
    try {
      const at = new Date().toISOString();
      database.prepare("INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)").run("ci-clean-conversation", "Failed test", at, at);
      database.prepare("INSERT INTO jobs(id,kind,status,prompt,conversation_id,file_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("ci-clean-job", "presentation", "failed", "Failed test", "ci-clean-conversation", "[]", at, at);
      fs.mkdirSync("/var/data/artifacts/.agent-v2/ci-clean-job", { recursive: true });
      fs.writeFileSync("/var/data/artifacts/.agent-v2/ci-clean-job/INFRA_RETRY.json", "{}");
      const opened = await fetch("http://127.0.0.1:3000/api/workspace/open", { method: "POST", headers: { Cookie: cookie } });
      assert.equal(opened.status, 200);
      assert.equal((await opened.json()).clearedJobs, 1);
      assert.equal(database.prepare("SELECT id FROM jobs WHERE id='ci-clean-job'").get(), undefined);
      assert.equal(fs.existsSync("/var/data/artifacts/.agent-v2/ci-clean-job"), false);
      console.log("Authenticated clean-on-open removed failed job and retry files");
    } finally { database.close(); }
  } else {
    assert.equal(body.home.writable, false);
    assert.equal(body.chromium.launchVerified, false);
    assert(body.issues.some((issue) => issue.startsWith("HOME_PROBE_FAILED:")));
  }
  const cached = await (await fetch("http://127.0.0.1:3000/readyz")).json();
  assert.equal(cached.checkedAt, body.checkedAt, "Repeated probes must use cached startup result");
  assert.equal((await fetch("http://127.0.0.1:3000/healthz")).status, 200);
  console.log(`Production readiness ${expectReady ? "success" : "failure"} semantics passed`);
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(timer);
}
