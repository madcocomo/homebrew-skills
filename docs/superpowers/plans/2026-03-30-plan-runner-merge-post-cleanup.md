# Plan Runner Merge Post-Cleanup Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** Fix `/run-merge` so that after merge it automatically switches each affected repo back to its target trunk branch, then asks once whether to delete the task branch, defaulting to delete.

**Architecture:** Keep the existing merge preview/apply flow intact, and add a small post-merge cleanup stage. After all repos merge successfully, switch each repo to its `targetBranch`, then perform a single delete-branch confirmation covering all merged repos. Use default-delete behavior when no UI is available.

**Tech Stack:** TypeScript extension code, Node.js fs/path APIs, `git` CLI via `pi.exec`, `node:test` integration tests.

**Repo Scope:** single repo (`/Users/wuke/code/homebrew-skills`)

---

## File Structure / Responsibility Map

### Production files
- Modify: `extensions/plan-runner.ts` — fix `/run-merge` orchestration, post-merge branch switching, one-shot branch deletion confirmation, and active run metadata wiring.

### Test files
- Modify: `tests/plan-runner.test.mjs` — add failing tests first for post-merge checkout and task-branch deletion behavior.

## Gate 1: Lock post-merge behavior with failing tests

**Goal:**
- Define the expected cleanup behavior before changing implementation.

**Files:**
- Modify: `tests/plan-runner.test.mjs`
- Modify: `extensions/plan-runner.ts`

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: new tests fail first, then pass after implementation.

**Continue when:**
- The tests prove `/run-merge` must switch back to target branches and can delete the source branch after merge.

**Stop and report when:**
- The existing test harness cannot exercise the cleanup behavior without a much larger refactor.

- [ ] Step 1: Add failing tests for helper-level post-merge cleanup behavior.
- [ ] Step 2: Run the targeted test suite and confirm failure.
- [ ] Step 3: Implement the smallest helpers and command fixes needed.
- [ ] Step 4: Re-run the test suite and confirm green.

## Gate 2: Implement command cleanup flow

**Goal:**
- Update `/run-merge` so it uses active run metadata correctly, switches repos back to trunk, then asks once about deleting the task branch.

**Files:**
- Modify: `extensions/plan-runner.ts`
- Modify: `tests/plan-runner.test.mjs`

**Verification:**
- Run: `node --test tests/plan-runner.test.mjs`
- Expected: all tests pass cleanly.

**Continue when:**
- Successful merges leave repos on `targetBranch`.
- Branch deletion is prompted once for all merged repos in UI mode.
- No-UI mode follows the default delete behavior.

**Stop and report when:**
- Cleanup fails in a way that risks leaving the repo on the wrong branch or deleting the wrong branch.

- [ ] Step 1: Wire active run metadata into `/run-merge`.
- [ ] Step 2: Add post-merge checkout helpers.
- [ ] Step 3: Add one-shot delete confirmation / default-delete behavior.
- [ ] Step 4: Re-run tests and verify output.

## Final Verification Checklist

- [ ] `node --test tests/plan-runner.test.mjs` passes cleanly.
- [ ] `/run-merge` switches merged repos to `targetBranch` after merge.
- [ ] `/run-merge` asks once whether to delete the task branch.
- [ ] Default branch deletion behavior is delete.
- [ ] Multi-repo delete flow is a single confirmation, not per-repo prompts.
