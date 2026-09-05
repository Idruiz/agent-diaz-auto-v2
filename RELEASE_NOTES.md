# Agent Díaz 3.3.0

## Rebuild artifact quality around visual evidence

- Replaced the presentation's single repeated template with editorial title, statement, native chart, native table, native diagram, split-photo, and full-bleed-photo layouts. Slide counts, source pages, notes, credits, and pagination now reflect the actual deck.
- Made PowerPoint charts, tables, diagrams, and labels crisp and editable instead of flattening them into fragile raster graphics. Licensed photographs are cropped intentionally, credited, and given alt text.
- Rebuilt document, analysis, and research output with a real cover, first-page treatment, running furniture, fixed-width tables, deliberate figure pagination, accessible image descriptions, and legible source pages.
- Reworked websites as responsive, self-contained editorial bundles with distinct page photography, alternating content layouts, mobile behavior, embedded visualizations, and complete image licensing.
- Repaired Wikimedia retrieval by removing reliance on a missing search-response MIME field, ranking results for subject relevance, rejecting bad/tiny downloads, normalizing assets, retrying throttled requests, and failing visibly when required photography cannot be supplied.
- Raised planning and validation requirements so presentations request at least three distinct photographs and five visuals, documents request visual evidence, vague image searches are rejected, and charts require source notes.
- Added production fonts to the runtime image and switched SVG text to an installed fallback stack, eliminating square-glyph labels in generated charts and diagrams.
- Added package-structure regressions for editable PowerPoint visuals and print-safe Word documents, then rendered and visually inspected representative PPTX and DOCX output plus the portable website bundle.
- Left persona prompts, Javier's style gate, voice generation, and browser playback unchanged.

# Agent Díaz 3.2.8

## Make strict artifact schemas compatible with OpenAI

- Removed the unsupported JSON Schema `uri` string format from the provider-facing artifact contract while preserving strict URL validation in the application before any builder runs.
- Added a recursive Structured Outputs compatibility boundary with an explicit OpenAI-supported format allowlist, preventing nested Zod fields from silently reintroducing unsupported formats.
- Added a regression for the exact production failure path (`sources[].url`) and verified that supported formats remain intact.
- Left persona prompts, Javier's style gate, voice generation, and browser playback unchanged.

# Agent Díaz 3.2.7

## Repair structured artifacts and browser speech playback

- Replaced legacy `json_object` artifact planning with a strict JSON Schema derived from the same Zod contract used to validate finished artifacts; provider-required nullable fields are normalized before the builders run.
- Added a regression that verifies the structure request carries the complete `artifact_plan` schema, not merely a mock JSON response.
- Allowed generated `blob:` audio URLs in the production `media-src` Content Security Policy. The previous default policy caused Chrome to reject otherwise valid WAV data with `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`.
- Extended the production smoke test to fail if the deployed Content Security Policy blocks voice Blob playback.

# Agent Díaz 3.2.6

## Separate artifact routes and make voice playback device-neutral

- Rebuilt every artifact job as two explicit provider phases: tool-enabled evidence gathering first, tool-free JSON structuring second. Web Search or Code Interpreter can no longer be combined with JSON mode in one request.
- Added an always-on provider-contract guard that rejects any future tool-plus-JSON artifact request before it reaches OpenAI.
- Isolated the current artifact prompt and attachments from older failed artifact requests. Previous conversation content remains labeled reference context instead of becoming additional active orders.
- Preserved durable restart and retry behavior across evidence and structure phases with explicit phase progress and provider IDs.
- Switched canonical TTS output from MP3 to validated WAV, including RIFF/WAVE header and MIME checks on both server and browser boundaries.
- Separated generated-speech playback from the WebRTC audio element so a Realtime track cannot overwrite or corrupt TTS playback.
- Replaced hard-coded Android errors with truthful browser/device-neutral diagnostics that report MIME, byte count, and media decoder code without exposing user content.
- Added an end-to-end artifact regression that performs both provider phases and builds a real DOCX, plus exact contract and stale-route contamination tests.

# Agent Díaz 3.2.5

## Restore canonical Javier voice and repair contaminated turns

