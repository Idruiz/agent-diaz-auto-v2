# Agent Díaz Artifact Overhaul — Decision Log

## 2026-09-02 — Branch naming tool constraint
DECISION: Use `codex/overhaul-artifact-pipeline` instead of the requested `overhaul/artifact-pipeline`.
REASON: The repository write tool rejected creation of the requested branch name twice and accepted the assistant-owned `codex/` namespace. The branch starts from exact main SHA `fa29f91ac3ebb3fa6b99a58628f75927597ce038`. Main and Render remain untouched.

## Deferred
None.

## Step 1 — Failure taxonomy, fingerprint, budget, diagnostics
DECISION: Persist artifact orchestration state in `jobs.artifact_run_state_json`.
REASON: LLM-call budgets and fingerprints must survive a service restart rather than resetting in memory.

DECISION: Set the artifact LLM-call budget to 6 and wall-time budget to 20 minutes.
REASON: The overhaul specification requires visible bounded spend and wall time. Six is the requested default cap; 20 minutes leaves room for Office validation while preventing unbounded jobs.

DECISION: BUILD and ASSET failures get one deterministic same-plan retry and never trigger a plan-repair LLM call.
REASON: A builder/package or retrieval failure is not evidence that the plan content is wrong. Repeating the same fingerprint twice stops the identical loop.

DECISION: INFRA failures set job status `blocked`, expose `blocked: infrastructure`, and use production-only exponential retry without an LLM call.
REASON: Missing/timeout renderers and validator/provider infrastructure are operational failures. Test environments suppress timers to keep regression tests deterministic.

DECISION: A blocked infrastructure retry resumes from the structure/build phase when a provider response already exists.
REASON: Reinterpreting a stored structure response as evidence would spend another LLM call and corrupt phase semantics.

DECISION: Failed BUILD packages remain at the build path and are copied with JSON metadata to `storage/diagnostics/<jobId>/`.
REASON: The previous deletion destroyed forensic evidence. No diagnostic copy is published as an artifact.

DECISION: Update the legacy “requires regeneration” test to assert the typed `BUILD` failure and retained specimen.
REASON: The old string and deletion expectation encoded the behavior Step 1 intentionally replaces; the test remains and now asserts the stronger failure contract.

DECISION: Touch `src/shared/contracts.ts` only to add the canonical `blocked` job state.
REASON: The execution order names the job-status enum under `db.ts`, but this repository stores the canonical enum in `src/shared/contracts.ts`; no other contract behavior changed.

## Deferred
- Step 2 will replace first-error plan validation with normalization plus batched `PLAN_CONTENT` violations.

## Step 2 — NORMALIZE and plan-gate deletion
DECISION: Provider structured-output schema accepts 1–30 presentation sections; deterministic NORMALIZE owns the 11-section maximum.
REASON: Provider rejection prevents computable excess-section reconciliation and wastes an LLM round trip.

DECISION: A presentation below seven content sections remains a mandatory PLAN_CONTENT violation, while excess sections are deterministically merged.
REASON: Missing substantive content cannot be invented safely by code; excess content can be reconciled without model judgment.

DECISION: Duplicate image queries, duplicate requirement IDs, unknown requirement IDs, missing chart sourceNote, and excess sections are code-owned normalizations.
REASON: These are computable structural defects and must not consume plan-repair calls.

DECISION: Short speaker notes are retained and recorded as warnings rather than hard failures.
REASON: Character count is not a reliable proxy for teaching quality and the spec explicitly removes the note-length gate.

DECISION: Remove the language-specific CULTURE_RE content scan and use prompt-to-mandatory-requirement coverage instead.
REASON: Culture must be represented as an extracted user requirement, not inferred from English/French keyword occurrence in arbitrary slide copy.

DECISION: PLAN_CONTENT validation returns a batched list and permits at most two plan-repair LLM calls; after that only non-mandatory score-like violations may be downgraded into receipt normalizations.
REASON: Mandatory missing content still needs model judgment, while visual-count targets and similar quality scores must not cause an unbounded repair loop.

