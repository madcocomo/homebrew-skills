# Continuation Model Routing Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Route every eligible tool continuation independently between the exact user-selected model and the configured weak pool, using bounded redacted tool-result evidence.

**Architecture:** Keep the router as a Pi extension and classify at `turn_end` before Pi prepares the next provider request. Capture one exact user model per agent run, replace legacy strong terminology with `user`, add classifier protocol v2, and make continuation decisions independent from initial admission while preserving deterministic hard-user gates.

**Tech Stack:** TypeScript Pi extension, Node.js test runner, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai/compat`, JSON configuration and JSONL audit logs.

**Repo Scope:** Single repo: `/Users/wuke/code/homebrew-skills`.

**Approved spec:** `docs/superpowers/specs/2026-07-12-continuation-model-routing-design.md`

---

## File Structure / Responsibility Map

### Production files

- Modify: `extensions/model-router.ts` — config parsing, classifier v2 protocol, continuation evidence/redaction, request state, hard-user gate, model transitions, audit schema, and shadow review compatibility.

### Test files

- Modify: `tests/model-router.test.mjs` — failing tests and regressions for protocol v2, continuation classification, privacy budgets, bidirectional transitions, failure recovery, shadow behavior, and legacy compatibility.

### Durable docs and examples

- Modify: `docs/pi-model-routing-design.md` — promote provider-request routing, accurate user/weak terminology, continuation evidence, failure semantics, and schema v2.
- Modify: `docs/examples/model-router.config.json` — document the optional `maxContinuationResultChars` setting.

### Working artifacts

- Existing: `docs/superpowers/specs/2026-07-12-continuation-model-routing-design.md` — approved design source; do not rewrite implementation status into this file.
- This plan: `docs/superpowers/plans/2026-07-12-continuation-model-routing.md`.

## General Constraints

- Do not modify Pi core.
- Do not introduce a configured strong model or any third-model fallback.
- Preserve config `version: 1`; only add an optional classification field.
- Use the exact model object captured at `before_agent_start` as the agent-run restoration target.
- Shadow mode must never call `pi.setModel()`.
- Never persist classifier excerpts, prompts, assistant text, secrets, auth, headers, or environment values.
- Follow red-green-refactor: each production behavior starts with a test that fails for the expected missing behavior.
- Keep unrelated dirty/untracked repository files out of every commit.

---

### Gate 1: Establish protocol-v2 and configuration contracts

**Goal:**

- Replace classifier output terminology `strong` with `user`.
- Add decision kind to classifier input.
- Add the optional continuation-result budget without breaking old configs.

**Files:**

- Modify: `tests/model-router.test.mjs` — config and classifier protocol sections near existing strict parsing tests.
- Modify: `extensions/model-router.ts` — `ResolvedRouterConfig`, config parser, classifier system prompt, classifier input/result types, parser, and route combination.

**Preconditions / Notes:**

- Config schema remains version 1.
- Classifier protocol becomes version 2 and accepts only `route: "user" | "weak"`.
- Default `classification.maxContinuationResultChars` is 6000.
- Select an explicit bounded integer range and require it not to exceed the overall classifier input budget, or clamp only if the approved strict-schema conventions already use clamping. Prefer strict validation consistent with existing parsing.

**Verification:**

- Run: `node --test --test-name-pattern='config|classifier protocol|route decision' tests/model-router.test.mjs`
- Expected: targeted tests pass with protocol v2, legacy config defaults, and strict invalid-value rejection.

**Continue when:**

- Existing single-object/pool config tests remain green.
- No production code or test expects classifier route `strong` except explicit legacy-audit fixtures.

**Stop and report when:**

- Pi's classifier adapter or test harness requires a public protocol compatibility mode not covered by the approved spec.
- Supporting protocol v2 would require Pi core changes.

- [ ] Write failing tests for legacy config defaulting `maxContinuationResultChars` to 6000.
- [ ] Write failing tests for explicit valid/invalid continuation budgets.
- [ ] Write failing tests that require protocol version 2 and `user|weak` routes.
- [ ] Run the targeted tests and confirm failures are due to current version-1/strong behavior.
- [ ] Implement the minimal config and classifier protocol changes.
- [ ] Run the targeted tests to green.
- [ ] Remove stale strong-model terminology from production types and comments without changing continuation behavior yet.

---

### Gate 2: Build bounded and redacted continuation evidence

**Goal:**

- Produce classifier-safe continuation input containing useful tool-result excerpts without leaking them into logs.

**Files:**

- Modify: `tests/model-router.test.mjs` — add pure-function and adapter tests near classifier input/audit-redaction coverage.
- Modify: `extensions/model-router.ts` — add small pure helpers for secret redaction, fair excerpt budgeting, input summaries, and final serialized-size enforcement.

**Preconditions / Notes:**

- Maximum one tool-result excerpt is 2000 characters.
- Aggregate result excerpts obey `maxContinuationResultChars`.
- Final serialized input obeys `maxInputChars`.
- Preserve structured metadata before excerpt prose when trimming.
- Redact Authorization/Bearer tokens, common key/secret assignments, PEM private keys, cloud credentials, and suspicious high-entropy long strings.
- Helpers should be independently testable and should not retain raw values.

**Verification:**

- Run: `node --test --test-name-pattern='continuation input|excerpt|redact|audit redaction' tests/model-router.test.mjs`
- Expected: all targeted evidence and privacy tests pass.

**Continue when:**

- Tests prove both per-result and aggregate limits.
- A marker present in raw tool output is absent from audit JSONL and formatted records.
- Serialized classifier input length is bounded.

**Stop and report when:**

- Useful continuation evidence cannot fit under the configured minimum input budget.
- Meeting the privacy contract would require storing or logging raw classifier input.

- [ ] Write a failing test that expects bounded tool-result excerpts in a continuation classifier request.
- [ ] Write failing tests for per-tool, aggregate, and final serialized input limits.
- [ ] Write failing tests for each approved secret family and a high-entropy marker.
- [ ] Write a failing audit test proving excerpts and secret markers never reach JSONL.
- [ ] Run targeted tests and confirm expected failures.
- [ ] Implement minimal pure redaction and budgeting helpers.
- [ ] Build `ClassifierInputV2` for initial and continuation decisions.
- [ ] Run targeted tests to green, then refactor helper names/structure while staying green.

---

### Gate 3: Capture the exact user model and implement independent continuation decisions

**Goal:**

- Reclassify every eligible tool continuation and support `user → weak → user → weak` before successive provider requests.

**Files:**

- Modify: `tests/model-router.test.mjs` — replace the current "continuation must not re-classify" expectations and add transition-order tests.
- Modify: `extensions/model-router.ts` — `RequestState`, `onBeforeAgentStart`, `onTurnEnd`, classifier invocation, target identity, and lease restoration.

**Preconditions / Notes:**

- Capture `requestUserModel` once before any initial downgrade.
- Do not update it from later model changes.
- Initial scope ambiguity must not suppress continuation classification.
- A tool batch is classified only when Pi will make an automatic continuation; no-tool completion remains unclassified.
- Avoid redundant `setModel()` when already on the selected exact model.
- `turn_end` awaits model switching before Pi's next-turn snapshot.

**Verification:**

- Run: `node --test --test-name-pattern='continuation|user model|weak lease|active initial' tests/model-router.test.mjs`
- Expected: independent classifications occur and setModel sequence matches user/weak/user/weak before marked provider requests.

**Continue when:**

- A successful tool batch after initial user routing invokes the classifier.
- Missing initial capsule does not block that invocation.
- Restoration assertions compare the exact captured model object, not only provider/id.
- No-tool completion makes no classifier call.

**Stop and report when:**

- Actual Pi event ordering contradicts the documented awaited `turn_end` and next-turn refresh behavior.
- Correctness would require request-scoped model support in Pi core.

- [ ] Replace the old passing test that forbids continuation classification with a failing test requiring it.
- [ ] Add a failing test for initial natural-language/scope-ambiguous prompt followed by an eligible continuation.
- [ ] Add failing tests for exact user-model capture and user/weak/user/weak switching.
- [ ] Add a failing test that no-op decisions do not repeat `setModel()`.
- [ ] Run targeted tests and confirm failures reflect the sticky initial implementation.
- [ ] Implement independent continuation classifier invocation.
- [ ] Implement route application against the exact user model and selected weak model.
- [ ] Run targeted tests to green.

---

### Gate 4: Apply boundary-scoped hard-user signals and conservative recovery

**Goal:**

- Skip semantic classification only when current execution evidence proves the next request should use the user model, and recover conservatively on failures.

**Files:**

- Modify: `tests/model-router.test.mjs` — effect evaluator, context-window, classifier failure, weak pool, provider error, abort, and agent lifecycle tests.
- Modify: `extensions/model-router.ts` — continuation safety gate, signal lifecycle, progress reset, context compatibility check, classifier/weak failure handling, agent-end restoration.

**Preconditions / Notes:**

- Current tool errors, nonzero exits, verification failures, sensitive operations, and actual-model mismatch affect the immediate boundary rather than permanently disabling later downgrade.
- Repeated/no-progress counters persist only until observable progress resets them.
- Confirmed scope drift requires a valid capsule; absent capsule is classifier uncertainty.
- Use weak model `contextWindow` plus a conservative output/reserve allowance before switching.
- Classifier failure on weak restores user; classifier failure on user is a no-op.
- User-model provider errors never trigger an alternate model.

**Verification:**

- Run: `node --test --test-name-pattern='effect|scope|progress|context|classifier failure|pool|provider error|abort|agent end' tests/model-router.test.mjs`
- Expected: hard-user boundaries skip classifier, later safe boundaries re-enable it, and all recovery paths end on the exact user model.

**Continue when:**

- A tool-error boundary restores user without a classifier call.
- A subsequent safe batch can classify weak again.
- Weak context incompatibility prevents downgrade.
- Weak/classifier failures never select an unconfigured non-user model.

**Stop and report when:**

- Context usage or model context-window metadata is unavailable in the installed Pi API and no conservative local estimate exists.
- Existing suspended-state semantics conflict with continuing the ordinary run on the user model.

- [ ] Write failing tests for boundary-scoped tool/verification failure.
- [ ] Write a failing test for re-enabling classification after a later successful batch.
- [ ] Write failing tests for scope uncertainty versus confirmed drift.
- [ ] Write a failing weak-context-window test.
- [ ] Write failing classifier-failure tests for current user and current weak states.
- [ ] Write failing lifecycle tests for abort, weak provider error, agent end, and next prompt.
- [ ] Implement the minimal safety gate and signal reset behavior.
- [ ] Implement conservative failure and lifecycle restoration.
- [ ] Run targeted tests to green.

---

### Gate 5: Make shadow and audit records represent each continuation

**Goal:**

- Emit schema-version-2 per-boundary decisions while preserving zero switching in shadow and legacy review support.

**Files:**

- Modify: `tests/model-router.test.mjs` — audit formatting, full shadow lifecycle, shadow-review fixtures, and legacy schema compatibility.
- Modify: `extensions/model-router.ts` — audit record types/formatter, `onTurnEnd` logging, shadow behavior, and `/routing shadow-review` aggregation.

**Preconditions / Notes:**

- Every continuation record uses its own classification.
- Record only excerpt lengths and truncation flags, never excerpt text.
- Legacy schema-1 `strong` is interpreted only in review code as `user/no-downgrade`.
- Historical files are not rewritten.

**Verification:**

- Run: `node --test --test-name-pattern='audit|shadow|review|legacy|schema' tests/model-router.test.mjs`
- Expected: schema 2 records are independent, shadow makes zero setModel calls, and mixed legacy/new logs review correctly.

**Continue when:**

- Shadow classifier call count equals initial eligible calls plus eligible continuation boundaries.
- Continuation records differ when classifier results differ.
- Secret and excerpt markers are absent from raw JSONL.

**Stop and report when:**

- Existing external audit tooling requires schema-1 output and cannot consume a versioned schema.

- [ ] Write a failing schema-2 continuation audit test.
- [ ] Write a failing shadow test requiring fresh classification per continuation and zero switching.
- [ ] Write failing mixed-schema review fixtures.
- [ ] Run targeted tests and confirm expected failures.
- [ ] Implement schema-2 formatting and independent continuation logging.
- [ ] Add legacy/new normalization in shadow review.
- [ ] Run targeted tests to green.

---

### Gate 6: Full regression and production-path verification

**Goal:**

- Verify the integrated extension, production classifier adapter, config parser, pools, sub-pi behavior, and lifecycle remain correct.

**Files:**

- Modify only as required by failures already within approved scope:
  - `extensions/model-router.ts`
  - `tests/model-router.test.mjs`

**Preconditions / Notes:**

- Do not weaken assertions merely to preserve old sticky behavior.
- Sub-pi remains a weak-pool consumer but does not adopt continuation classifier semantics.
- Keep unrelated test failures separate from this change.

**Verification:**

- Run: `node --test tests/model-router.test.mjs`
- Expected: all model-router tests pass with no warnings or leaked markers.
- Run: `git diff --check`
- Expected: no whitespace errors.

**Continue when:**

- Full model-router suite passes twice consistently.
- No test or production comment uses strong as a current configured route, except explicit legacy compatibility text.

**Stop and report when:**

- More than one bounded implementation correction is needed for an unrelated subsystem.
- A regression requires changing Pi core, plan-runner, or unrelated extensions.

- [ ] Run the complete suite and record the first integrated result.
- [ ] Fix only failures caused by the approved routing change.
- [ ] Re-run the complete suite to green.
- [ ] Search current code/tests for stale strong/upgrade semantics and remove non-legacy occurrences.
- [ ] Run the suite once more and run `git diff --check`.

---

### Gate 7: Promote durable architecture and update examples

**Goal:**

- Make the long-lived design document and example configuration accurately describe the implemented behavior.

**Files:**

- Modify: `docs/pi-model-routing-design.md` — provider-request state machine, user/weak terminology, protocol v2, evidence/redaction, failure matrix, shadow semantics, and trade-offs.
- Modify: `docs/examples/model-router.config.json` — optional `maxContinuationResultChars` example.
- Verify: `docs/superpowers/specs/2026-07-12-continuation-model-routing-design.md` — ensure implementation matches approved design; do not add transient status.

**Preconditions / Notes:**

- The durable document replaces obsolete initial-sticky descriptions.
- Explicitly state that heuristic redaction is bounded-risk, not an absolute secrecy guarantee.
- Document classifier latency, provider cache, and model-switch persistence trade-offs.

**Verification:**

- Run: `rg -n 'strong model|strong-sticky|fixed strong|upgrade to strong|route.:.strong' extensions/model-router.ts tests/model-router.test.mjs docs/pi-model-routing-design.md docs/examples/model-router.config.json`
- Expected: only clearly labeled schema-1 legacy compatibility references remain.
- Run: `node --test tests/model-router.test.mjs`
- Expected: full suite passes after documentation/example changes.
- Run: `git diff --check`
- Expected: clean.

**Continue when:**

- Docs, example, tests, and production behavior use the same terminology and defaults.

**Stop and report when:**

- Documentation reveals an implementation behavior that contradicts the approved spec rather than a wording issue.

- [ ] Update the durable architecture document.
- [ ] Update the example configuration.
- [ ] Run stale-terminology search and classify every remaining hit as legacy or defect.
- [ ] Run final tests and whitespace verification.
- [ ] Review the final diff for unrelated files and sensitive test fixtures.
- [ ] Commit implementation and durable documentation atomically or in focused conventional commits on the task branch.

## Final Acceptance Criteria

- Every eligible tool continuation has an independent classifier decision.
- Initial user routing does not make the agent run sticky.
- Active mode supports user/weak/user/weak transitions without a third model.
- All restoration paths use the exact agent-run user model object.
- Current-boundary failures route user but do not permanently suppress later classification.
- Classifier v2 receives bounded redacted evidence and audit logs receive none of its text.
- Shadow mode records independent continuation recommendations and never switches models.
- Config version 1 remains backward compatible.
- Mixed schema-1/schema-2 audit review works.
- `node --test tests/model-router.test.mjs` passes.
- `git diff --check` passes.

## Global Stop Conditions

Stop and report instead of expanding scope when:

- Pi core must change;
- an additional repository is required;
- the exact user model cannot be restored with the installed extension API;
- provider-request ordering differs from the verified awaited `turn_end` lifecycle;
- privacy requirements require transmitting or persisting unbounded raw tool output;
- an external compatibility decision is needed for audit schema consumers;
- unrelated dirty files would need modification or inclusion.