- Replaced direct Realtime-model answers with one canonical path: Realtime transcribes, the ordinary Responses chat generates and enforces the selected persona, and OpenAI TTS reads that exact final text.
- Javier voice now uses the same 3.2.3 runtime style gate as written chat, preserving the approved irreverent, unhinged-but-coherent, contrarian, subversive Cuban-sailor register and developed diatribes.
- Removed the long transcription hint that could be hallucinated verbatim as user speech and added a hard client guard that refuses to send or save the known leaked instruction.
- Disabled automatic Realtime responses and microphone interruption while Javier generates or speaks, preventing Android from truncating playback after the first sentences.
- Long answers are divided at natural boundaries, synthesized, and played sequentially without dropping or reordering text.
- Added a narrowly targeted startup repair that removes only known 3.2.4 prompt-leak user messages and their paired assistant responses from durable SQLite history.
- Added an executable canonical voice-path regression using the exact input “Qué volá con el bloqueo,” a multi-chunk Javier response, and the captured leaked prompt.

# Agent Díaz 3.2.4

## Android microphone reliability and Javier's old-school Cuban vocabulary

- Replaced semantic turn detection with tuned server VAD so Android speech is committed after a clear pause instead of depending on semantic end-of-turn guesses.
- Added an explicit Send control that manually commits the current microphone buffer and requests Javier's response when automatic turn detection does not fire.
- Added live input transcription deltas, visible Transcribing/Thinking/Speaking states, data-channel readiness checks, microphone mute/end detection, a 30-second turn watchdog, and explicit provider/transcription errors.
- Reconciles asynchronous voice events by `item_id` and persists only complete user/assistant pairs, preventing delayed transcripts from mixing adjacent turns.
- Added safe lifecycle logging without raw microphone audio, API credentials, or transcript contents.
- Added the user's meaning-specific Cuban vocabulary from the 1980s and 1990s: hijadeputá, mariconá (conduct only), me cago en el coño de la madre/de su madre, casa del carajo, casa de la pinga, comepinga, and morronga.
- Added transcription context so Cuban words survive speech recognition instead of being normalized into unrelated Spanish.
- Added regression coverage for out-of-order Realtime events, transcript failures, turn isolation, VAD configuration, and the expanded Javier lexicon.

# Agent Díaz 3.2.3

## Javier style-gate availability fix

- Kept the rewrite gate from suppressing chat when a strong Javier answer missed only the aspirational profanity counter.
- A rewrite that clears the character floor is accepted; if both drafts are weak, the better answer is delivered with explicit degraded-style telemetry instead of a red product failure.

# Agent Díaz 3.2.2

## Javier runtime style gate

- Moved Javier's final output contract after skill, continuity, transcript, and archival context so older polite answers can no longer dominate the active voice.
- Added an executable style inspection for Cuban street register, distributed profanity, profanity variety, colloquial texture, volatility, formal-language leakage, and sanitized list structure.
- Javier chat drafts are now quarantined until they pass; rejected drafts are never streamed to the browser or persisted to shared conversation memory.
- A failed first draft receives one fact-preserving style rewrite. A second sanitized result fails visibly and remains retryable instead of silently impersonating Javier.
- The other five personas keep the original direct streaming path and incur no extra model call.
- Realtime voice now receives Javier's final output contract after the supplied transcript and durable memory.
- Added regression coverage using the exact polite unisex-bathroom response captured from production.

# Agent Díaz 3.2.1

## Javier voice correction

- Rebuilt Javier as a street-educated, street-smart Cuban rebel rather than an academic assistant decorated with occasional slang.
- Made colloquial Cuban Spanish, naturally distributed profanity, flowing diatribes, contrarian judgment, and anti-establishment reasoning part of the enforceable persona contract.
- Explicitly rejects reflexive both-sides framing, corporate neutrality, management jargon, therapy language, tidy point-form answers, and token swear words.
- Keeps factual accuracy and hard safety boundaries, but requires brief in-character warnings or refusals instead of sanitized policy lectures.
- Strengthened both written and OpenAI Realtime prompt tests so Javier's street register reaches chat and voice sessions.

## Agent Díaz 3.2.0

## Persona and voice release

