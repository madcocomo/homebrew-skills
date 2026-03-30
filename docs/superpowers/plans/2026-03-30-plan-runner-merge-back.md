# Plan Runner Merge-Back Command Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Add a `/run-merge` command to `plan-runner` that safely merges task branches back to trunk, preferring active run metadata when available and otherwise inferring same-named task branches from the current workspace.

**Architecture:** Extend `extensions/plan-runner.ts` with deterministic helper functions for merge scope inference, default trunk detection, commit message planning, and temporary-worktree preview/apply. Use git worktrees created by the command itself to preflight merges without dirtying the user’s current checkout, and only update target branches after all candidate repos pass preflight. Keep tests in `tests/plan-runner.test.mjs` with a mix of exported-helper unit tests and temporary git repo integration tests.

**Tech Stack:** TypeScript extension code, Node.js fs/path APIs, `git` CLI via `pi.exec`, `node:test` integration tests.

**Repo Scope:** single repo (`/Users/wuke/code/homebrew-skills`)

---

## File Structure / Responsibility Map

### Production files
- Modify: `extensions/plan-runner.ts` — add merge-specific types, exported helper functions, git/worktree orchestration, merge receipt writing, and the `/run-merge` command registration.

### Test files
- Modify: `tests/plan-runner.test.mjs` — add failing tests first for pure helper logic, then temporary-repo integration tests for merge preview/apply behavior, and a command-registration smoke test.

### Docs / config
- Modify: `README.md` — add a brief note that the global `plan-runner` extension now includes `/run-merge`, but only if this repo’s README is the project’s durable command inventory.
- Reference only: `docs/superpowers/specs/2026-03-30-plan-runner-merge-back-design.md` — approved design for this implementation.

## Implementation Notes / Constraints

- Keep changes minimal and local to `plan-runner`; do not refactor unrelated command behavior.
- Follow TDD strictly: each new behavior starts with a failing test.
- Prefer helper exports for logic that can be tested without a full pi command harness.
- When `cwd` is not a git repo, only scan direct child directories for repos; do not recurse further.
- With an active run, source branch and target trunks must come from `RunState` (`branchName` and each repo’s `previousBranch`).
- Without an active run, infer the task branch from the current workspace and require confirmation when branch inference is ambiguous.
- Default to a single squash commit; only split into multiple commits when the heuristic is confident the changes form clear, mostly disjoint concerns.
- Treat merge conflicts conservatively. If the preview hits conflicts and the command cannot safely resolve them mechanically, stop and ask the user whether to merge trunk into the task branch and verify there first.
- Ensure temporary worktrees and temporary refs are cleaned up on both success and failure.

## Gate 1: Lock the merge heuristics behind failing tests

**Goal:**
- Define and test the deterministic helper logic before wiring any git side effects.
- Cover the pure decisions that drive `/run-merge`: branch inference, confirmation requirements, commit message fallback, and “single squash vs multiple commits” heuristics.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Export only the smallest helper surface needed for tests.
- Keep helper functions data-in/data-out where possible so they can be exercised without mocking the full extension runtime.
- Suggested helper boundaries (names can differ if the file’s style suggests better names):
  - infer merge-branch candidate / confirmation state from repo branch observations
  - choose trunk branch from detected candidates / fallbacks
  - derive commit message inputs from plan metadata vs post-fork commit subjects
  - decide whether a diff grouping is confident enough for multiple commits

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected before implementation: new tests fail for missing exports or wrong behavior.
- Expected after implementation: all tests in `tests/plan-runner.test.mjs` pass, including pre-existing plan-runner tests.

**Continue when:**
- The new helper tests pass.
- Existing model/thinking tests still pass.
- The helper API is small enough that command wiring can reuse it directly.

**Stop and report when:**
- The approved heuristics are not specific enough to implement deterministically.
- Supporting the heuristics would require a large refactor outside `extensions/plan-runner.ts`.
- A new public behavior is needed that is not covered by the approved spec.

- [ ] Step 1: Add failing tests in `tests/plan-runner.test.mjs` for helper-level decisions:
  - active-run metadata wins over inferred workspace state
  - non-repo child scanning chooses the majority non-trunk branch but marks the result as confirmation-required
  - default trunk fallback prefers `origin/HEAD`, then `main`, `master`, `trunk`
  - commit message inputs prefer plan metadata when present and post-fork commit subjects when not
  - multi-commit splitting returns false unless concerns are clearly separable
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new tests fail for the expected reason.
- [ ] Step 3: Implement the minimum helper types/exports in `extensions/plan-runner.ts` to satisfy the tests.
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm all tests are green.
- [ ] Step 5: Commit a checkpoint on the task branch if the helper surface is now stable.

