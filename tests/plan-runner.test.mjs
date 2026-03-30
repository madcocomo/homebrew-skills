import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = join(repoRoot, "extensions", "plan-runner.ts");

let modulePromise;

async function loadPlanRunnerModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      const piPackageRoot = join(npmRoot, "@mariozechner", "pi-coding-agent");
      const jitiEntry = join(piPackageRoot, "node_modules", "@mariozechner", "jiti", "lib", "jiti.mjs");
      const tempDir = await mkdtemp(join(tmpdir(), "plan-runner-test-"));

      await mkdir(join(tempDir, "node_modules", "@mariozechner"), { recursive: true });
      await symlink(piPackageRoot, join(tempDir, "node_modules", "@mariozechner", "pi-coding-agent"));

      const copiedSource = join(tempDir, "plan-runner.ts");
      await copyFile(sourcePath, copiedSource);

      const { default: createJiti } = await import(pathToFileURL(jitiEntry).href);
      const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
      });

      const module = await jiti.import(copiedSource);
      process.on("exit", () => {
        void rm(tempDir, { recursive: true, force: true });
      });
      return module;
    })();
  }
  return modulePromise;
}

function createRun() {
  return {
    runId: "run-123",
    planFile: "/tmp/plan.md",
    workdir: "/tmp/project",
    runDir: "/tmp/project/.pi/runs/run-123",
    taskFile: "/tmp/project/.pi/runs/run-123/task.md",
    summaryFile: "/tmp/project/.pi/runs/run-123/summary.md",
    statusFile: "/tmp/project/.pi/runs/run-123/status.json",
    stderrLog: "/tmp/project/.pi/runs/run-123/stderr.log",
    verifyLog: "/tmp/project/.pi/runs/run-123/verify.log",
    fullJson: "/tmp/project/.pi/runs/run-123/result.json",
    exitCodeFile: "/tmp/project/.pi/runs/run-123/exit.code",
    runScript: "/tmp/project/.pi/runs/run-123/run.zsh",
    tmuxSession: "pi-run-test",
    branchName: "pi/20260329-plan",
    repos: [],
    startedAt: "2026-03-29T00:00:00.000Z",
    modelProvider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "high",
    modelDisplay: "anthropic/claude-opus-4-6:high",
  };
}