- Added six conversation personas with distinct reasoning and communication behavior: Díaz, Javier, Vega, Mara, Luz, and Salcedo.
- Added durable per-conversation persona selection plus persona snapshots on jobs and assistant messages, so old responses keep their original speaker after a persona switch.
- Added a shared-memory boundary that preserves facts, decisions, preferences, and constraints while excluding persona jokes, profanity, role-play, and exaggeration from autobiographical memory.
- Realtime voice is now assigned on the server by persona: Cedar, Echo, Sage, Ash, Coral, and Marin respectively.
- Spoken delivery instructions make each persona sound distinct; Javier receives Cuban cadence and natural Cuban Spanish code-switching.
- Removed manual voice selection from the client contract, preventing the browser from overriding persona identity.
- Confirmed the application uses OpenAI WebRTC audio only and never browser speech-synthesis voices.
- Changed the Quick/Luna UI wording from `low` to `light` without changing the API reasoning value.
- Added regression coverage for persona contracts, unique voices, server-owned voice selection, prompt injection, SQLite persistence, and persona provenance.
- Replaced reusable credential-shaped test literals with per-run random smoke/test values.

# Agent Díaz 3.1.0

## Conversational production pass

- Ordinary chat now streams directly into the transcript through authenticated SSE; user messages appear immediately and stop/retry are inline.
- Quick, Balanced, and Deep model/reasoning profiles persist per conversation and are recorded on every job.
- Attachments are bound to their visible user message and sent as image or file inputs; spreadsheets automatically enable Code Interpreter.
- Upload preparation, file-reading, provider, interruption, and restart failures remain visible and retryable.
- Voice chat uses WebRTC, short-lived Realtime client secrets, the cost-controlled Realtime model, Marin/Cedar voices, and durable transcript pairs.
- Artifact work remains a durable background pipeline with progress, cancellation, approvals, deterministic builders, and authenticated downloads.
- SQLite, uploads, and artifacts can now live under one `STORAGE_DIR`, enabling a single Render persistent-disk mount.
- The UI is now a responsive modern conversation workspace with a fixed composer and compact artifact/task controls.
- GitHub Actions were removed; verified releases are deployed manually.

## Revival baseline

This release replaces every earlier Agent Díaz Revived archive.

## Corrected since 2.3

- Website pages now embed their CSS and photographs directly and include `OPEN_ME_FIRST.html`.
- Wikimedia search/download uses bounded exponential retry and paced sequential requests.
- Presentation and document builders now consume licensed-photo requests instead of ignoring them.
- Website planning enforces three to six pages, complete section assignment, and documentary photo briefs.
- Artifact plans remain internal; the chat transcript receives a human-readable completion result instead of raw builder JSON.
- MCP is reachable from the chat skill when configured.
- MCP approval requests are captured, shown, persisted, approved or rejected, and continued through `previous_response_id`.
- MCP credentials and tool configuration are re-sent during approval continuation as required by the API contract.
- Multiple approval requests from one response are collected before continuation.
- Concurrent jobs in the same conversation are rejected to protect message order.
- Conversations with active jobs cannot be archived.
- External Google Fonts were removed; the secured UI has no remote font dependency.
- Docker, Compose, GitHub Actions, runtime health checks, and an exact deployment guide were added.
- OpenAI SDK updated to 7.x and the main model default changed to the stable `gpt-5.6` alias.

## Verified locally

- TypeScript check.
- Eleven automated tests covering contracts, contained paths, builders, conversation lifecycle, portable website packaging, and approval persistence.
- Production Vite and server bundle.
- Authenticated runtime health/login/skills smoke test.
- Production dependency audit with zero reported vulnerabilities.
- Release ZIP integrity and secret/build-output exclusions.

## Requires deployment credentials to verify

- Live OpenAI generation and account-specific model/tool access.
- Live Code Interpreter execution against your uploaded files.
- Live web-search results and citations.
- The exact remote MCP server, authorization token, tool schemas, and external action receipts.
- Docker image build on a host with Docker installed.

These are deployment integration checks, not simulated successes. Follow the README and test a harmless read followed by a harmless approved write before trusting a configured MCP server with consequential actions.