DECISION: Interpret Step 2's §4 deletion requirement as the plan-gate subset owned by Step 2. Remaining §4 deletions stay in their explicitly scheduled steps: image-count throw and honey special case in Step 3, DOCX post-serialization repair in Step 5, website split/base64 duplication in Step 6.
REASON: The autonomous order simultaneously restricts Step 2 file scope to plan/quality/contracts/tests and assigns those later deletions to Steps 3/5/6. Touching them in Step 2 would violate the file-scope rail and combine steps.

DECISION: Raise the parameterized deterministic builder test timeout from 5s to 15s.
REASON: The full validation suite now runs more concurrent Office/render work; the test body and assertions are unchanged and the prior 5s boundary became timing-sensitive in CI.

## Deferred
- Step 3: remove image-count throws and the honey/bee special case while replacing image retrieval with candidate filtering plus one artifact-level judgment call.
- Step 5: remove `repairDocumentBuffer()` and post-serialization DOCX XML editing.
- Step 6: remove hard-coded website page splitting and repeated base64 image embedding.

## Step 3 — Image judge and retrieval rewrite
DECISION: Split Commons handling into candidate metadata search/filter, one artifact-level qualitative judge call, then chosen-only download.
REASON: The previous title-substring score could not judge geography, dignity, classroom suitability, or subject relevance and downloaded assets before deciding whether to use them.

DECISION: Filter candidates before judgment to CC/PD licenses only, minimum 640×400, aspect ratio 0.45–2.5, and the spec exclusion vocabulary for distress, nudity, memorial, protest/police/weapon, logos/maps/screenshots/scans/book covers.
REASON: These checks are deterministic and should not consume model judgment.

DECISION: Delete the honey/bee query special case entirely.
REASON: It was a hard-coded test-passing branch prohibited by the overhaul order.

DECISION: Use a single structured-output image-judge request for all image-bearing sections in production; tests may inject a deterministic provider, and ordinary test fixtures use a test-only first-filtered-candidate fallback.
REASON: Production must spend one qualitative call per artifact, while unrelated unit tests must not make network model calls. The dedicated judge regression injects the provider and proves exactly one call.

DECISION: Exhausted or rejected image retrieval no longer throws merely because an image-count target was missed.
REASON: Missing imagery is an ASSET outcome, not evidence that the plan is invalid. The artifact proceeds with a no-photo layout; the receipt records requested/fetched/judged/rejected/placed counts and reasons.

DECISION: Count `placed` from actual builder branches that embed the chosen image, not from fetched candidates.
REASON: The original false title-slide claim came from equating fetched assets with delivered assets.

DECISION: Track the qualitative call explicitly as `images.judgeCalls` in Step 3; defer folding that count into the orchestration-level `llmCalls` field until Step 7, where `openai-agent.ts` is an allowed file.
REASON: Step 3's safety rail forbids modifying `openai-agent.ts`. Production still makes at most one image-judge call, and the existing bounded plan path tops out below the six-call global cap; the receipt total must be reconciled later so Step 9's before/after number is honest.

## Deferred
- Step 4: reconcile visible visual references against actually placed assets and add PPTX activity+photo / activity-template variety.
- Step 5: remove `repairDocumentBuffer()` and post-serialization DOCX XML editing.
- Step 6: remove hard-coded website page splitting and repeated base64 image embedding.
- Step 7: add `images.judgeCalls` to the orchestration-level `llmCalls` receipt total while touching `openai-agent.ts`.

## Step 4 — RECONCILE and PPTX layouts
DECISION: Run deterministic RECONCILE after image resolution and before PPTX layout.
REASON: Visible copy must be reconciled against assets that were actually delivered, not against planned or requested assets.

DECISION: When an image is absent, visible sentences/bullets/activity text that explicitly reference an image/photo/map are moved into speaker notes while unrelated visible copy remains.
REASON: The original deck told students to inspect visuals that were not present. This preserves the authoring context without leaving a false audience-facing instruction.

DECISION: Treat any fetched image that is not physically placed by a PPTX layout as a BUILD invariant violation.
REASON: Fetching and then silently discarding assets caused the false title-slide count and wasted retrieval cost. The builder now records placement through the same helper used for actual embedding.

DECISION: Add photo-capable variants for activity, chart, table, and diagram layouts.
REASON: Layout precedence must not discard an image merely because the section also contains a structured activity or data/diagram visual.

