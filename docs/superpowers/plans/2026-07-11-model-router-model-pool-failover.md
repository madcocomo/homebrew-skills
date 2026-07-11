# Model Router Model Pool Failover Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Add ordered classifier/weak model pools with 30-minute cross-session cooldown, bounded fallback, automatic Router suspension/recovery, and shared weak fallback for active leases and sub-pi.

**Architecture:** Normalize legacy singleton model identities into ordered arrays, then route every role selection through a shared role-aware candidate selector backed by a redacted persistent health store. Classifier fallback remains bounded by per-attempt and total budgets; weak fallback occurs immediately before lease creation, while generation-time failures affect the next request. When either required role is exhausted, preserve the configured runtime intent but set the effective state to `suspended` until a later request sees an eligible candidate again.

**Tech Stack:** TypeScript Pi extension API, `@earendil-works/pi-ai/compat`, Node.js fs/path APIs, Node.js built-in test runner, tmux

**Repo Scope:** single repo (`/Users/wuke/code/homebrew-skills`) plus user-scoped runtime files under `~/.pi/agent/`

---

## File Structure / Responsibility Map

### Production files

- Modify: `extensions/model-router.ts`
  - normalize model pools and parse `classification.totalTimeoutMs`;
  - implement persistent role/model cooldown storage;
  - select exact configured candidates without discovery;
  - orchestrate classifier, active weak, and sub-pi fallback;
  - model `suspended` and automatic recovery;
  - expose selected/cooling models in status and redacted audit output.

### Test files

- Modify: `tests/model-router.test.mjs`
  - extend fake fs/clock/model registry/classifier/child runner harnesses;
  - add RED/GREEN coverage for config, cooldown, classifier fallback, weak fallback, suspension/recovery, sub-pi, audit/status, and regressions.

### Long-lived docs and examples

- Modify: `docs/examples/model-router.config.json`
  - use ordered arrays;
  - document `classification.totalTimeoutMs`.
- Modify: `docs/pi-model-routing-design.md`
  - replace singleton/no-fallback constraints with the approved ordered-pool, cooldown, and suspended semantics.
- Reference: `docs/superpowers/specs/2026-07-11-model-router-model-pool-failover-design.md`
  - approved source of truth for behavior and acceptance criteria.

### User-scoped runtime configuration

- Modify after all repository tests pass: `~/.pi/agent/model-router.json`
  - apply the approved candidate order and `totalTimeoutMs: 30000`.
- Create at runtime, not manually unless a test fixture requires it: `~/.pi/agent/model-router-health.json`
  - redacted cooldown state with mode `0600`.

### Explicitly out of scope

- Do not add provider discovery, health probes, provider-wide breakers, strong model pools, quality-based cooldown, or a cooldown-reset command.
- Do not modify or commit unrelated existing untracked files:
  - `docs/model-router-classifier-benchmark-corpus.json`
  - `extensions/superpowers-bootstrap.ts`
  - `tests/superpowers-bootstrap.test.mjs`
  - `using-superpowers/`

---

## Execution Notes

- Work from the approved spec and preserve the exact downgrade-only safety semantics.
- Follow TDD for every behavior change: write the focused test, run it and observe the expected failure, then implement the smallest passing change.
- The global extension is symlinked to the repository file. Do not run `/reload` or start a new interactive Pi against partially implemented code.
- Use project-prefixed tmux sessions for test commands. Kill each completed session before reusing its name.
- Suggested test command template:

```bash
SESSION=homebrew-skills-router-gN
LOG=/tmp/${SESSION}.log
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" \
  "cd /Users/wuke/code/homebrew-skills && zsh -c 'source \"$HOME/.zshrc\" && node --test --test-name-pattern=\"PATTERN\" tests/model-router.test.mjs > \"$LOG\" 2>&1; printf \"%s\" \"$?\" > \"$LOG.exit\"'"
# Poll with: tmux has-session -t "$SESSION"
# Verify with: cat "$LOG.exit" && read/inspect "$LOG"
```

- If Node's test-name regex quoting is awkward, put the exact command into a temporary zsh script and launch that script from tmux; do not weaken the verification scope.
- Commit checkpoints should remain atomic and use Conventional Commits.

---

## Gate 0: Establish the baseline and protect unrelated work

**Goal:**
- Confirm the approved design, current test baseline, symlinked deployment shape, and dirty-worktree boundaries before changing production code.