## Gate 2: Implement repo discovery and merge-scope inference

**Goal:**
- Make `/run-merge` able to determine which repos participate, which source branch to use, and which target trunk each repo should merge into.
- Cover both active-run and no-active-run flows, including `cwd` not being a repo.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Use temporary git repos in the tests to verify real branch detection behavior.
- When `cwd` is not a repo, only inspect direct children.
- If multiple child repos expose different current branches, infer the majority non-trunk branch but require confirmation before continuing.
- If no active run exists, the command should look for all repos in the workspace that are currently on the inferred task branch name.
- Keep “find participating repos” separate from “perform the merge” so failure handling stays clear.

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: PASS for scenarios covering:
  - active run scope uses `branchName` and per-repo `previousBranch`
  - no-active-run scope uses the current branch when `cwd` is a repo
  - no-active-run scope scans direct child repos when `cwd` is not a repo
  - mixed child-branch states produce a majority candidate plus a confirmation-required flag
  - same-named task branch grouping returns all matching repos, not just the current repo

**Continue when:**
- Merge-scope inference returns deterministic repo/branch targets for both active and inferred flows.
- Ambiguous branch states are surfaced as an explicit confirmation path rather than silently guessed.

**Stop and report when:**
- The workspace needs recursive repo scanning beyond direct children.
- The inference logic would require additional persistent workspace metadata not present in the approved design.
- A no-active-run workspace contains no reliable way to infer a task branch.

- [ ] Step 1: Add failing integration tests in `tests/plan-runner.test.mjs` that create temporary repos and assert the expected merge scope for:
  - active run metadata
  - `cwd` as a repo
  - `cwd` as a non-repo with direct child repos
  - multiple branch names requiring user confirmation
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new scope tests fail.
- [ ] Step 3: Implement the smallest git-backed scope helpers in `extensions/plan-runner.ts`:
  - detect direct child repos
  - inspect current branch / detached HEAD / dirty state
  - infer the task branch candidate
  - identify per-repo target trunks
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm the new scope tests pass.
- [ ] Step 5: Commit a checkpoint on the task branch if the repo-discovery behavior is stable.

## Gate 3: Add temporary-worktree merge preview and apply logic

**Goal:**
- Implement the safe, non-destructive merge flow: preview in temporary worktrees first, then apply only after every repo passes preflight.
- Cover default squash behavior, conservative conflict handling, and merge-result receipts for active runs.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Start with the single-squash path. Add multi-commit apply logic only after the squash path is working and tested.
- Prefer temporary directories under the system temp area or a run-scoped temp folder; do not assume a permanent worktree exists.
- The preview path should capture whether the merge is clean, conflicted, or blocked by repo state before any target branch ref is updated.
- Only after all repos preview cleanly should the apply path create final commit(s) and move the target branch reference.
- When an active run exists, write a merge receipt into `.pi/runs/<runId>/` (for example `merge-result.json` and/or `merge-summary.md`).

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: PASS for scenarios covering:
  - clean single-repo squash merge from task branch to trunk
  - conflict preview reports a blocked state without dirtying the original repo checkout
  - no-active-run commit message fallback uses commit subjects since the merge-base
  - active-run receipt files capture source branch, target branch, strategy, and resulting commit id(s)
  - multi-commit splitting remains disabled unless the heuristic is explicitly confident

**Continue when:**
- Preview/apply is deterministic and cleans up temporary worktrees/ref state.
- Clean merges update the target branch only after all repos pass preview.
- Conflict cases stop before modifying the user’s current checkout.

**Stop and report when:**
- Updating the target branch would require rewriting a branch that appears to be checked out elsewhere or otherwise unsafe to move automatically.
- The multi-commit split cannot be implemented deterministically with the approved heuristic.
- Git behavior in the temp repos differs enough from real repos that the approach becomes unreliable.

- [ ] Step 1: Add failing temporary-repo tests in `tests/plan-runner.test.mjs` for:
  - clean squash preview/apply
  - conflict preview with original checkout remaining clean
  - active-run merge receipt output
  - no-active-run commit-subject fallback
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new merge-flow tests fail.
- [ ] Step 3: Implement the minimum worktree preview/apply helpers in `extensions/plan-runner.ts`, including cleanup in `finally` blocks.
- [ ] Step 4: Re-run `node --test tests/plan-runner.test.mjs` and confirm the merge-flow tests pass.
- [ ] Step 5: If the multi-commit heuristic is implementable without widening scope, add the smallest additional test + implementation pair; otherwise keep the squash-only fallback and document in code comments only where the logic would otherwise be unclear.
- [ ] Step 6: Commit a checkpoint on the task branch if the merge engine is stable.

