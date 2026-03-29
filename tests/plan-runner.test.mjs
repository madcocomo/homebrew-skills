import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
