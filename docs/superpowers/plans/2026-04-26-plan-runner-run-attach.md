# Plan Runner Run-Attach Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Add a `/run-attach` command to `plan-runner` so a session with no bound plan can attach to an existing run from the current project and then use the rest of the run commands against that run.

**Architecture:** Extend `extensions/plan-runner.ts` with attach-oriented helper types and functions that discover runs only under the current project’s `.pi/runs`, reconstruct `RunState` from a new persisted `run.json` file or fall back to legacy artifacts, and resolve a user query to one concrete run instance. Reuse the existing `activeRun`, `persistState`, `refreshStatus`, and poller flow so `/run-attach` becomes a thin orchestration command over tested helpers.

**Tech Stack:** TypeScript extension code, Node.js fs/path APIs, `node:test`, temporary filesystem fixtures.

**Repo Scope:** single repo (`/Users/wuke/code/homebrew-skills`)

---

## File Structure / Responsibility Map

### Production files
- Modify: `extensions/plan-runner.ts` — add run metadata persistence, run discovery / hydration helpers, query resolution, candidate formatting, and the `/run-attach` command.

### Test files
- Modify: `tests/plan-runner.test.mjs` — add failing tests first for run discovery, legacy fallback, attach query resolution, command registration, and attach orchestration.

### Docs / config
- Create: `docs/superpowers/specs/2026-04-26-plan-runner-run-attach-design.md` — approved design for the feature.
- Create: `docs/superpowers/plans/2026-04-26-plan-runner-run-attach.md` — this implementation plan.
- Leave unchanged unless naturally justified: `README.md` — the repo README is not a detailed command inventory today.

## Implementation Notes / Constraints

- Follow TDD strictly: no production behavior change before a failing test exists.
- Keep the change local to `extensions/plan-runner.ts` and `tests/plan-runner.test.mjs`.
- `/run-attach` must only consider runs under the current project root returned by `findProjectRoot(ctx.cwd)`.
- New runs must persist enough metadata to reconstruct full `RunState`; legacy runs must still attach through best-effort hydration.
- Legacy hydration should prefer existing on-disk artifacts in this order: `status.json`, `summary.md`, `README.txt`.
- A single broken run directory must not prevent other runs from being listed.
- Non-UI attach flows should never become interactive; if selection is required, print choices and stop.
- Keep helper functions deterministic and export the minimum useful surface for tests.

## Gate 1: Lock run discovery and hydration behind failing tests

**Goal:**
- Define how attachable runs are discovered under the current project and how `RunState` is reconstructed from modern or legacy artifacts.
- Prove that attach only sees runs from the current project and that legacy fallback works before wiring any command behavior.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Introduce a persisted metadata file name for new runs, e.g. `run.json`.
- Export only small helper surfaces, such as discovery / hydration helpers and candidate formatting / scoring helpers, if that keeps tests simple.
- Recommended helper responsibilities:
  - build the path to a persisted run metadata file
  - read a modern `run.json`
  - hydrate a legacy run from `status.json` / `summary.md` / `README.txt`
  - enumerate attachable runs under `<projectRoot>/.pi/runs`

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected before implementation: new tests fail because helpers / persistence do not exist yet.
- Expected after implementation: all tests pass.

**Continue when:**
- Run discovery is limited to the current project root.
- New-run hydration reads the persisted metadata file.
- Legacy hydration reconstructs a usable `RunState` without crashing on missing optional fields.

**Stop and report when:**
- Existing run artifacts are too inconsistent to support safe legacy hydration.
- Supporting legacy runs would require changing historical on-disk data outside the current project.

- [ ] Step 1: Add failing tests in `tests/plan-runner.test.mjs` for:
  - discovering runs only from the current project `.pi/runs`
  - preferring `run.json` when present
  - reconstructing a legacy run from `status.json` / `summary.md` / `README.txt`
  - skipping one malformed run while keeping other candidates available
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new tests fail for the expected reason.
- [ ] Step 3: Implement the minimum helper logic in `extensions/plan-runner.ts` and persist `run.json` during `/run-plan` setup.
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm all tests are green.
- [ ] Step 5: Keep the helper API small and avoid unrelated refactors.

## Gate 2: Lock query resolution and candidate formatting behind failing tests

**Goal:**
- Define how `/run-attach <query>` resolves one concrete run instance from the current project’s candidates.
- Cover unique matches, ambiguous matches, and non-UI fallback behavior.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Match against run-instance identifiers, not plans in the abstract.
- Support at least these query sources:
  - `runId`
  - plan relative path
  - plan basename
  - basename without extension