## Gate 4: Wire `/run-merge` into the extension command surface

**Goal:**
- Register and expose the new `/run-merge` command.
- Connect the command handler to the tested helpers, user confirmations, UI notifications, and active-run state.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Preconditions / Notes:**
- Keep the command conservative:
  - refuse dirty repos
  - refuse detached HEAD
  - use active-run metadata when present
  - use inferred same-name repos only when no active run exists
  - ask for confirmation when branch inference is ambiguous
  - ask the user before suggesting the “merge trunk into the task branch and verify there first” fallback on conflicts
- A lightweight command smoke test is enough if full UI-handler integration becomes brittle. Prefer testing a command-oriented orchestration helper directly and separately verifying that `/run-merge` is registered.
- Reuse the extension’s existing notification style where possible.

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: PASS for all legacy and new tests.
- Run: `rg -n "run-merge|merge-result|merge-summary" extensions/plan-runner.ts README.md`
- Expected: `/run-merge` registration appears in `extensions/plan-runner.ts`; receipt artifact names appear if implemented; README only matches if it was intentionally updated.

**Continue when:**
- `/run-merge` is registered and reachable.
- The command reports the selected source branch, target trunk(s), and result summary.
- Conflict and ambiguity paths stop for user confirmation rather than continuing silently.

**Stop and report when:**
- The pi command API lacks a required confirmation primitive and a safe fallback prompt cannot be implemented without changing the design.
- Wiring the command would force changes to unrelated commands or session lifecycle behavior.

- [ ] Step 1: Add a failing command smoke test in `tests/plan-runner.test.mjs` that verifies `/run-merge` is registered and routes through the merge orchestration helper.
- [ ] Step 2: Run `node --test tests/plan-runner.test.mjs` and confirm the new command test fails.
- [ ] Step 3: Register `/run-merge` in `extensions/plan-runner.ts` and connect it to the tested inference + merge helpers.
- [ ] Step 4: Implement user-facing notifications / confirmations for ambiguous branch inference and conflict fallback.
- [ ] Step 5: Re-run `node --test tests/plan-runner.test.mjs` and confirm all tests pass.
- [ ] Step 6: Review `git diff -- extensions/plan-runner.ts tests/plan-runner.test.mjs` to ensure the change stays scoped.

## Gate 5: Promote durable documentation only if this repo uses README as the command inventory

**Goal:**
- Ensure durable command knowledge is documented in the project’s long-lived docs if appropriate, without forcing unrelated doc restructuring.

**Files:**
- Modify if needed: `README.md`

**Preconditions / Notes:**
- This repo’s README is mostly a repository-level description, not currently a dedicated plan-runner manual.
- Only update `README.md` if a brief note about `/run-merge` fits naturally. Do not add a large extension reference section just for this task.
- If the README is not the right long-term home, leave it unchanged and note that in the implementation summary instead of making a noisy doc edit.

**Verification:**
- Run: `git diff -- README.md`
- Expected: either a small, relevant documentation addition or no diff because the executor explicitly decided the README is not the right home.

**Continue when:**
- Durable command knowledge has an appropriate home, or the executor has explicitly documented why no durable doc update was needed.

**Stop and report when:**
- A more appropriate long-term docs location clearly exists outside the approved file list and needs user confirmation.

- [ ] Step 1: Review whether `README.md` is the right durable place for a short `/run-merge` mention.
- [ ] Step 2: If yes, add the smallest useful note and verify the diff is focused.
- [ ] Step 3: If no, leave the file unchanged and record the rationale in the run summary / final report.

## Final Verification Checklist

Before claiming the feature is complete:

- [ ] `node --test tests/plan-runner.test.mjs` passes cleanly.
- [ ] `/run-merge` is registered in `extensions/plan-runner.ts`.
- [ ] Active-run merges use `RunState.branchName` and `repo.previousBranch`.
- [ ] No-active-run merges infer same-named repos from the current workspace, scanning only direct child repos when `cwd` is not itself a repo.
- [ ] Ambiguous branch inference requires user confirmation.
- [ ] Conflict preview does not dirty the user’s original checkout.
- [ ] Default behavior is a squash merge, with multi-commit behavior only when the heuristic is confident.
- [ ] When no active run exists, commit message generation uses post-fork commit subjects as a fallback reference.
- [ ] Active-run merges write a merge receipt artifact under `.pi/runs/<runId>/`.
- [ ] Any README change is minimal and justified.
