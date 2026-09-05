import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["audit", "--omit=dev", "--json"],
  { encoding: "utf8", env: process.env },
);
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("[security] npm audit did not return valid JSON.");
  console.error(result.stderr || result.stdout);
  process.exit(1);
}
const vulnerabilities = report.vulnerabilities ?? {},
  names = Object.keys(vulnerabilities),
  allowed = new Set(["image-size", "pptxgenjs"]),
  unexpected = names.filter((name) => !allowed.has(name));

// npm audit legitimately exits 0 with an empty production-vulnerability map.
// That is strictly better than the reviewed exception below and must not be
// mistaken for an advisory-schema regression.
if (names.length === 0 && result.status === 0) {
  console.log("[security] No production dependency vulnerabilities reported by npm audit.");
  process.exit(0);
}

const advisoryUrls = new Set(
  (vulnerabilities["image-size"]?.via ?? [])
    .filter((item) => typeof item === "object")
    .map((item) => item.url),
);
const expectedAdvisories = [
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
];
const knownShape =
  names.every((name) => allowed.has(name)) &&
  names.length === 2 &&
  expectedAdvisories.every((url) => advisoryUrls.has(url)) &&
  vulnerabilities["pptxgenjs"]?.via?.includes("image-size") &&
  Number(report.metadata?.vulnerabilities?.critical ?? 0) === 0;
if (unexpected.length || !knownShape) {
  console.error(
    `[security] Unreviewed production dependency findings: ${unexpected.join(", ") || "advisory shape changed"}`,
  );
  console.error(JSON.stringify(vulnerabilities, null, 2));
  process.exit(1);
}
console.log(
  "[security] Reviewed exception: pptxgenjs -> image-size reports two parser DoS advisories.",
);
console.log(
  "[security] Mitigation enforced: all provider images are size-bounded, decoded, pixel-bounded, and rewritten to JPEG by Sharp before pptxgenjs receives them; generated charts are Sharp-produced PNGs.",
);
console.log(
  "[security] npm offers only a breaking downgrade to pptxgenjs 1.1.5; that downgrade is intentionally rejected. Any new or changed advisory fails this gate.",
);