- If multiple runs match, UI mode may select; non-UI mode must report choices and stop.
- Candidate labels should expose `runId / state / startedAt / plan / branch` in a stable, testable format.

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: PASS for query resolution and candidate label tests.

**Continue when:**
- Unique matches resolve directly.
- Ambiguous matches surface a deterministic choice path.
- Candidate labels are readable and stable.

**Stop and report when:**
- The approved matching modes are not sufficient to identify runs in realistic histories.
- Additional user-facing filters are needed beyond the approved scope.

- [ ] Step 1: Add failing tests in `tests/plan-runner.test.mjs` for:
  - exact `runId` match
  - plan-path / basename match
  - ambiguous matches producing a selection requirement
  - candidate label formatting and ordering
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new tests fail.
- [ ] Step 3: Implement the smallest run-query scoring / selection helpers in `extensions/plan-runner.ts`.
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm the new tests pass.
- [ ] Step 5: Ensure ordering prefers newest runs first.

## Gate 3: Wire `/run-attach` into the extension command surface with failing tests first

**Goal:**
- Register `/run-attach` and connect it to the tested discovery / hydration / query helpers.
- Confirm that attaching updates `activeRun`, persists it to the session, refreshes status, and allows subsequent commands to operate on the attached run.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Reuse existing `persistState`, `refreshStatus`, and `startPoller` logic instead of inventing a second state path.
- If the requested run is already attached, notify and avoid noisy work.
- Rebinding to a different run in the same session is allowed.
- In no-UI mode with no args, print the available candidates and stop.
- In UI mode with no args, use a selection prompt.

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: PASS for command registration and attach orchestration tests.

**Continue when:**
- `/run-attach` is registered.
- Attaching writes the chosen run into session state.
- Subsequent `run-status` / `run-summary` use the attached run.

**Stop and report when:**
- The extension UI API cannot support the approved selection flow.
- Reusing current status-refresh logic would require refactoring unrelated lifecycle code.

- [ ] Step 1: Add failing tests in `tests/plan-runner.test.mjs` for:
  - `/run-attach` registration
  - no-UI listing output when no args are provided
  - unique query attach updating session state
  - UI selection path for ambiguous matches or no-arg attach
  - attaching then invoking `/run-summary` against the attached run
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new command tests fail.
- [ ] Step 3: Implement `/run-attach` in `extensions/plan-runner.ts` using the tested helpers.
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm all tests pass.
- [ ] Step 5: Review `git diff -- extensions/plan-runner.ts tests/plan-runner.test.mjs docs/superpowers/specs/2026-04-26-plan-runner-run-attach-design.md docs/superpowers/plans/2026-04-26-plan-runner-run-attach.md` to ensure the change stays scoped.

## Gate 4: Promote durable docs only if the repo has a natural command inventory

**Goal:**
- Decide whether any durable doc update beyond the working spec/plan is necessary.

**Files:**
- Review only: `README.md`

**Preconditions / Notes:**
- This repo README is a repository-purpose document, not a detailed extension command manual.
- Do not force a README command section just for `/run-attach`.
- If no durable doc promotion is needed, record that explicitly in the final report.

**Verification:**
- Run: `git diff -- README.md`
- Expected: no diff unless a very small, clearly justified note is added.

**Continue when:**
- Either a minimal durable doc change is made in the natural home, or the executor records why none was needed.

**Stop and report when:**
- A better long-term docs home exists but is outside the approved scope and needs user direction.

- [ ] Step 1: Review whether `README.md` is the right place for a `/run-attach` note.
- [ ] Step 2: If not, leave it unchanged and document the rationale in the final summary.

## Final Verification Checklist

Before claiming the feature is complete:

- [ ] `node --test tests/plan-runner.test.mjs` passes cleanly.
- [ ] `/run-attach` is registered in `extensions/plan-runner.ts`.
- [ ] New runs persist a `run.json`-style metadata file under `.pi/runs/<runId>/`.
- [ ] Legacy runs without `run.json` can still be attached using best-effort hydration.
- [ ] Attach discovery only reads runs from the current project root.
- [ ] No-UI ambiguous attach paths print choices and stop rather than guessing.
- [ ] UI no-arg attach can list and select an existing run.
- [ ] Attaching updates the session’s `activeRun` and existing run commands work against it.
- [ ] README remains unchanged unless a tiny, justified durable-doc update is natural.