DECISION: Use five deterministic activity templates: four-corners quadrants, speed-dating rotation, guided step rail, discussion prompt cards, and independent checklist.
REASON: The prior generic activity template produced cloned slides and excessive empty canvas. The exact French regression requires at least three distinct templates and now exercises three.

DECISION: Compute the title-slide visual count from `placedImageQueries.size` only after all content slides have been laid out.
REASON: The cover/title must report delivered assets, never fetched or planned assets.

DECISION: Document a Step 4 exception for “real speaker-note paragraphs.” PptxGenJS 4.0.1 serializes all slide-note text into one notes-body `<a:p>`; multiple `addNotes()` calls are concatenated inside that single paragraph. Preserve native CRLF-separated note blocks and do not patch notes XML after serialization.
REASON: Producing multiple OOXML note paragraphs would require either post-serialization OOXML surgery, explicitly prohibited by the overhaul and protected by the AST guard, or replacing/patching the generator dependency outside Step 4’s allowed file scope. The regression proves native CRLF block separation and preserves the no-XML-rewrite safety rail. Desktop note rendering remains a consumer-validation risk.

DECISION: Validate the built presentation against the reconciled plan and record `presentation.{placedAssets,activityTemplates,reconciliations,titleCounts}` in the receipt.
REASON: Verification and receipt claims must describe the artifact that was actually built after reconciliation.

## Deferred
- Step 5: remove `repairDocumentBuffer()`, render DOCX activities, and record truncations.
- Step 6: replace website hard-coded page splitting and base64 image duplication.
- Step 7: reconcile image-judge calls into the global LLM-call count and add teaching evidence steering.
- Step 8: record layout/empty-canvas/source-topicality scores and all consumer gates.

## Step 5 — Native DOCX serialization and activity fidelity
DECISION: Delete `repairDocumentBuffer()` and direct-write the bytes returned by `Packer.toBuffer()`.
REASON: Post-serialization unzip/regex/rezip editing is prohibited by the overhaul and hid generator defects instead of solving them at construction time.

DECISION: Assign deterministic `docProperties.id` values to every DOCX `ImageRun` before serialization.
REASON: The raw `docx` generator otherwise emitted duplicate `wp:docPr id="1"` values. The locked runtime is docx 9.7.1, whose typed API accepts an explicit string ID, so charts, diagrams, and photographs now receive `"1"`, `"2"`, … before OOXML is written.

DECISION: Report `docx 9.7.1` as the generator version.
REASON: `package.json` permits `^9.5.1`, but the committed lock resolves 9.7.1. Receipts must report the actual locked generator rather than the lower semver range floor.

DECISION: Render every schema-bounded bullet and table row instead of slicing them in the Word builder.
REASON: The previous `.slice(0,10)` and `.slice(0,24)` silently deleted valid plan content. The schema already bounds these collections, so no additional builder truncation is necessary.

DECISION: Render all activity directions, prompts, sentence frames, duration/type metadata, and Four Corners labels in DOCX; Four Corners uses a native two-row by two-column Word table.
REASON: The old document builder validated activity content in the plan and then silently omitted it from the file.

DECISION: Add `document.{activitiesRendered,activityTypes,truncations}` to the receipt and keep `truncations=[]` when nothing is intentionally clipped.
REASON: Any future deliberate truncation must become visible evidence rather than disappearing silently.

DECISION: Guard against actual Word-package rewrite functions, not benign validation reads.
REASON: `packageVisibleText()` reads `word/document.xml` and separately strips HTML tags with `.replace()`; it does not mutate the DOCX. The AST guard therefore requires both Word XML access and a package-mutation primitive such as `setData`, `updateFile`, `writeZip`, `toBuffer`, or `atomicWrite`.

## Deferred
- Step 6: replace website hard-coded page splitting and base64 image duplication with plan-owned page assignment and shared assets.
- Step 7: reconcile image-judge calls into the global LLM-call count and strengthen evidence/teaching steering.
- Step 8: add final layout/content/source/consumer scoring and gates.

## Step 6 — Plan-owned website architecture and shared assets
DECISION: Make `plan.pages` mandatory and authoritative for website builds; delete the hard-coded modulo-thirds fallback entirely.
REASON: The validator and builder must obey the same site architecture. Inventing Home/Insights/Resources after validation made the plan contract meaningless.

