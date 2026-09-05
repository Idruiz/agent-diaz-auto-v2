# Agent Díaz Artifact Trust Rebuild

This branch replaces repair-driven artifact generation with a first-pass deterministic contract.

## Acceptance contract

- Semantic plans are normalized and compiled into renderable physical layouts before serialization.
- Deterministic BUILD failures are not retried with identical inputs.
- Cosmetic presentation metrics such as empty-canvas ratio are telemetry, not delivery blockers.
- Truly empty slides, corrupt packages, missing required content, OOXML failures, and renderer failures remain objective hard defects.
- Presentation, document, research, analysis, and website builders preserve planned semantic content without silent collection caps or truncation.
- Presentation PPTX is the primary deliverable; PDF and standalone HTML are additive companions and cannot block PPTX delivery.
- Spreadsheet analysis requires executed Code Interpreter evidence, and numeric plan claims are checked against the request or executed evidence.
- Artifact files use job/artifact-specific physical names rather than title-only paths.
- Each artifact run records a redacted structured JSONL log stream that can be opened, refreshed, selected, and copied from the job UI.
- Mocked-provider tests are treated as deterministic regressions, not proof of live-provider behavior. Live-provider acceptance remains a separate production validation step.

## Publication rule

A branch is eligible for publication only after the normal Verify workflow passes the test suite, application build, runtime smoke, reviewed audit, containerized regression matrix, exact presentation regression, and production container build. Deployment remains a separate action from publishing `main`.
