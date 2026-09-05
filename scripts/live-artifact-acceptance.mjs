const base = (process.env.DIAZ_BASE_URL || "").replace(/\/$/, "");
const password = process.env.DIAZ_ADMIN_PASSWORD || "";
if (!base || !password) {
  console.error("Set DIAZ_BASE_URL and DIAZ_ADMIN_PASSWORD to run real-provider acceptance.");
  process.exit(2);
}

let cookie = "";
async function request(route, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(base + route, { ...init, headers });
  if (!response.ok)
    throw new Error(route + " -> " + response.status + ": " + (await response.text()));
  return response;
}

const login = await request("/api/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ password }),
});
cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
if (!cookie) throw new Error("Login cookie missing");

async function uploadCsv(conversationId) {
  const csv = [
    "cohort,week,minutes",
    "A,1,42",
    "A,2,51",
    "B,1,37",
    "B,2,45",
    "C,1,40",
    "C,2,49",
  ].join("\n");
  const body = new FormData();
  body.append("files", new Blob([csv], { type: "text/csv" }), "acceptance-data.csv");
  const response = await request("/api/uploads", {
    method: "POST",
    headers: { origin: base },
    body,
  });
  const payload = await response.json();
  if (payload.errors?.length)
    throw new Error("analysis upload errors: " + JSON.stringify(payload.errors));
  const id = payload.uploads?.[0]?.id;
  if (!id) throw new Error("analysis upload returned no file id");
  return id;
}

const cases = [
  {
    kind: "presentation",
    prompt:
      "Create a teaching presentation to teach the present tense in French, connect it to French culture, and include complete Speed Dating and Four Corners student practice.",
  },
  {
    kind: "document",
    prompt:
      "Create a professional student-facing document about everyday culture in Spain with authentic examples and a discussion activity.",
  },
  {
    kind: "research",
    prompt:
      "Research current evidence about teen social media use in Canada and create a sourced professional report with clear limitations.",
  },
  {
    kind: "website",
    prompt:
      "Create a complete three-page website explaining public spaces in Barcelona with real licensed photography, working navigation, and sources.",
  },
  {
    kind: "analysis",
    prompt:
      "Analyze the attached CSV with Python. Calculate exact cohort totals and means, explain methods and limitations, and create a professional report with at least two evidence-based tables or charts. Do not invent unavailable values.",
    uploadCsv: true,
  },
];

const results = [];
for (const testCase of cases) {
  const { kind, prompt } = testCase;
  const conversation = await (
    await request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ title: "Acceptance " + kind }),
    })
  ).json();
  const fileIds = testCase.uploadCsv ? [await uploadCsv(conversation.id)] : [];
  const job = await (
    await request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ kind, prompt, conversationId: conversation.id, fileIds }),
    })
  ).json();

  let current;
  const deadline = Date.now() + 20 * 60 * 1000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    current = await (await request("/api/jobs/" + job.id)).json();
    if (["failed", "blocked", "cancelled"].includes(current.status))
      throw new Error(kind + " failed: " + (current.error || current.message));
  } while (current.status !== "completed" && Date.now() < deadline);

  if (current.status !== "completed") throw new Error(kind + " timed out");
  const originals = (current.artifacts || []).filter(
    (artifact) => !/--(?:html|pdf)$/i.test(artifact.id),
  );
  if (originals.length !== 1)
    throw new Error(kind + " produced " + originals.length + " primary artifacts");
  const artifact = originals[0];
  const attempts = artifact.receipt?.attempts || [];
  if (attempts.length)
    throw new Error(kind + " was not first-pass: " + JSON.stringify(attempts));
  if (kind === "presentation" && artifact.receipt?.presentation?.layoutFitting?.retried)
    throw new Error("presentation used a layout repair pass");

  const download = await request("/api/artifacts/" + artifact.id + "/download");
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.length < 1500) throw new Error(kind + " download unexpectedly small");

  if (kind === "presentation") {
    // The PPTX is deliverable immediately. Companion conversion is deliberately
    // asynchronous, so poll only for companions after proving the primary file
    // is already downloadable.
    let views = current.artifacts || [];
    const companionDeadline = Date.now() + 2 * 60 * 1000;
    while (
      Date.now() < companionDeadline &&
      (!views.some((item) => item.id === artifact.id + "--html") ||
        !views.some((item) => item.id === artifact.id + "--pdf"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      current = await (await request("/api/jobs/" + job.id)).json();
      views = current.artifacts || [];
    }
    const html = views.find((item) => item.id === artifact.id + "--html");
    const pdf = views.find((item) => item.id === artifact.id + "--pdf");
    if (!html || !pdf)
      throw new Error("presentation companions did not become ready within two minutes");
    for (const companion of [html, pdf]) {
      const response = await request("/api/artifacts/" + companion.id + "/download");
      const companionBytes = new Uint8Array(await response.arrayBuffer());
      if (companionBytes.length < 2000)
        throw new Error(companion.name + " download unexpectedly small");
    }
  }

  results.push({
    kind,
    jobId: job.id,
    artifact: artifact.name,
    bytes: bytes.length,
    firstPass: true,
    uploadedFiles: fileIds.length,
  });
  console.log(
    "[acceptance] " +
      kind +
      ": first-pass OK (" +
      artifact.name +
      ", " +
      bytes.length +
      " bytes)",
  );
}

console.log(JSON.stringify({ base, results }, null, 2));