**Files:**
- Reference: `docs/superpowers/specs/2026-07-11-model-router-model-pool-failover-design.md`
- Reference: `extensions/model-router.ts`
- Reference: `tests/model-router.test.mjs`
- Reference: `~/.pi/agent/model-router.json`

**Preconditions / Notes:**
- Existing untracked files belong to other work and must remain untouched.
- Do not edit user config at this gate.
- Do not reload the global extension while implementation is incomplete.

**Verification:**
- Run the full existing Router suite in tmux:
  - `node --test tests/model-router.test.mjs`
- Record pass/fail counts and baseline duration.
- Run:
  - `git status --short`
  - `readlink ~/.pi/agent/extensions/model-router.ts`
  - `python3 -m json.tool ~/.pi/agent/model-router.json >/dev/null`
- Expected: Router tests pass before behavior changes; the global extension points at this repo; user config is valid JSON.

**Continue when:**
- Baseline tests are green and unrelated dirty files are recorded.

**Stop and report when:**
- Existing Router tests fail before implementation.
- The global extension is not the expected symlink and deployment requires a new scope decision.
- User config is invalid before modification.

- [ ] Step 1: Read the approved spec completely and make an acceptance checklist.
- [ ] Step 2: Capture `git status --short` without staging unrelated files.
- [ ] Step 3: Run the full baseline test suite in `homebrew-skills-router-g0` tmux.
- [ ] Step 4: Verify the global extension symlink and current user config syntax.
- [ ] Step 5: Record baseline evidence in the run summary, then proceed automatically.

---

## Gate 1: Normalize singleton/array configuration and add total classifier budget

**Goal:**
- Accept backward-compatible singleton identities and new ordered arrays for classifier/weak.
- Normalize both roles to non-empty arrays and parse `classification.totalTimeoutMs`.

**Files:**
- Modify: `tests/model-router.test.mjs` — config parser and defaults cases around the existing Gate 2 tests.
- Modify: `extensions/model-router.ts` — `ResolvedRouterConfig`, bounds, model parsing, and config parser.

**Preconditions / Notes:**
- Keep `version: 1`.
- Preserve strict unknown-field rejection.
- Default `totalTimeoutMs` to `30000`.
- Do not add cooldown or runtime fallback in this gate.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='config:|defaults|identity|numeric range' tests/model-router.test.mjs`
- Expected after RED: new array/default/duplicate tests fail because the parser only accepts singleton identities and lacks `totalTimeoutMs`.
- Expected after GREEN: targeted config tests pass, including existing singleton cases.

**Continue when:**
- Internal config always exposes `models.classifier[]` and `models.weak[]`.
- Old singleton config produces one-element arrays.
- Empty arrays, duplicate role identities, malformed items and unknown fields are rejected.
- `timeoutMs` and `totalTimeoutMs` have independent validated values.

**Stop and report when:**
- Backward compatibility requires changing `version` or accepting ambiguous mixed shapes.
- Existing strict config guarantees cannot be retained.

- [ ] Step 1: Add tests for singleton normalization, ordered arrays, empty arrays, duplicate `provider/id`, and malformed array entries.
- [ ] Step 2: Add tests for default/explicit/out-of-range `classification.totalTimeoutMs`.
- [ ] Step 3: Run `homebrew-skills-router-g1-red` and confirm expected parser failures.
- [ ] Step 4: Change config types and implement a small `parseModelPool`/normalization helper using the existing strict identity parser.
- [ ] Step 5: Add the explicit numeric bound and default for `totalTimeoutMs`.
- [ ] Step 6: Update existing tests/helpers such as `baseConfig()` to tolerate normalized arrays without hiding singleton compatibility coverage.
- [ ] Step 7: Run `homebrew-skills-router-g1-green` and confirm targeted tests pass.
- [ ] Step 8: Commit an atomic checkpoint, e.g. `feat: support ordered model pools in router config`.

---

## Gate 2: Build the redacted persistent cooldown store

**Goal:**
- Persist 30-minute cooldowns by `role/provider/id`, merge them across processes, and retain in-memory protection when disk access fails.

**Files:**
- Modify: `tests/model-router.test.mjs` — fake fs support, health fixtures, fake clock, parser/merge/write tests.
- Modify: `extensions/model-router.ts` — health types, path helper, parsing, merge/prune, atomic write adapter, and store.

**Preconditions / Notes:**
- Default path: `<agentDir>/model-router-health.json`.
- Cooldown duration is fixed at `1_800_000` ms.
- Extend `RouterFs` minimally for atomic replacement (for example `rename`); update both Node fs and fake fs adapters.
- Keep disk content strictly allowlisted and redacted.
- A damaged health file must not leak content into warnings.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='health|cooldown|retryAfter|redaction' tests/model-router.test.mjs`
- RED must show missing store/merge/cooldown behavior, not fixture syntax errors.
- GREEN must pass all health-store tests.

