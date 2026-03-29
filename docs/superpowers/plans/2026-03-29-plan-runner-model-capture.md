# Plan Runner Model Capture Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Make `plan-runner` use the model and thinking level active in the invoking pi session, record them in run artifacts, and show them in the run status bar.

**Architecture:** Capture `ctx.model` and `pi.getThinkingLevel()` at `/run-plan` invocation time and store them in `RunState`. Pass the captured values explicitly to the child `pi` process via CLI flags, and surface the same values in status/summary artifacts plus the status bar so each run has a fixed, auditable execution model.

**Tech Stack:** TypeScript, pi extension API, tmux, Node.js fs/path APIs

**Repo Scope:** single repo (`/Users/wuke/code/homebrew-skills`)

---

## File Structure / Responsibility Map

### Production files
- Modify: `extensions/plan-runner.ts` — capture invoking session model/thinking, pass them to child `pi`, and record/display them across run state and status UI.

### Test files
- No existing automated test harness detected in repository root. Use bounded code-level verification via targeted inspection and TypeScript/static sanity if available; otherwise rely on deterministic artifact checks from generated strings/data.

### Docs / config
- Reference only: `docs/superpowers/specs/2026-03-29-plan-runner-model-capture-design.md` — approved design for this change.
- Create/modify no additional long-lived docs unless implementation reveals durable behavior worth documenting beyond the spec.

## Gate 1: Capture and persist run model configuration

**Goal:**
- Extend plan-runner state so each run stores the invoking session's exact `provider/id` model and thinking level.

**Files:**
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Read the approved spec before editing.
- Keep changes minimal and local to `plan-runner`.
- If `ctx.model` is unavailable in the `/run-plan` command context, fail fast with a clear user-facing error instead of falling back silently.

**Verification:**
- Inspect the updated `RunState` and `StatusData` types in `extensions/plan-runner.ts`.
- Confirm the `/run-plan` handler now reads `ctx.model` and `pi.getThinkingLevel()` before creating `run`.
- Expected: the code constructs a stable display token like `provider/id:thinking` and stores it on the run.

**Continue when:**
- `RunState` includes the captured model/thinking fields.
- `/run-plan` refuses to start without a current model.

**Stop and report when:**
- Capturing the current model requires API behavior not available from `ctx.model` / `pi.getThinkingLevel()`.
- The extension API exposes ambiguous model semantics that conflict with the approved design.

- [ ] Step 1: Add or update a small helper to format the fixed run model display string.
- [ ] Step 2: Extend `RunState` and `StatusData` with model/thinking fields.
- [ ] Step 3: Update `/run-plan` to capture `ctx.model` and `pi.getThinkingLevel()` before creating `run`.
- [ ] Step 4: Add a fail-fast check when `ctx.model` is missing.
- [ ] Step 5: Re-read the edited block and confirm the captured fields are threaded into the new `run` object.

### Gate 2: Use the captured configuration to launch the child pi and seed artifacts

**Goal:**
- Ensure the child `pi` process always runs with the captured model/thinking.
- Seed initial run artifacts with the same data for auditability.

**Files:**
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Reuse existing shell quoting helpers.
- Keep artifact format backward-tolerant so missing fields in old runs do not break reads.

**Verification:**
- Inspect `buildRunScript()` and confirm it includes `--model <provider/id>` and `--thinking <level>`.
- Inspect initial status/summary/README generation and confirm model/thinking are written.
- Expected: a newly generated run script and initial artifact data all reflect the same fixed model display.

**Continue when:**
- The child process command line explicitly pins model and thinking.
- `status.json`, `summary.md`, and `README.txt` all include model information for new runs.

**Stop and report when:**
- Passing `--model` / `--thinking` to child `pi` conflicts with documented CLI behavior.
- Artifact updates require broader format migration beyond the approved scope.

- [ ] Step 1: Update `buildRunScript()` to pass the captured model/thinking flags.
- [ ] Step 2: Update `writeInitialArtifacts()` to include model fields in the initial `status.json`.
- [ ] Step 3: Update the initial summary template to include the fixed model display.
- [ ] Step 4: Update the run `README.txt` writer to include the same model/thinking details.
- [ ] Step 5: Re-read all touched templates to ensure they use the same formatting consistently.

### Gate 3: Show the fixed model in status surfaces and verify end-to-end behavior

**Goal:**
- Surface the fixed run model in the live status bar and summary/status notifications.
- Verify the implementation with bounded checks before claiming completion.

**Files:**
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Preserve tolerance for old runs whose saved status lacks model fields.
- Keep status labels concise but exact: `provider/id:thinking`.

**Verification:**
- Inspect the status label formatting path and confirm it appends the fixed model display when present.
- Run a TypeScript/static sanity check if tooling is available; otherwise use targeted grep/inspection to verify the new fields appear in all required call sites.
- Suggested commands:
  - `rg -n "modelDisplay|thinkingLevel|modelProvider|modelId" extensions/plan-runner.ts`
  - `git diff -- extensions/plan-runner.ts`
- Expected: every run surface (live status + artifacts) references the fixed captured model, and no unrelated files are modified.

**Continue when:**
- Status labels include `provider/id:thinking` for new runs.
- The code remains backward-tolerant for old artifact files.
- Verification output matches the approved scope.

**Stop and report when:**
- Status rendering becomes unreadable enough to require a product decision.
- Verification reveals additional plan-runner defects outside this approved change.

- [ ] Step 1: Update status label formatting to append the run model display.
- [ ] Step 2: Make status refresh prefer run-captured model info, with fallback tolerance for older runs/status files.
- [ ] Step 3: Run the targeted verification commands and inspect output.
- [ ] Step 4: If verification is clean, prepare a concise summary of changed behavior and files.

### Gate 4: Documentation promotion check

**Goal:**
- Decide whether any durable project documentation outside `docs/superpowers/...` needs updating.

**Files:**
- Review existing long-lived docs if relevant; modify only if the change introduces durable contributor-facing behavior worth keeping.

**Preconditions / Notes:**
- The approved spec already captures the task-level design.
- Do not duplicate transient run details into long-lived docs unless clearly valuable.

**Verification:**
- Confirm whether a durable doc update is necessary.
- Expected: either a minimal long-lived doc update or an explicit conclusion that none is needed.

**Continue when:**
- Documentation decision is recorded in the final summary.

**Stop and report when:**
- A durable documentation target is needed but unclear from repository structure.

- [ ] Step 1: Review whether `extensions/plan-runner.ts` behavior should be documented outside the spec.
- [ ] Step 2: If needed, update the appropriate long-lived doc; otherwise note why no promotion is necessary.
- [ ] Step 3: Include the documentation decision in the final handoff summary.
