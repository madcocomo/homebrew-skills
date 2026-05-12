---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for the codebase and questionable taste. Document exactly which files to touch, what to change, how to test it, and what should cause the executor to continue versus stop and report back. DRY. YAGNI. TDD. Explicit verification.

Assume they are a skilled developer, but know almost nothing about the repository, tooling, or domain.

This skill is for work that genuinely benefits from a written implementation plan; it is not the default path for every confirmed change.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Execution model:** Plans must work for both single-repo and multi-repo projects. Do **not** assume a dedicated worktree. The default handoff is a single continuous executor started with `/run-plan <plan-file>`, which creates task branches for the repo(s) the plan touches and runs until completion or a true stop condition.

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)
- Commit the plan document before asking the user to review it or offering execution handoff

## Scope Check

If the task is a small bounded modification with narrow, localized, explicit scope after context reading, do **not** use this skill. After clarification and user confirmation, execute it directly in the current session instead. Judge this by analyzed change scope, not file type. In that direct path:
- do not write spec or plan files
- do not hand off to `/run-plan`
- do not create task branches just for the change

If the spec covers multiple independent subsystems, suggest splitting it into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## Planning Principles

- Start with a file map before task breakdown. Lock in boundaries first.
- Use exact file paths whenever possible.
- Follow existing project conventions rather than imposing a new structure.
- Prefer smaller, focused changes over broad refactors.
- Keep TDD visible in the plan: failing test or baseline, minimal implementation, verification, cleanup.
- Write the plan for a **single executor** that should keep moving without constant human confirmation.
- Make stop conditions explicit so the executor knows when to surface back to the user.
- Treat `docs/superpowers/...` as working artifacts, not automatically the final home for durable project knowledge.
- If the work introduces long-lived architecture, design, API, or process knowledge, include a final documentation-promotion gate that updates the project's long-term docs in its existing structure.

## Repo and Branch Awareness

Plans must stay generic across repo layouts:

- If the task touches a single repo, the plan should read naturally as a single-repo plan.
- If the task touches multiple repos, clearly group files by repo and keep repo boundaries obvious.
- Do not make multi-repo handling the only path through the skill.
- Do not require worktrees.
- Assume execution will happen on task branches created for the touched repo(s).

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **Execution model:** This plan is designed for a single continuous executor. Start it with `/run-plan <plan-file>` after approval. The runner creates task branches for the touched repo(s), keeps status in `.pi/runs/...`, and only stops early for explicit stop conditions.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Repo Scope:** [single repo / multiple repos, and which ones if already known]

---
```

## File Structure Section

Before defining gates, include a file map section that tells the executor what each file is for.

Example:

```markdown
## File Structure / Responsibility Map

### Production files
- Modify: `src/.../service.ts` — add orchestration logic
- Create: `src/.../validator.ts` — isolate input validation

### Test files
- Modify: `tests/.../service.test.ts` — cover happy path and failure path

### Docs / config
- Modify: `README.md` — document new flag
```

## Gate-Based Task Structure

Use **gates**, not a long flat list of unrelated micro-steps. Each gate should be independently understandable and should tell the executor when to continue and when to stop.

````markdown
### Gate N: [Name]

**Goal:**
- What this gate achieves

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:120-180`
- Test: `tests/exact/path/to/test.ts`

**Preconditions / Notes:**
- Any context the executor must know before starting

**Verification:**
- Run: `npm test -- path/to/test`
- Expected: PASS for the targeted scenario

**Continue when:**
- Concrete condition that allows automatic progression

**Stop and report when:**
- Scope expands beyond the approved plan
- Verification fails after a reasonable local retry
- A risky migration or destructive change is required
- User/business judgment is needed

- [ ] Step 1: Write or update the failing test / baseline check
- [ ] Step 2: Run it and confirm the current failure or baseline result
- [ ] Step 3: Implement the smallest change that should satisfy the gate
- [ ] Step 4: Run the targeted verification again
- [ ] Step 5: Commit progress on the task branch if a checkpoint is useful
````

## Task Granularity

Within each gate, steps should still be bite-sized, but the plan should optimize for flow rather than ceremony.

Good:
- "Write the failing API test"
- "Run the targeted test to confirm the failure"
- "Implement minimal controller change"
- "Run the targeted test again"
- "Commit progress on the task branch"

Bad:
- Huge steps that mix design, coding, and verification
- Flat lists of 30+ steps with no gate boundaries
- Plans that require the user to manually authorize every tiny move

## What Good Stop Conditions Look Like

The executor should continue automatically by default. Stop conditions must be concrete.

Good stop conditions:
- "The plan needs an additional repo not listed in Repo Scope"
- "The public API contract must change beyond the approved spec"
- "Targeted verification still fails after one bounded fix attempt"
- "Data migration appears destructive or irreversible"
- "A product decision is required between two valid behaviors"

Bad stop conditions:
- "Stop if anything is unclear"
- "Stop after each gate for confirmation"
- "Ask the user before every commit"

## Documentation Promotion

When the plan produces durable knowledge, add a final gate for documentation promotion.

Promote:
- architecture decisions worth keeping
- stable API or workflow rules
- durable operational notes
- conventions future contributors should follow

Do not promote:
- transient run status
- task checkpoint notes
- per-run summaries that only matter to the current execution

The promotion target should follow the project's existing documentation organization. Do not assume every project wants long-term docs under `docs/superpowers/...`.

## Remember

- Exact file paths always
- Complete commands with expected outcomes
- Keep TDD visible
- Make repo boundaries obvious when relevant
- Prefer minimal changes
- Tell the executor exactly what success looks like
- Tell the executor exactly what should block automatic continuation
- Separate working artifacts from long-lived project documentation

## Plan Approval Gate

After writing the complete plan:

1. Commit the plan document to git
2. Present the saved plan path to the user
3. Ask the user to review the plan before execution:

> "Plan written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start execution with `/run-plan <plan-file>`."

4. If the user requests changes, update the plan file, recommit it, and present the revised version
5. Only proceed to execution handoff once the user approves

## Execution Handoff

After the user approves the committed plan, offer this handoff:

**"Plan approved and committed at `docs/superpowers/plans/<filename>.md`. If you want me to execute it with the single-runner workflow, use `/run-plan <plan-file>`. That runner creates task branches for the touched repo(s), writes status to `.pi/runs/...`, and only stops early for explicit block conditions. After implementation is finished, use `/run-promote-docs` to promote durable knowledge into the project's long-term docs when needed."**

If the user explicitly prefers inline/manual execution, adapt — but do not reintroduce a mandatory per-task subagent workflow.