**Continue when:**
- 29:59 remains cooling and 30:00 is eligible.
- Role and identity isolation are proven.
- Disk and memory merge by the later `retryAfter`.
- A write first re-reads and preserves another process's record.
- Expired records are ignored and pruned on successful writes.
- Corrupt read/write failure emits one rate-limited generic warning and preserves current-process cooldown.
- Temp write + atomic replacement produces mode `0600` in the Node adapter path.

**Stop and report when:**
- Cross-process merging requires an external dependency or OS-specific locking beyond the approved design.
- Atomic replacement cannot be represented cleanly in the injectable fs interface.

- [ ] Step 1: Extend fake fs to model health reads, temp writes, rename, modes, and injected failures.
- [ ] Step 2: Add RED tests for schema validation, role isolation, expiry boundary, merge precedence, concurrent-record preservation, pruning, and failure warning rate limiting.
- [ ] Step 3: Run `homebrew-skills-router-g2-red` and confirm expected failures.
- [ ] Step 4: Add `ModelRole`, `CooldownReason`, `ModelHealthEntry`, and strict health-file parsing types/functions.
- [ ] Step 5: Implement an injectable health store with in-memory state plus read-merge-write behavior.
- [ ] Step 6: Implement Node temp-file creation and atomic replacement with safe permissions.
- [ ] Step 7: Add explicit redaction tests asserting no prompt, response, auth, headers, env, or exception text reaches the file.
- [ ] Step 8: Run `homebrew-skills-router-g2-green` and confirm targeted tests pass.
- [ ] Step 9: Commit an atomic checkpoint, e.g. `feat: persist model router cooldown state`.

---

## Gate 3: Replace singleton readiness with ordered role selection

**Goal:**
- Resolve only configured candidates, skip cooling candidates, cooldown technical resolution failures, and return ordered role availability without discovery.

**Files:**
- Modify: `tests/model-router.test.mjs` — existing model resolver tests plus pool-order, cooldown, auth, image and exhaustion cases.
- Modify: `extensions/model-router.ts` — `RoleReadiness`, `ModelsReadiness`, exact candidate resolver/selector, runtime readiness representation.

**Preconditions / Notes:**
- Do not call provider APIs as health probes.
- Registry lookup and auth readiness are permitted.
- A configured `supportsImages:false` candidate is healthy for text and skipped only for an image request.
- A declaration of `supportsImages:true` that contradicts registry capability is a technical candidate failure and is cooled.
- Remove lifecycle-long readiness assumptions; refresh at request/child boundaries.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='model resolver|candidate|pool|auth|image capability' tests/model-router.test.mjs`
- Expected: exact `find` calls occur in configured order and no registry enumeration/candidate discovery occurs.

**Continue when:**
- The first ready candidate is selected in order.
- Cooling candidates are not looked up/called before expiry.
- `not_found`, `auth_missing`, and declaration mismatch cooldown the candidate and continue.
- Image request selection skips text-only weak without cooling it.
- The selector can report `exhausted`, next retry time, and fixed failure codes.
- Readiness/status objects contain no auth material.

**Stop and report when:**
- The Pi registry cannot safely re-resolve auth at request boundaries.
- Candidate selection would require enumerating unconfigured models.

- [ ] Step 1: Rewrite/add resolver tests around arrays and ordered exact lookup.
- [ ] Step 2: Add RED tests for cooling skip, technical resolution cooldown, image-only skip, and exhaustion metadata.
- [ ] Step 3: Run `homebrew-skills-router-g3-red`.
- [ ] Step 4: Introduce a focused candidate selection API that receives role, pool, registry, health store, current time, and optional image requirement.
- [ ] Step 5: Replace `resolveConfiguredModels()` singleton result with pool readiness/selection semantics while retaining an exported testable boundary.
- [ ] Step 6: Update callers that only need “any weak supports this request” without selecting an unconfigured candidate.
- [ ] Step 7: Run `homebrew-skills-router-g3-green`.
- [ ] Step 8: Commit an atomic checkpoint, e.g. `refactor: select router models from ordered pools`.

---

## Gate 4: Implement bounded classifier fallback

**Goal:**
- Try classifier candidates in order on technical/protocol failure while enforcing per-attempt and total budgets.

**Files:**
- Modify: `tests/model-router.test.mjs` — classifier adapter/harness call tracking, fallback and timing tests.
- Modify: `extensions/model-router.ts` — classifier loop, remaining-budget calculation, failure classification, selected classifier audit state.

**Preconditions / Notes:**
- Use the injected `now()`/clock for deterministic budget tests; if elapsed-time behavior needs monotonic precision, add a narrowly injectable clock rather than using real sleeps.
- The production classifier adapter should continue making exactly one model call per attempt with `maxRetries: 0`.
- A valid classifier result always ends fallback, even when it later combines to strong.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='classifier.*fallback|classifier.*budget|classifier protocol|production classifier' tests/model-router.test.mjs`