DECISION: Require every non-source section heading to be assigned to exactly one planned page, and reject unknown, missing, or multiply assigned headings.
REASON: Page ownership is deterministic and must not be silently inferred or duplicated.

DECISION: Write one shared stylesheet at `assets/styles.css` and reference it from every page.
REASON: Repeating the complete site CSS in every HTML file wastes package size and makes page behavior diverge.

DECISION: Hash normalized photograph bytes and write each unique file once under `assets/images/<sha>.jpg`.
REASON: The previous builder embedded every image as base64 in every page that used it. Content-addressed files provide deterministic deduplication and portable relative references.

DECISION: Validate both local `href` and `src` resources in the finished ZIP and reject `data:image` payloads.
REASON: Link integrity alone does not catch missing stylesheets/images or accidental return of base64 embedding.

DECISION: Treat fetched-but-unplaced website images as a BUILD invariant failure.
REASON: As with PPTX, retrieval cost and receipt counts must correspond to delivered assets rather than silently discarded files.

DECISION: Render website activities from the same typed activity object used by PPTX/DOCX, including directions, prompts, sentence frames, duration, and Four Corners labels.
REASON: Cross-format content fidelity requires user-requested activities to survive regardless of output format.

DECISION: Permit `<style>` elements inside generated inline SVG charts while forbidding page-level inline CSS in `<head>`.
REASON: chart SVGs carry their own local typography rules, whereas the page shell must use the shared stylesheet. The regression scopes the assertion to the document head.

DECISION: Record `website.{plannedPages,renderedPages,sectionAssignments,uniqueImageFiles,sharedStylesheet,brokenInternalResources}` in the receipt.
REASON: The finished package must expose enough evidence to audit architecture and asset deduplication.

## Deferred
- Step 7: reconcile image-judge calls into global LLM-call accounting and strengthen evidence/teaching steering.
- Step 8: final finished-file quality scoring and consumer gates.
- Step 9: exact regression matrix, before/after receipt, final diagnostics and PR checkpoint.

## Step 7 — Teaching evidence steering and LLM-call accounting
DECISION: Classify teaching requests deterministically from explicit instructional vocabulary and inject the exact §3.7 content-research sentence only for those requests.
REASON: Teaching artifacts need cultural/content facts, authentic examples, places, foods, customs, sample sentences, image-worthy subjects, and credible content sources; generic business/research artifacts should not be steered toward classroom content.

DECISION: Keep the teaching-content instruction as one exported constant in `skills.ts` and test its exact literal text.
REASON: The overhaul specifies the sentence verbatim; centralizing it prevents silent drift between skill and orchestration code.

DECISION: Add successful image-judge calls to global `llmCalls` as `receipt.images.judgeCalls × successful-build attempt count`.
REASON: Step 3 intentionally tracked the qualitative judge separately because `openai-agent.ts` was out of scope. A same-plan build retry re-runs image resolution and therefore can spend another qualitative judge call; multiplying by total build attempts records that spend rather than hiding it.

DECISION: Persist the reconciled LLM-call total back into `artifact_run_state_json` and fail if it would exceed the six-call budget.
REASON: The receipt and durable run state must agree, and qualitative image judgment is model spend just as evidence/structure/repair calls are.

## Deferred
- Step 8: add consumer-gate fields and non-blocking quality scores; run four recorded golden plans.
- Step 9: create checkpoint-3 container artifacts/receipts and compare final LLM calls to the Step 1 baseline.

## Step 8 — Finished-file scoring, consumer gates, and recorded golden runs
DECISION: Add explicit consumer-validation booleans `powerPointDesktopValidated`, `wordDesktopValidated`, and `browserValidated`, all initialized to `false` by automated builds.
REASON: Automated schema/render checks are not substitutes for opening the finished files in the target consumer. These fields can become true only when the relevant real consumer validation is actually performed.

DECISION: Record non-blocking `scores.layoutVariety`, `scores.emptyCanvasRatio`, `scores.notesCoverage`, and `scores.sourceTopicality` in every receipt.
REASON: The overhaul requires quality evidence beyond “file opens.” Layout variety and note coverage derive from the reconciled plan, and PPTX empty-canvas ratio derives from serialized shape geometry.