function runGitResult(repoRoot, args, options = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    ...options,
  });
  return {
    code: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function gitRunner(repoRoot, args) {
  return runGitResult(repoRoot, args);
}

function git(repoRoot, args, message = args.join(" ")) {
  const result = runGitResult(repoRoot, args);
  assert.equal(result.code, 0, `${message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

async function createRepo(parentDir, name) {
  const repo = join(parentDir, name);
  await mkdir(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "plan-runner@example.com"]);
  git(repo, ["config", "user.name", "Plan Runner Test"]);
  await writeFile(join(repo, "notes.txt"), "base\n", "utf8");
  git(repo, ["add", "notes.txt"]);
  git(repo, ["commit", "-m", "chore: init"]);
  git(repo, ["branch", "-M", "main"]);
  return repo;
}

async function commitFile(repoRoot, fileName, content, message) {
  await writeFile(join(repoRoot, fileName), content, "utf8");
  git(repoRoot, ["add", fileName]);
  git(repoRoot, ["commit", "-m", message]);
}

test("formatRunModelDisplay returns provider/id:thinking", async () => {
  const { formatRunModelDisplay } = await loadPlanRunnerModule();
  assert.equal(
    formatRunModelDisplay({ provider: "anthropic", id: "claude-opus-4-6" }, "high"),
    "anthropic/claude-opus-4-6:high",
  );
});

test("buildRunScript pins child pi model and thinking", async () => {
  const { buildRunScript } = await loadPlanRunnerModule();
  const script = buildRunScript(createRun());

  assert.match(script, /pi --model 'anthropic\/claude-opus-4-6' --thinking 'high' --mode json -p @/);
});

test("buildInitialStatus and buildInitialSummary record model information", async () => {
  const { buildInitialStatus, buildInitialSummary } = await loadPlanRunnerModule();
  const run = createRun();
  const repos = [{ name: "homebrew-skills", root: "/tmp/project", previousBranch: "main", dirty: false }];

  const status = buildInitialStatus(run, repos);
  const summary = buildInitialSummary(run, repos);

  assert.equal(status.modelProvider, "anthropic");
  assert.equal(status.modelId, "claude-opus-4-6");
  assert.equal(status.thinkingLevel, "high");
  assert.equal(status.modelDisplay, "anthropic/claude-opus-4-6:high");
  assert.match(summary, /- Model: anthropic\/claude-opus-4-6:high/);
});

test("formatRunStatusLabel appends fixed model display", async () => {
  const { formatRunStatusLabel } = await loadPlanRunnerModule();
  assert.equal(
    formatRunStatusLabel("running", "implementing-gate-1", "anthropic/claude-opus-4-6:high"),
    "▶ running · implementing-gate-1 · anthropic/claude-opus-4-6:high",
  );
});

test("chooseDefaultBranch prefers origin head before local fallback names", async () => {
  const { chooseDefaultBranch } = await loadPlanRunnerModule();
  assert.equal(
    chooseDefaultBranch({ originHead: "origin/trunk", localBranches: ["main", "master"] }),
    "trunk",
  );
  assert.equal(
    chooseDefaultBranch({ localBranches: ["dev", "main", "release"] }),
    "main",
  );
  assert.equal(
    chooseDefaultBranch({ localBranches: ["dev", "master"] }),
    "master",
  );
});

test("inferTaskBranchFromStates picks majority non-trunk branch and marks confirmation required", async () => {
  const { inferTaskBranchFromStates } = await loadPlanRunnerModule();
  const result = inferTaskBranchFromStates([
    { repoName: "repo-a", currentBranch: "pi/feature-x", trunkBranch: "main" },
    { repoName: "repo-b", currentBranch: "pi/feature-x", trunkBranch: "main" },
    { repoName: "repo-c", currentBranch: "pi/feature-y", trunkBranch: "main" },
    { repoName: "repo-d", currentBranch: "main", trunkBranch: "main" },
  ]);

  assert.equal(result.branchName, "pi/feature-x");
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.matchedRepoNames, ["repo-a", "repo-b"]);
  assert.equal(result.branchCounts["pi/feature-x"], 2);
});

test("buildMergeCommitMessage prefers plan metadata and falls back to commit subjects", async () => {
  const { buildMergeCommitMessage } = await loadPlanRunnerModule();

  assert.equal(
    buildMergeCommitMessage({
      planTitle: "Plan Runner Merge Back Command Implementation Plan",
      goal: "Add a /run-merge command to merge task branches back to trunk.",
      planFile: "/tmp/plan-runner-merge-back.md",
      commitSubjects: ["fix: noisy task-branch subject"],
      sourceBranch: "pi/feature-x",
      targetBranch: "main",
    }),
    "feat: add plan runner merge back command",
  );

  assert.equal(
    buildMergeCommitMessage({
      commitSubjects: ["fix: keep merge preview worktree clean"],
      sourceBranch: "pi/feature-x",
      targetBranch: "main",
    }),
    "fix: keep merge preview worktree clean",
  );
});

test("buildCommitPlan stays squash by default and only splits clearly separated groups", async () => {
  const { buildCommitPlan } = await loadPlanRunnerModule();

  const squashPlan = buildCommitPlan({
    changedFiles: ["extensions/plan-runner.ts", "tests/plan-runner.test.mjs"],
    commitSubjects: ["feat: add run merge command", "test: cover merge flow"],
    fallbackMessage: "feat: add run merge command",
  });
  assert.equal(squashPlan.strategy, "squash");
  assert.equal(squashPlan.commits.length, 1);

  const atomicPlan = buildCommitPlan({
    changedFiles: ["src/api/index.ts", "src/api/routes.ts", "docs/api.md", "docs/usage.md"],
    commitSubjects: ["feat: update api routes", "docs: describe api usage"],
    fallbackMessage: "feat: update api routes",
  });
  assert.equal(atomicPlan.strategy, "atomic");
  assert.equal(atomicPlan.commits.length, 2);
  assert.deepEqual(atomicPlan.commits[0].files, ["src/api/index.ts", "src/api/routes.ts"]);
  assert.deepEqual(atomicPlan.commits[1].files, ["docs/api.md", "docs/usage.md"]);
});

test("registers run-merge command", async () => {
  const { default: planRunnerExtension } = await loadPlanRunnerModule();
  const commands = new Map();

  planRunnerExtension({
    on() {},
    appendEntry() {},
    exec() {
      throw new Error("exec should not run during registration");
    },
    sendMessage() {},
    sendUserMessage() {},
    getThinkingLevel() {
      return "high";
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });

  assert.ok(commands.has("run-merge"));
});

test("resolveRunMergeScope prefers active run metadata", async () => {
  const { resolveRunMergeScope } = await loadPlanRunnerModule();
  const workspace = await mkdtemp(join(tmpdir(), "plan-runner-scope-"));

  try {
    const repo = await createRepo(workspace, "repo-a");
    git(repo, ["checkout", "-b", "pi/task-merge"]);
    await commitFile(repo, "notes.txt", "task change\n", "feat: update task branch");

    const scope = await resolveRunMergeScope({
      cwd: workspace,
      git: gitRunner,
      activeRun: {
        branchName: "pi/task-merge",
        repos: [{ name: "repo-a", root: repo, previousBranch: "main", dirty: false }],
      },
    });

    assert.equal(scope.sourceBranch, "pi/task-merge");
    assert.equal(scope.requiresConfirmation, false);
    assert.deepEqual(scope.repos.map((entry) => ({
      name: entry.name,
      sourceBranch: entry.sourceBranch,
      targetBranch: entry.targetBranch,
    })), [
      { name: "repo-a", sourceBranch: "pi/task-merge", targetBranch: "main" },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resolveRunMergeScope scans direct child repos and asks for confirmation on mixed branches", async () => {
  const { resolveRunMergeScope } = await loadPlanRunnerModule();
  const workspace = await mkdtemp(join(tmpdir(), "plan-runner-workspace-"));

  try {
    const repoA = await createRepo(workspace, "repo-a");
    const repoB = await createRepo(workspace, "repo-b");
    const repoC = await createRepo(workspace, "repo-c");

    git(repoA, ["checkout", "-b", "pi/shared-task"]);
    await commitFile(repoA, "notes.txt", "repo-a change\n", "feat: update repo a");

    git(repoB, ["checkout", "-b", "pi/shared-task"]);
    await commitFile(repoB, "notes.txt", "repo-b change\n", "feat: update repo b");

    git(repoC, ["checkout", "-b", "pi/other-task"]);
    await commitFile(repoC, "notes.txt", "repo-c change\n", "feat: update repo c");

    const scope = await resolveRunMergeScope({
      cwd: workspace,
      git: gitRunner,
    });

    assert.equal(scope.sourceBranch, "pi/shared-task");
    assert.equal(scope.requiresConfirmation, true);
    assert.match(scope.confirmationMessage, /pi\/shared-task/);
    assert.deepEqual(scope.repos.map((entry) => entry.name), ["repo-a", "repo-b"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("previewMergeTarget and applyMergeTarget merge a clean task branch without switching the original checkout", async () => {
  const { buildCommitPlan, previewMergeTarget, applyMergeTarget } = await loadPlanRunnerModule();
  const workspace = await mkdtemp(join(tmpdir(), "plan-runner-merge-"));

  try {
    const repo = await createRepo(workspace, "repo-a");
    git(repo, ["checkout", "-b", "pi/task-clean"]);
    await commitFile(repo, "notes.txt", "clean merge\n", "feat: add clean merge");

    const preview = await previewMergeTarget(gitRunner, {
      name: "repo-a",
      root: repo,
      sourceBranch: "pi/task-clean",
      targetBranch: "main",
    });
    assert.equal(preview.status, "clean");

    const plan = buildCommitPlan({
      changedFiles: preview.changedFiles,
      commitSubjects: preview.commitSubjects,
      fallbackMessage: "feat: add clean merge",
    });
    const result = await applyMergeTarget(gitRunner, {
      name: "repo-a",
      root: repo,
      sourceBranch: "pi/task-clean",
      targetBranch: "main",
    }, preview, plan);

    assert.equal(result.status, "merged");
    assert.equal(result.strategy, "squash");
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "pi/task-clean");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(git(repo, ["log", "main", "-1", "--format=%s"]), "feat: add clean merge");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("previewMergeTarget reports conflicts without dirtying the original checkout", async () => {
  const { previewMergeTarget } = await loadPlanRunnerModule();
  const workspace = await mkdtemp(join(tmpdir(), "plan-runner-conflict-"));

  try {
    const repo = await createRepo(workspace, "repo-a");
    git(repo, ["checkout", "-b", "pi/task-conflict"]);
    await commitFile(repo, "notes.txt", "task branch line\n", "feat: task branch change");

    git(repo, ["checkout", "main"]);
    await commitFile(repo, "notes.txt", "main branch line\n", "fix: trunk side change");
    git(repo, ["checkout", "pi/task-conflict"]);

    const preview = await previewMergeTarget(gitRunner, {
      name: "repo-a",
      root: repo,
      sourceBranch: "pi/task-conflict",
      targetBranch: "main",
    });

    assert.equal(preview.status, "conflict");
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "pi/task-conflict");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writeMergeReceipt stores merge results under the run directory", async () => {
  const { writeMergeReceipt } = await loadPlanRunnerModule();
  const runDir = await mkdtemp(join(tmpdir(), "plan-runner-receipt-"));

  try {
    const receiptPath = await writeMergeReceipt(
      {
        runId: "run-merge-1",
        runDir,
        branchName: "pi/task-merge",
      },
      {
        strategy: "squash",
        repos: [
          {
            name: "repo-a",
            root: "/tmp/repo-a",
            sourceBranch: "pi/task-merge",
            targetBranch: "main",
            status: "merged",
            commitIds: ["abc123"],
          },
        ],
      },
    );

    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.runId, "run-merge-1");
    assert.equal(receipt.strategy, "squash");
    assert.equal(receipt.repos[0].commitIds[0], "abc123");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