**Continue when:**
- The following cool and continue: not found/auth failure, timeout, provider/error stop reason, empty response, invalid strict JSON.
- Valid strong, valid low-confidence weak, and valid risk-flag weak stop fallback without cooling.
- User abort stops the chain without cooling.
- Each attempt gets `min(timeoutMs, remaining totalTimeoutMs)`.
- Total exhaustion does not cool unattempted candidates.
- Classification state records actual classifier identity, attempt count, and fixed codes only.

**Stop and report when:**
- Abort cannot be distinguished from provider/model abort with the available adapter response.
- The timeout API cannot enforce a remaining-budget value without changing Pi core.

- [ ] Step 1: Extend the classifier fake to return/throw per model identity and record per-attempt timeout/signal.
- [ ] Step 2: Add RED tests for ordered fallback across every approved technical/protocol failure.
- [ ] Step 3: Add RED tests proving valid semantic results do not trigger voting/fallback.
- [ ] Step 4: Add RED tests for per-attempt/total budget and unattempted-candidate behavior.
- [ ] Step 5: Run `homebrew-skills-router-g4-red`.
- [ ] Step 6: Refactor `classifyEligible()` into a bounded candidate loop, keeping parsing and route combination unchanged.
- [ ] Step 7: Distinguish user abort from technical failures and write only approved cooldown reasons.
- [ ] Step 8: Thread selected classifier/attempt metadata into redacted runtime state and audit formatting.
- [ ] Step 9: Run `homebrew-skills-router-g4-green`.
- [ ] Step 10: Commit an atomic checkpoint, e.g. `feat: add bounded classifier fallback`.

---

## Gate 5: Implement active weak fallback and generation-failure cooldown

**Goal:**
- Select and switch to the first usable weak candidate, preserve exact lease restoration, and cool generation-time technical failures for future requests.

**Files:**
- Modify: `tests/model-router.test.mjs` — active weak setup, per-model `setModel` results, image cases, lease/error cases.
- Modify: `extensions/model-router.ts` — target selection, weak switch loop, request state, turn-end failure handling.