DECISION: Keep `sourceTopicality.score=null` with status `pending_qualitative_review` rather than manufacturing a lexical relevance score.
REASON: Source topicality is qualitative. Step 8 does not add a new model-review call, so a deterministic numeric claim would be fake precision.

DECISION: Estimate PPTX empty canvas from serialized `a:xfrm` box areas and document the method and limitation in the receipt.
REASON: This is a deterministic proxy that can be audited from the finished package. Overlaps are not unioned, so the score is intentionally diagnostic rather than a hard acceptance gate.

DECISION: Add four fixed golden plans and execute them through the real AgentRunner: exact French present-tense deck, Spanish culture document, CSV analysis report, and exact three-page website.
REASON: Fixed plans make the quality gate reproducible while still exercising evidence/structure orchestration, image judgment/retrieval, builders, validation, persistence, and receipts.

DECISION: Remove cross-row PPTX diagram connectors that would require negative width when wrapping from the final column to the first column of the next row.
REASON: The Step 8 French golden exposed an Open XML MinInclusive violation caused by a negative connector extent. Same-row arrows remain; wrapped rows no longer emit invalid geometry.

DECISION: Treat uppercase `TODO` as a placeholder marker but not lowercase Spanish `todo`.
REASON: The previous case-insensitive regex rejected ordinary Spanish prose such as “todo el país.” Other placeholder phrases remain case-insensitive, and a dedicated multilingual regression pins the distinction.

DECISION: Emit short-speaker-note warnings only for presentations.
REASON: DOCX, analysis, and website outputs do not have a speaker-note surface; warning on their empty `speakerNotes` field polluted receipts with irrelevant normalizations.

## Step 8 residuals
- `sourceTopicality` still requires a human or bounded qualitative review before it can receive a real score.
- Consumer validation booleans remain false until Inarvis opens the generated PPTX in PowerPoint Desktop, the DOCX in Word Desktop, and the site in a browser.

## Deferred
- Step 9: create the checkpoint-3 container artifacts and machine-readable receipts, preserve them in CI, compare final LLM-call totals to the Step 1 baseline, run the complete regression matrix, and stop at the final branch checkpoint without merging/deploying.

## Step 9 — Checkpoint-3 package, final regression matrix, and call accounting
DECISION: Generate checkpoint-3 from the recorded four-case golden matrix inside the same regression container used by CI.
REASON: The final evidence must exercise the containerized production dependencies and cannot rely on host-only temporary files.

DECISION: Persist four finished artifacts, one JSON receipt per artifact, and a machine-readable `summary.json` under `storage/diagnostics/checkpoint-3`, then upload the directory as a dedicated CI artifact.
REASON: The checkpoint must preserve the actual finished files and their validation/accounting evidence together rather than leaving evidence only in transient logs.

DECISION: Recompute SHA-256 after each artifact is copied into checkpoint-3 and require that exported-file hash to equal the artifact receipt's `artifactSha256`.
REASON: This proves the preserved checkpoint binary is byte-for-byte the same artifact that passed validation; an upload or copy cannot silently substitute a different file.

DECISION: Print checkpoint filenames, SHA-256 values, and `summary.json` into CI logs before artifact upload.
REASON: The checkpoint remains independently auditable even if a workflow artifact later expires.

DECISION: Compare the exact French teaching route against the frozen Step 1 baseline without claiming an artificial cost reduction.
REASON: The baseline used two mocked LLM calls (evidence + structure). The overhauled route uses three bounded calls when images are requested: evidence + structure + one qualitative image-relevance judgment. The +1 call is intentional and replaces unbounded/irrelevant repair churn with one explicit judgment step.

DECISION: The final golden acceptance matrix is four real `AgentRunner` jobs: French teaching PPTX, Spanish culture DOCX, CSV analysis DOCX, and planned three-page website ZIP.
REASON: Together they exercise presentation pedagogy/visuals, Word activities, uploaded-data analysis, and website page planning/resources through orchestration, build, validation, persistence, and receipts.

DECISION: Keep consumer validation flags false in automated checkpoint receipts.
REASON: `powerPointDesktopValidated`, `wordDesktopValidated`, and `browserValidated` may only be asserted after the corresponding real consumer acceptance is performed. LibreOffice/schema validation is not a substitute.

