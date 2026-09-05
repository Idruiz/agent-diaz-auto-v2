# Artifact Trust Rebuild Checkpoint — 2026-09-04

This branch is a production-safety rebuild of Agent Díaz artifact delivery. It is intentionally isolated from `main` and from Render deployment until the full verification pipeline is green and publication is explicitly authorized.

## Delivery invariants

- Valid PPTX delivery must not be blocked by the diagnostic `emptyCanvasRatio` metric.
- A cosmetic sparsity warning is telemetry, not a reason to rebuild a structurally valid presentation forever.
- BUILD retries are fingerprinted by logical failure rather than regenerated package SHA so identical failures cannot evade loop detection.
- Optional image failure must never delete or hide audience-facing copy, bullets, activity directions, prompts, sentence frames, or corner labels.
- Every planned image query is attempted and counted; there is no silent 10/12-image cap.
- Specialized presentation layouts may expand one semantic section into multiple physical slides when needed to preserve content; no body, bullet, prompt, sentence frame, table row, or activity field may be silently truncated.
- Four Corners must render all prompts, exactly four meaningful labels, movement/discussion directions, and all sentence frames into the finished artifact.
- HTML and PDF presentation companions are additive and downstream. The validated PPTX is the primary artifact and companion generation must not delay or block its availability.
- Finished-file validation remains strict for package integrity, OOXML/Microsoft 365 schema checks (with the documented PptxGenJS notesMaster ordering exception), LibreOffice rendering, required visible-content coverage, internal website resource integrity, and deterministic artifact receipts.
- Spreadsheet analysis forces a completed code_interpreter call during evidence gathering, persists the executed numeric evidence across restarts, and rejects any numerical claim introduced only during JSON structuring.

## Verification scope

The branch verification suite covers:

- deterministic TypeScript compile checks;
- unit/integration tests across AgentRunner, builders, artifact quality, image selection, memory, contracts, website packaging, voice/persona paths, and presentation companions;
- exact French present-tense teaching presentation regression with Speed Dating and Four Corners;
- final-PPTX fidelity tests that inspect serialized slide XML for content survival;
- a regression that attempts more than ten image queries;
- recorded golden routes for presentation, document, analysis, and website artifacts;
- LibreOffice rendering and Open XML validation in CI;
- containerized exact-prompt and golden-matrix reproduction once the ordinary verify stage is green.

## Current publication boundary

No commit on this branch is authorized for `main` merely because CI passes. Fast-forwarding `main` and deploying Render remain separate explicit user authorizations.