**Preconditions / Notes:**
- Replace existing tests that assert “no fallback” with the approved fallback behavior; do not merely delete coverage.
- Capture `leaseReturnModel` once from the model active before the first weak attempt.
- `targetModel` must become the identity that actually switched successfully.
- Generation-time weak failure does not switch to another weak in the same agent run.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='active initial|weak fallback|weak lease|weak model error|image request|restore' tests/model-router.test.mjs`

**Continue when:**
- Missing/auth/setModel-failed weak candidates cool and immediately fall through.
- A successful later candidate creates the lease and receives the hidden capsule.
- Image tasks skip text-only weak without cooling.
- No image-capable weak keeps the user model for that request without global suspension if text weak remains healthy.
- Technical `stopReason=error` cools the actual weak and restores the exact return model.
- User abort and all approved quality/effect signals release without cooldown.
- The next request skips the cooled weak.

**Stop and report when:**
- Pi reports user abort and model error identically so the approved cooldown distinction cannot be made.
- Preserving exact return-model restoration conflicts with trying the next weak before the provider request.

- [ ] Step 1: Extend the harness to configure `setModel` outcomes and model errors per identity.
- [ ] Step 2: Add RED tests for first/second/third weak switching, target identity, and cooldown writes.
- [ ] Step 3: Add RED tests for image skip/no-cooldown and no-image-capable conservative behavior.
- [ ] Step 4: Add RED tests for generation error versus abort/quality signals.
- [ ] Step 5: Run `homebrew-skills-router-g5-red`.
- [ ] Step 6: Replace `targetIdentity()` singleton behavior with a weak switch loop that selects candidates at actuation time.
- [ ] Step 7: Store actual selected weak in request/audit state and keep lease return identity/object unchanged.
- [ ] Step 8: Update turn-end technical failure handling to cool the actual weak, release the lease, and defer fallback to the next request.
- [ ] Step 9: Run `homebrew-skills-router-g5-green`.
- [ ] Step 10: Commit an atomic checkpoint, e.g. `feat: fail over active weak model leases`.

---

## Gate 6: Add suspended state and automatic recovery

**Goal:**
- Preserve shadow/active runtime intent while disabling Router side effects when either required role is exhausted, then recover on a later request after cooldown expiry.

**Files:**
- Modify: `tests/model-router.test.mjs` — state machine, command, session, status bar and recovery tests.
- Modify: `extensions/model-router.ts` — runtime state fields, availability gate, suspend/recover helpers, handlers and commands.

**Preconditions / Notes:**
- `runtimeMode` stays `shadow` or `active`; `effectiveState` becomes `suspended`.
- Suspended ordinary requests continue with the user's current model.
- `/routing active` or `/routing shadow` while pools are unavailable should preserve the requested intent and report suspended, not create side effects or discard cooldown.
- `/routing off` must not clear the health file.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='suspended|automatic recovery|/routing|state persistence|status bar' tests/model-router.test.mjs`

**Continue when:**
- Exhausted classifier or weak pool suspends the whole Router.
- Existing lease is restored before suspension.
- During suspension classifier, weak `setModel`, capsule injection and child invocation counts are zero.
- Before expiry, later requests remain no-op.
- At expiry, successful exact resolution restores the original shadow/active effective state and processes that request.
- Failed retry re-cools and remains suspended.
- Session/reload behavior reads persisted cooldown without persisting secrets.

**Stop and report when:**
- Runtime mode persistence cannot distinguish user-requested off from temporary suspension.
- Automatic recovery would require an unsolicited background request or timer.

- [ ] Step 1: Add explicit runtime fields for suspended reason, next retry, and selected model identities in test expectations.
- [ ] Step 2: Add RED state-machine tests for classifier exhaustion, weak exhaustion, no-op suspension, and expiry recovery.
- [ ] Step 3: Add RED command/session tests for active/shadow intent and off-without-clear behavior.
- [ ] Step 4: Run `homebrew-skills-router-g6-red`.
- [ ] Step 5: Implement `suspendRouter()` and request-boundary `tryRecoverRouter()` helpers.
- [ ] Step 6: Gate `before_agent_start` and route-task execution through refreshed role availability.
- [ ] Step 7: Update command behavior, status bar and session reset/restore logic.
- [ ] Step 8: Run `homebrew-skills-router-g6-green`.
- [ ] Step 9: Commit an atomic checkpoint, e.g. `feat: suspend and recover exhausted model router pools`.

---

## Gate 7: Apply weak fallback to sub-pi under one total budget

**Goal:**
- Make `route_task_block` reuse the weak pool/cooldown state, retry only model-technical child failures, and bound the whole chain by `subPi.timeoutMs`.

**Files:**
- Modify: `tests/model-router.test.mjs` — child invocation identity, multi-attempt outcome, total budget, non-retry and suspension cases.
- Modify: `extensions/model-router.ts` — `SubPiInvocation`, production child runner, tool orchestration and pool callbacks.