DECISION: Stop at the branch checkpoint after the full CI matrix is green.
REASON: The governing authorization explicitly forbids modifying or pushing `main`, merging, deploying, or changing Render during Steps 1–9.

## Step 9 acceptance evidence required on the final branch head
- `npm run verify` green.
- Containerized checkpoint-3 golden matrix green.
- Exported checkpoint SHA-256 values equal receipt SHA-256 values.
- Exact presentation regression green inside the regression container.
- Production Docker image build green.
- Exact-prompt regression artifacts uploaded.
- Checkpoint-3 package uploaded.
- Branch remains fast-forward-only from `main` with zero commits behind.
- No merge, `main` update, Render deployment, or Render configuration change.

## Step 10 — Deterministic presentation layout fitting
DECISION: Route every model-authored PowerPoint text value through one `fit: "shrink"` helper whose height is estimated from width, font size, character count, explicit line breaks, line height, and margins.
REASON: Model text must never enter an unbounded fixed-height text box, while deterministic estimation keeps layout fitting independent of additional LLM calls.

DECISION: Give Speed Dating separate badge and directions rows, size its two-to-six prompt grid from the prompt count, and compute the sentence-frame band from frame count and line height.
REASON: The production regression showed the badge colliding with directions and a clipped frame band.

DECISION: Expand charts and native diagrams across the 0.75–12.6 by 1.5–6.8 inch content area; render diagram labels at 20 points; and split tables after eight data rows while selecting 14–18 point table text and at least 60% content-height coverage.
REASON: Structured visuals should use the available canvas instead of remaining as small islands in a large slide.

DECISION: Compute `emptyCanvasRatio` from the geometric union of serialized `a:xfrm` and `p:xfrm` boxes, fail content slides above 0.55 as `BUILD`, and retry exactly once with the same plan, assets, and deterministic scaled layout.
REASON: Summing overlapping rectangles understated whitespace, while a same-plan retry prevents both sparse publication and unnecessary plan-repair/model calls.

DECISION: Preserve both pre-retry and final per-slide ratios in `receipt.presentation.layoutFitting` and keep title/source slides out of the content-slide gate.
REASON: The receipt must prove the actual corrective effect without misclassifying deliberately sparse cover and evidence-trail slides.

DECISION: Remove section merging, accept at most 14 presentation sections, and classify counts above 14 as one mandatory `PLAN_CONTENT` violation containing the observed count.
REASON: Merging changed headings into synthetic `" / "` titles and could discard the second section's visual semantics.

DECISION: Reject generic or one-token Four Corners labels through the RECONCILE-owned predicate and the exact single repair message required by the plan-quality gate.
REASON: Corner A–D describes room positions rather than the four audience-facing choices students must select.

DECISION: Do not substitute the existing hand-authored French golden plan for the requested real-provider job fixture identified by artifact SHA prefix `95593b1b`.
REASON: The exact job-backed plan is authoritative for Step 10's before/after comparison and is not present in Git history, the handover, or the public job response; exporting it requires authenticated access to the deployed Render data/provider record.


## 2026-09-03 — Artifact trust rebuild
DECISION: Treat semantic generation, deterministic content compilation, rendering, objective validation, and quality telemetry as separate stages.
REASON: The prior pipeline allowed render-capacity mismatches and soft quality heuristics to trigger routine repair loops.

DECISION: Quality warnings never trigger LLM repair. Deterministic BUILD failures are single-attempt; ASSET/provider transient retries are bounded.
REASON: Re-running identical deterministic inputs cannot repair code defects and normalized failure into ordinary operation.

DECISION: Empty-canvas ratio is telemetry only; objectively empty PPTX slides remain hard BUILD failures.
REASON: Whitespace percentage is not equivalent to emptiness or unusability.

DECISION: Compile presentation content into box-capacity-safe slides before serialization and bound atomic activity strings/counts at the schema boundary.
REASON: The renderer must not discover fit failures after the PPTX already exists and must never silently slice accepted semantic content.

DECISION: Build each job in an isolated workspace and move the validated artifact to an immutable unique filename.
REASON: Friendly title-derived filenames could collide across concurrent or historical jobs.

DECISION: Mocked provider tests are labeled as mocked; real-provider acceptance is a separate explicit harness.
REASON: Green fixtures are not evidence that the live model/provider path works.