**Preconditions / Notes:**
- Keep production child runner responsible for one concrete weak attempt; keep pool orchestration at the Router/tool layer so the health store and suspension state remain shared.
- Change the production runner to use `invocation.weakModel`, not `config.models.weak`.
- Pass remaining total timeout explicitly to each attempt.
- Reuse one logical task/capsule; per-attempt tmux/run ids may remain unique.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='subPi|route_task_block|child runner|child.*fallback|child.*timeout' tests/model-router.test.mjs`

**Continue when:**
- Child technical model failures cool and retry the next weak.
- Scope, artifact, verification, generic child process, admission and user abort failures do not retry.
- Each attempt receives the actual selected weak identity.
- The sum of attempts remains within `subPi.timeoutMs` apart from bounded polling/scheduling overhead.
- Weak exhaustion suspends Router and returns a fixed, non-sensitive error.
- Slot acquisition/release remains exactly once for the logical tool invocation.

**Stop and report when:**
- Existing compact child events cannot distinguish model-technical failure from task/process failure.
- Retry would require knowingly ignoring an observed out-of-scope mutation.

- [ ] Step 1: Add RED tests for two-candidate child technical fallback and invocation identities.
- [ ] Step 2: Add RED tests enumerating all non-retry task failure classes.
- [ ] Step 3: Add RED tests for total budget and exhausted-pool suspension.
- [ ] Step 4: Run `homebrew-skills-router-g7-red`.
- [ ] Step 5: Refactor production child runner to execute exactly one invocation-specified weak with an invocation timeout.
- [ ] Step 6: Move fallback orchestration into `registerSubPiTool` through injected/shared candidate-health callbacks.
- [ ] Step 7: Preserve slot cleanup and temporary/tmux cleanup on every attempt.
- [ ] Step 8: Run `homebrew-skills-router-g7-green`.
- [ ] Step 9: Commit an atomic checkpoint, e.g. `feat: fail over sub-pi weak models`.

---

## Gate 8: Complete status, audit and long-lived documentation

**Goal:**
- Make runtime decisions explainable without leaking sensitive payloads, and promote the approved behavior into durable docs/examples.

**Files:**
- Modify: `tests/model-router.test.mjs` — status/audit exact allowlist and redaction assertions.
- Modify: `extensions/model-router.ts` — `/routing status`, status bar and audit metadata.
- Modify: `docs/examples/model-router.config.json` — ordered arrays and total timeout.
- Modify: `docs/pi-model-routing-design.md` — durable architecture/rules update.

**Preconditions / Notes:**
- Remove or rewrite all durable statements that claim classifier/weak are singleton or never fallback.
- Preserve the principle that configured candidates are fixed identities and no discovery occurs.
- Do not include model responses or provider error text in status persisted/audit records.

**Verification:**
- Targeted command in tmux:
  - `node --test --test-name-pattern='status|audit|redaction|cooldown' tests/model-router.test.mjs`
- Validate example JSON:
  - `python3 -m json.tool docs/examples/model-router.config.json >/dev/null`
- Search docs for stale contradictions:
  - `rg -n '单一模型|固定 weak|fixed weak|不会尝试第二个|不尝试 fallback|无 fallback|no fallback' docs/pi-model-routing-design.md docs/examples/model-router.config.json`
- Review every remaining match and either update it or confirm it refers to a still-valid non-goal.

**Continue when:**
- `/routing status` shows ordered pools, selected identities, cooling reason/time, suspended reason/next retry, and both timeout budgets.
- Status bar shows selected weak or suspended retry summary.
- Audit records include selected identities, fallback count and fixed codes only.
- Example and design doc match implementation.

**Stop and report when:**
- Status output would expose raw provider errors or require increasing the approved persisted data surface.
- Updating durable docs reveals a behavior conflict with the approved spec.

- [ ] Step 1: Add RED status/audit tests, including exact allowlists and sensitive-string assertions.
- [ ] Step 2: Run `homebrew-skills-router-g8-red`.
- [ ] Step 3: Implement concise status/reporting and redacted audit fields.
- [ ] Step 4: Run `homebrew-skills-router-g8-green`.
- [ ] Step 5: Update the example config.
- [ ] Step 6: Update the long-lived design document sections covering goals/non-goals, architecture, config, model resolution, classifier, weak lease, sub-pi, commands, failure matrix and acceptance criteria.
- [ ] Step 7: Run JSON validation and stale-constraint searches.
- [ ] Step 8: Commit an atomic checkpoint, e.g. `docs: document model router pool failover`.

---

## Gate 9: Full regression, live config migration and bounded smoke verification

**Goal:**
- Prove the complete repository behavior, then safely update the live user configuration without exposing or overwriting unrelated settings.

**Files:**
- Verify: `extensions/model-router.ts`
- Verify: `tests/model-router.test.mjs`
- Verify: `docs/examples/model-router.config.json`
- Verify: `docs/pi-model-routing-design.md`
- Modify after repository verification: `~/.pi/agent/model-router.json`

**Preconditions / Notes:**
- Do not create or edit `~/.pi/agent/model-router-health.json` merely to manufacture a passing smoke test.
- Preserve all unrelated keys and current mode in the user config.
- Make a timestamped backup of the user config before changing it, with safe permissions.
- Because the extension path is a symlink to the repo, only reload after the final code and config validation is complete.
- Do not make live provider calls as part of the automated unit suite.

**Verification:**

1. Full Router test suite in tmux:
   - `node --test tests/model-router.test.mjs`
2. Related extension suite in tmux:
   - `node --test tests/plan-runner.test.mjs`
3. Static/document checks:
   - `python3 -m json.tool docs/examples/model-router.config.json >/dev/null`
   - `git diff --check`
   - `git status --short`
4. User config after backup/update:
   - `python3 -m json.tool ~/.pi/agent/model-router.json >/dev/null`
   - parse it through the exported Router config parser in a one-off Node test/script and assert normalized pool sizes are classifier=3 and weak=3;
   - assert `classification.totalTimeoutMs === 30000`;
   - assert no API key or secret field was introduced.
5. Optional bounded smoke only after all checks:
   - use `/reload` in a controlled Pi session;
   - run `/routing status` and verify ordered pools/effective state display;
   - do not force a real model failure or clear valid cooldowns.

**Continue when:**
- All test commands exit 0 with zero failures.
- User config parses under the new strict schema and preserves unrelated fields/mode.
- Only approved repository files are modified by this plan.
- Durable docs are updated and no important behavior remains only in the temporary spec/plan.

**Stop and report when:**
- Any full regression test fails after one bounded diagnosis/fix attempt.
- The user config contains an unexpected schema or concurrent change that cannot be merged safely.
- Live reload reports an extension load error.
- Verification would require exposing credentials or forcing destructive provider behavior.

- [ ] Step 1: Run the full Router suite in `homebrew-skills-router-g9-router` tmux and inspect complete output/exit code.
- [ ] Step 2: Run the plan-runner suite in `homebrew-skills-router-g9-plan` tmux and inspect complete output/exit code.
- [ ] Step 3: Run JSON, diff, stale-doc and worktree checks.
- [ ] Step 4: Re-read the approved spec and check all 12 acceptance criteria line by line.
- [ ] Step 5: Back up `~/.pi/agent/model-router.json` with a timestamp and mode `0600`.
- [ ] Step 6: Update only `models.classifier`, `models.weak`, and `classification.totalTimeoutMs` to the approved values.
- [ ] Step 7: Validate the user config through JSON tooling and the production parser; restore the backup immediately if validation fails.
- [ ] Step 8: If safe, perform the bounded `/reload` + `/routing status` smoke; otherwise report why it was skipped.
- [ ] Step 9: Review `git diff` and ensure unrelated untracked files remain untouched.
- [ ] Step 10: Commit remaining repository changes atomically, e.g. `feat: add model router pool failover`.
- [ ] Step 11: Produce a final evidence-based summary with tests, live-config backup path, selected candidate order, and any smoke-test limitation.

---

## Final Acceptance Checklist

- [ ] Legacy singleton classifier/weak config still works.
- [ ] New ordered arrays are strict, non-empty and duplicate-free.
- [ ] Classifier fallback uses only configured identities and obeys per-attempt/total budgets.
- [ ] Weak fallback occurs before lease creation; generation errors affect future requests.
- [ ] Technical failures cool exactly `role/provider/id` for 30 minutes across sessions/processes.
- [ ] User abort, valid classifier outcomes and weak quality signals do not cool models.
- [ ] Image capability behavior is request-local where approved.
- [ ] Both active weak and sub-pi use the shared weak pool.
- [ ] Sub-pi retries only model-technical failures under one total timeout.
- [ ] Exhausted required pools produce `suspended`, not a broken ordinary Pi session.
- [ ] Suspended Router automatically recovers on a later request after expiry.
- [ ] Lease restoration remains exact and downgrade-only routing remains intact.
- [ ] Status/audit/health files remain redacted and explain fallback decisions.
- [ ] Durable design and example docs match implemented behavior.
- [ ] Repository tests pass with fresh evidence.
- [ ] Live user config contains the approved 3 classifier and 3 weak candidates and validates under production parsing.
