/**
 * Plan Runner Extension
 *
 * Runs an approved implementation plan in a single child pi session.
 * - /run-plan <plan-file>
 * - /run-status
 * - /run-summary
 * - /run-promote-docs
 * - /run-stop
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

type RepoBranch = {
  name: string;
  root: string;
  previousBranch: string;
  dirty: boolean;
};

type RunState = {
  runId: string;
  planFile: string;
  extraInstructions?: string;
  workdir: string;
  runDir: string;
  taskFile: string;
  summaryFile: string;
  statusFile: string;
  stderrLog: string;
  verifyLog: string;
  fullJson: string;
  exitCodeFile: string;
  runScript: string;
  tmuxSession: string;
  branchName: string;
  repos: RepoBranch[];
  startedAt: string;
  lastKnownState?: string;
  notifiedTerminalState?: boolean;
};

type StatusData = {
  state?: string;
  phase?: string;
  success?: boolean;
  blocked?: boolean;
  currentGate?: string;
  modifiedRepos?: string[];
  modifiedFiles?: string[];
  lastUpdate?: string;
  summaryFile?: string;
  message?: string;
  planFile?: string;
  tmuxSession?: string;
  branchName?: string;
};

type RepoCandidate = {
  name: string;
  root: string;
};

export type PlanCommandContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

export type PlanCandidate = {
  absolutePath: string;
  relativePath: string;
  normalizedRelativePath: string;
  normalizedRelativePathWithoutExt: string;
  basename: string;
  basenameWithoutExt: string;
};

type PlanResolutionMode = "direct" | "project-relative" | "suffix" | "basename" | "basename-no-ext" | "partial-suffix";

type PlanScore = {
  score: number;
  mode: PlanResolutionMode;
};

type PlanResolution = {
  planFile: string;
  mode: PlanResolutionMode;
  displayPath: string;
};

export type ParsedRunPlanArgs = {
  planFile: string;
  extraInstructions?: string;
  resolutionMode: PlanResolutionMode;
  displayPath: string;
};

class PlanResolutionError extends Error {
  constructor(
    readonly kind: "not-found" | "ambiguous" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "PlanResolutionError";
  }
}

const STATE_ENTRY = "plan-runner-state";
const STATUS_ID = "plan-runner";
const POLL_MS = 3000;

export function normalizePathArg(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

function normalizeForMatch(value: string): string {
  return normalizePathArg(value)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function stripMarkdownExtension(value: string): string {
  return value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, ".pi"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function collectMarkdownFiles(rootDir: string, projectRoot: string): Promise<PlanCandidate[]> {
  if (!(await exists(rootDir))) return [];

  const entries = await readdir(rootDir, { withFileTypes: true });
  const candidates: PlanCandidate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      candidates.push(...await collectMarkdownFiles(absolutePath, projectRoot));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

    const relativePath = relative(projectRoot, absolutePath).replace(/\\/g, "/");
    const normalizedRelativePath = normalizeForMatch(relativePath);
    candidates.push({
      absolutePath,
      relativePath,
      normalizedRelativePath,
      normalizedRelativePathWithoutExt: stripMarkdownExtension(normalizedRelativePath),
      basename: entry.name,
      basenameWithoutExt: entry.name.replace(/\.[^.]+$/, ""),
    });
  }
  return candidates;
}

export async function findPlanCandidates(projectRoot: string): Promise<PlanCandidate[]> {
  const candidates = [
    ...await collectMarkdownFiles(join(projectRoot, "docs", "superpowers", "plans"), projectRoot),
    ...await collectMarkdownFiles(join(projectRoot, "docs", "superpowers", "specs"), projectRoot),
  ];
  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function resolveDirectPlanPath(input: string, ctx: Pick<PlanCommandContext, "cwd">): Promise<string | undefined> {
  const candidate = normalizePathArg(input);
  if (!candidate) return undefined;

  const directPath = resolve(ctx.cwd, candidate);
  if (await exists(directPath)) return directPath;

  return undefined;
}

export function scorePlanCandidate(input: string, candidate: PlanCandidate): PlanScore | undefined {
  const rawInput = normalizePathArg(input);
  if (!rawInput) return undefined;
  if (rawInput === candidate.absolutePath) {
    return { score: 700, mode: "direct" };
  }

  const normalizedInput = normalizeForMatch(rawInput);
  if (!normalizedInput) return undefined;
  const normalizedInputWithoutExt = stripMarkdownExtension(normalizedInput);

  if (normalizedInput === candidate.normalizedRelativePath) {
    return { score: 600, mode: "project-relative" };
  }
  if (candidate.normalizedRelativePath.endsWith(`/${normalizedInput}`)) {
    return { score: 500, mode: "suffix" };
  }
  if (candidate.basename.toLowerCase() === normalizedInput) {
    return { score: 400, mode: "basename" };
  }
  if (!normalizedInput.includes("/") && candidate.basenameWithoutExt.toLowerCase() === normalizedInputWithoutExt) {
    return { score: 300, mode: "basename-no-ext" };
  }
  if (
    normalizedInputWithoutExt === candidate.normalizedRelativePathWithoutExt ||
    candidate.normalizedRelativePathWithoutExt.endsWith(`/${normalizedInputWithoutExt}`)
  ) {
    return { score: 200, mode: "partial-suffix" };
  }

  return undefined;
}

async function choosePlanCandidate(input: string, matches: Array<{ candidate: PlanCandidate; score: PlanScore }>, ctx: PlanCommandContext): Promise<PlanResolution> {
  const bestScore = Math.max(...matches.map((match) => match.score.score));
  const bestMatches = matches.filter((match) => match.score.score === bestScore);

  if (bestMatches.length === 1) {
    const selected = bestMatches[0];
    return {
      planFile: selected.candidate.absolutePath,
      mode: selected.score.mode,
      displayPath: selected.candidate.relativePath,
    };
  }

  const choices = bestMatches.map((match) => match.candidate.relativePath);
  if (ctx.hasUI) {
    const selection = await ctx.ui.select(`Multiple plan files matched input: ${input}`, choices);
    if (selection) {
      const selected = bestMatches.find((match) => match.candidate.relativePath === selection);
      if (selected) {
        return {
          planFile: selected.candidate.absolutePath,
          mode: selected.score.mode,
          displayPath: selected.candidate.relativePath,
        };
      }
    }
    throw new PlanResolutionError("cancelled", `Plan selection cancelled for input: ${input}`);
  }

  throw new PlanResolutionError(
    "ambiguous",
    [
      `Multiple plan files matched input: ${input}`,
      ...choices.map((choice) => `- ${choice}`),
      "Use a more specific path or `--` to separate extra instructions.",
    ].join("\n"),
  );
}

function buildNoMatchMessage(input: string): string {
  return [
    `No plan file matched input: ${input}`,
    "Searched in:",
    "- docs/superpowers/plans",
    "- docs/superpowers/specs",
  ].join("\n");
}

export async function resolvePlanReference(input: string, ctx: PlanCommandContext): Promise<PlanResolution> {
  const directPath = await resolveDirectPlanPath(input, ctx);
  if (directPath) {
    return {
      planFile: directPath,
      mode: "direct",
      displayPath: directPath,
    };
  }

  const projectRoot = await findProjectRoot(ctx.cwd);
  const candidates = await findPlanCandidates(projectRoot);
  const matches = candidates
    .map((candidate) => {
      const score = scorePlanCandidate(input, candidate);
      return score ? { candidate, score } : undefined;
    })
    .filter((value): value is { candidate: PlanCandidate; score: PlanScore } => Boolean(value));

  if (matches.length === 0) {
    throw new PlanResolutionError("not-found", buildNoMatchMessage(input));
  }

  return choosePlanCandidate(input, matches, ctx);
}

function splitExplicitInstructions(rawArgs: string): { planInput: string; extraInstructions?: string } | undefined {
  const marker = " -- ";
  const index = rawArgs.indexOf(marker);
  if (index === -1) return undefined;

  const planInput = normalizePathArg(rawArgs.slice(0, index));
  const extraInstructions = rawArgs.slice(index + marker.length).trim() || undefined;
  return { planInput, extraInstructions };
}

export async function parseRunPlanArgs(rawArgs: string, ctx: PlanCommandContext): Promise<ParsedRunPlanArgs> {
  const explicit = splitExplicitInstructions(rawArgs);
  if (explicit) {
    if (!explicit.planInput) {
      throw new PlanResolutionError("not-found", "Usage: /run-plan <plan-file>");
    }
    const resolved = await resolvePlanReference(explicit.planInput, ctx);
    return {
      planFile: resolved.planFile,
      extraInstructions: explicit.extraInstructions,
      resolutionMode: resolved.mode,
      displayPath: resolved.displayPath,
    };
  }

  const normalizedArgs = normalizePathArg(rawArgs);
  if (!normalizedArgs) {
    throw new PlanResolutionError("not-found", "Usage: /run-plan <plan-file>");
  }

  const directPath = await resolveDirectPlanPath(normalizedArgs, ctx);
  if (directPath) {
    return {
      planFile: directPath,
      resolutionMode: "direct",
      displayPath: directPath,
    };
  }

  const tokens = normalizedArgs.split(/\s+/);
  let lastError: PlanResolutionError | undefined;
  for (let count = tokens.length; count >= 1; count--) {
    const planInput = tokens.slice(0, count).join(" ");
    const extraInstructions = tokens.slice(count).join(" ").trim() || undefined;
    try {
      const resolved = await resolvePlanReference(planInput, ctx);
      return {
        planFile: resolved.planFile,
        extraInstructions,
        resolutionMode: resolved.mode,
        displayPath: resolved.displayPath,
      };
    } catch (error) {
      if (!(error instanceof PlanResolutionError)) {
        throw error;
      }
      if (error.kind === "ambiguous" || error.kind === "cancelled") {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError ?? new PlanResolutionError("not-found", buildNoMatchMessage(normalizedArgs));
}

export default function planRunnerExtension(pi: ExtensionAPI) {
  let activeRun: RunState | undefined;
  let lastCtx: ExtensionContext | undefined;
  let poller: NodeJS.Timeout | undefined;

  function slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 40) || "plan";
  }

  function timestampId(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  async function readJson<T>(path: string): Promise<T | undefined> {
    try {
      const content = await readFile(path, "utf8");
      return JSON.parse(content) as T;
    } catch {
      return undefined;
    }
  }

  async function git(repoRoot: string, args: string[]) {
    return pi.exec("git", ["-C", repoRoot, ...args]);
  }

  async function detectGitRepos(root: string): Promise<RepoCandidate[]> {
    const dirs = [root];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push(join(root, entry.name));
        }
      }
    } catch {
      // ignore directory listing failures
    }

    const seen = new Set<string>();
    const repos: RepoCandidate[] = [];
    for (const dir of dirs) {
      const result = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
      if (result.code !== 0) continue;
      const repoRoot = result.stdout.trim();
      if (!repoRoot || seen.has(repoRoot)) continue;
      seen.add(repoRoot);
      repos.push({ name: basename(repoRoot), root: repoRoot });
    }
    return repos.sort((left, right) => left.root.localeCompare(right.root));
  }

  async function detectTouchedRepos(cwd: string, planText: string): Promise<RepoCandidate[]> {
    const repos = await detectGitRepos(cwd);
    if (repos.length === 0) return [];

    const matched = repos.filter((repo) => {
      const repoPrefix = `${repo.name}/`;
      return (
        planText.includes(repoPrefix) ||
        planText.includes(`\`${repoPrefix}`) ||
        planText.includes(`${repo.root}/`) ||
        planText.includes(` ${repoPrefix}`)
      );
    });
    if (matched.length > 0) return matched;

    const currentRepo = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (currentRepo.code === 0) {
      const root = currentRepo.stdout.trim();
      const repo = repos.find((candidate) => candidate.root === root);
      if (repo) return [repo];
    }

    if (repos.length === 1) return repos;
    return [];
  }

  async function ensureTaskBranches(repos: RepoCandidate[], branchName: string): Promise<RepoBranch[]> {
    const results: RepoBranch[] = [];
    for (const repo of repos) {
      const branchResult = await git(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branchResult.code !== 0) {
        throw new Error(`Cannot determine current branch for ${repo.root}`);
      }
      const previousBranch = branchResult.stdout.trim();

      const statusResult = await git(repo.root, ["status", "--porcelain"]);
      const dirty = statusResult.stdout.trim().length > 0;

      const existsResult = await git(repo.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
      if (previousBranch !== branchName) {
        const checkoutArgs = existsResult.code === 0 ? ["checkout", branchName] : ["checkout", "-b", branchName];
        const checkoutResult = await git(repo.root, checkoutArgs);
        if (checkoutResult.code !== 0) {
          throw new Error(`Failed to switch ${repo.root} to branch ${branchName}: ${checkoutResult.stderr || checkoutResult.stdout}`);
        }
      }

      results.push({
        name: repo.name,
        root: repo.root,
        previousBranch,
        dirty,
      });
    }
    return results;
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY, { run: activeRun ?? null });
  }

  async function restoreState(ctx: ExtensionContext): Promise<void> {
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY) as
      | { data?: { run?: RunState | null } }
      | undefined;
    activeRun = saved?.data?.run ?? undefined;
    lastCtx = ctx;
    await refreshStatus(ctx);
    startPoller();
  }

  function formatState(state: string, phase?: string): string {
    const suffix = phase ? ` · ${phase}` : "";
    switch (state) {
      case "preparing":
        return `⚙ preparing${suffix}`;
      case "running":
        return `▶ running${suffix}`;
      case "verifying":
        return `🧪 verifying${suffix}`;
      case "blocked":
        return `⛔ blocked${suffix}`;
      case "failed":
        return `✗ failed${suffix}`;
      case "done":
        return `✓ done${suffix}`;
      case "stopped":
        return `■ stopped${suffix}`;
      default:
        return state + suffix;
    }
  }

  async function tmuxSessionExists(session: string): Promise<boolean> {
    const result = await pi.exec("tmux", ["has-session", "-t", session]);
    return result.code === 0;
  }

  async function currentStatus(): Promise<{ run: RunState; status?: StatusData; derivedState: string; exitCode?: string }> {
    if (!activeRun) {
      throw new Error("No active run");
    }
    const status = await readJson<StatusData>(activeRun.statusFile);
    const exitCode = (await exists(activeRun.exitCodeFile)) ? (await readFile(activeRun.exitCodeFile, "utf8")).trim() : undefined;
    const tmuxAlive = await tmuxSessionExists(activeRun.tmuxSession);

    let derivedState = status?.state ?? "unknown";
    if (!status?.state) {
      if (tmuxAlive) derivedState = "running";
      else if (exitCode === "0") derivedState = "done";
      else if (exitCode) derivedState = "failed";
    } else if (["running", "preparing", "verifying"].includes(status.state) && !tmuxAlive && exitCode) {
      derivedState = exitCode === "0" ? "done" : "failed";
    }

    return { run: activeRun, status, derivedState, exitCode };
  }

  async function refreshStatus(ctx: ExtensionContext, announce = false): Promise<void> {
    lastCtx = ctx;
    if (!activeRun) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    const { run, status, derivedState } = await currentStatus();
    const phase = status?.phase ?? status?.currentGate;
    const label = formatState(derivedState, phase);
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(derivedState === "blocked" || derivedState === "failed" ? "warning" : "accent", label));

    activeRun.lastKnownState = derivedState;
    if (["done", "blocked", "failed", "stopped"].includes(derivedState) && !activeRun.notifiedTerminalState) {
      activeRun.notifiedTerminalState = true;
      persistState();
      if (ctx.hasUI) {
        const nextStep = derivedState === "done" ? "\nNext: /run-promote-docs" : "";
        ctx.ui.notify(`Run ${run.runId}: ${label}${nextStep}`, derivedState === "done" ? "success" : "warning");
      }
    }

    if (announce && ctx.hasUI) {
      const modifiedFiles = status?.modifiedFiles?.length ? `\nFiles: ${status.modifiedFiles.length}` : "";
      const updated = status?.lastUpdate ? `\nUpdated: ${status.lastUpdate}` : "";
      ctx.ui.notify(`Run ${run.runId}\nState: ${label}${modifiedFiles}${updated}`, derivedState === "done" ? "success" : "info");
    }
  }

  function startPoller(): void {
    if (poller) return;
    poller = setInterval(() => {
      if (!lastCtx || !activeRun) return;
      refreshStatus(lastCtx).catch(() => {
        // keep polling even if a transient read fails
      });
    }, POLL_MS);
    poller.unref?.();
  }

  async function writeInitialArtifacts(run: RunState, repos: RepoBranch[]): Promise<void> {
    const initialStatus: StatusData = {
      state: "preparing",
      phase: "queued",
      success: false,
      blocked: false,
      modifiedRepos: repos.map((repo) => repo.name),
      modifiedFiles: [],
      lastUpdate: new Date().toISOString(),
      summaryFile: run.summaryFile,
      planFile: run.planFile,
      tmuxSession: run.tmuxSession,
      branchName: run.branchName,
      message: "Run created. Waiting for child pi to start.",
    };

    const initialSummary = [
      "# Run Summary",
      `- Result: preparing`,
      `- Plan: ${run.planFile}`,
      `- Branch: ${run.branchName}`,
      `- Repos: ${repos.length > 0 ? repos.map((repo) => repo.name).join(", ") : "none detected"}`,
      `- Current phase: queued`,
      `- Notes: Child pi has not started yet.`,
      "",
    ].join("\n");

    await writeFile(run.statusFile, `${JSON.stringify(initialStatus, null, 2)}\n`, "utf8");
    await writeFile(run.summaryFile, initialSummary, "utf8");
  }

  function buildTaskPrompt(run: RunState, repos: RepoBranch[]): string {
    const repoLines = repos.length > 0
      ? repos.map((repo) => `- ${repo.name}: ${repo.root} (current task branch: ${run.branchName}, previous branch: ${repo.previousBranch}, dirty at start: ${repo.dirty ? "yes" : "no"})`).join("\n")
      : "- No git repo detected from the current working directory. If the plan clearly targets a git repo, discover it before changing files.";
    const extraInstructionsSection = run.extraInstructions
      ? ["附加执行说明：", `- ${run.extraInstructions}`, ""]
      : [];

    return [
      `任务：执行计划 \`${run.planFile}\``,
      "",
      `工作目录：${run.workdir}`,
      `计划文件：${run.planFile}`,
      `状态文件：${run.statusFile}`,
      `摘要文件：${run.summaryFile}`,
      `验证日志：${run.verifyLog}`,
      `完整事件输出：${run.fullJson}`,
      ...extraInstructionsSection,
      "执行模式：单执行器连续运行",
      "- 先完整阅读计划文件，再开始实施。",
      "- 默认连续执行直到完成，不要在中间要求用户确认。",
      "- 只有在以下情况才停止并回报：真正 blocked、风险明显升级、范围扩大到未批准内容、需要业务/产品判断。",
      "",
      "Git约束：",
      "- 只在已经创建好的任务分支上工作，不要切回默认分支。",
      "- 允许小步提交，但仅在任务分支上提交。",
      "- 只在计划涉及的 repo 中修改和提交。",
      repoLines,
      "",
      "状态更新要求：",
      "1. 一开始就用 write 覆盖状态文件，至少写入 state=running、phase=reading-plan、lastUpdate。",
      "2. 每完成一个 gate 或重要阶段，都更新状态文件和摘要文件。",
      "3. 开始验证时，将 state 或 phase 改成 verifying。",
      "4. 成功完成后，写 state=done、success=true。",
      "5. 被阻塞时，写 state=blocked，并在摘要中说明原因、已尝试动作、建议下一步。",
      "",
      "状态文件 JSON 示例：",
      "```json",
      JSON.stringify({
        state: "running",
        phase: "implementing-gate-1",
        success: false,
        blocked: false,
        currentGate: "Gate 1",
        modifiedRepos: repos.map((repo) => repo.name),
        modifiedFiles: [],
        lastUpdate: new Date().toISOString(),
        summaryFile: run.summaryFile,
        message: "Started reading the plan.",
      }, null, 2),
      "```",
      "",
      "摘要文件要求：",
      "- 内容尽量短，只保留结果、当前阶段、已修改文件、验证结果、风险/阻塞、下一步建议。",
      "- 不要把长日志塞进摘要。长日志放到验证日志或 stderr。",
      "",
      "验证要求：",
      "- 运行计划中要求的 targeted verification。",
      "- 将关键验证命令和结果追加写入验证日志。",
      "- 在声称完成之前，确保状态文件和摘要文件已经是最终状态。",
      "",
      "最终回答要求：",
      "- 简短总结修改文件、验证结果、风险。",
      "- 不要要求主线程再去读大日志，除非确实 blocked。",
      "",
      "现在开始：先读取计划文件，再更新状态文件和摘要文件。",
      "",
    ].join("\n");
  }

  function buildRunScript(run: RunState): string {
    return [
      "#!/bin/zsh",
      "set -u",
      `cd ${shellQuote(run.workdir)} || exit 1`,
      'source "$HOME/.zshrc"',
      `pi --mode json -p @${shellQuote(run.taskFile)} > ${shellQuote(run.fullJson)} 2> ${shellQuote(run.stderrLog)}`,
      "code=$?",
      `printf '%s\n' \"$code\" > ${shellQuote(run.exitCodeFile)}`,
      "exit \"$code\"",
      "",
    ].join("\n");
  }

  function buildPromotionPrompt(run: RunState): string {
    return [
      `Please perform the documentation-promotion closeout for run ${run.runId}.`,
      "",
      "Read and use these working artifacts:",
      `- Plan: ${run.planFile}`,
      `- Run summary: ${run.summaryFile}`,
      `- Run status: ${run.statusFile}`,
      "- If there is a related design/spec working doc in docs/superpowers/..., locate and read it as needed.",
      "",
      "Then update the project's long-lived documentation using the project's existing documentation organization.",
      "Promote durable information such as:",
      "- architecture or design decisions worth keeping",
      "- stable API or workflow rules",
      "- durable operational notes or contributor guidance",
      "",
      "Do not promote transient execution details such as:",
      "- per-run status history",
      "- checkpoint notes",
      "- temporary summaries that only matter to this run",
      "",
      "If no durable documentation updates are needed, explicitly explain why instead of editing docs unnecessarily.",
      "After the documentation update, summarize what was promoted and where it now lives.",
    ].join("\n");
  }

  async function launchRun(run: RunState): Promise<void> {
    const tmuxArgs = ["new-session", "-d"];
    const envNames = [
      "http_proxy",
      "https_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "all_proxy",
      "ALL_PROXY",
      "no_proxy",
      "NO_PROXY",
    ];
    for (const name of envNames) {
      const value = process.env[name];
      if (value) {
        tmuxArgs.push("-e", `${name}=${value}`);
      }
    }
    tmuxArgs.push("-s", run.tmuxSession, `zsh ${shellQuote(run.runScript)}`);

    const result = await pi.exec("tmux", tmuxArgs);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "Failed to start tmux session");
    }
  }

  async function renderSummaryMessage(run: RunState): Promise<void> {
    const summary = (await exists(run.summaryFile)) ? await readFile(run.summaryFile, "utf8") : "Summary file does not exist yet.";
    pi.sendMessage({
      customType: "plan-runner-summary",
      content: `## Plan Runner Summary\n\nRun ID: ${run.runId}\n\n${summary}`,
      display: true,
    });
  }

  pi.registerCommand("run-plan", {
    description: "Run an approved plan in a single child pi session (usage: /run-plan <plan-file>)",
    handler: async (args, ctx) => {
      let parsedArgs: ParsedRunPlanArgs;
      try {
        parsedArgs = await parseRunPlanArgs(args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, message.startsWith("Usage:") ? "warning" : "error");
        return;
      }

      if (activeRun) {
        const running = await tmuxSessionExists(activeRun.tmuxSession);
        if (running) {
          ctx.ui.notify(`A run is already active: ${activeRun.runId}`, "warning");
          await refreshStatus(ctx, true);
          return;
        }
      }

      const planFile = parsedArgs.planFile;
      const planText = await readFile(planFile, "utf8");
      const projectRoot = await findProjectRoot(ctx.cwd);
      if (ctx.hasUI && (parsedArgs.resolutionMode !== "direct" || parsedArgs.extraInstructions)) {
        const notes = [
          parsedArgs.resolutionMode !== "direct" ? `Using matched plan: ${parsedArgs.displayPath}` : undefined,
          parsedArgs.extraInstructions ? `Extra instructions: ${parsedArgs.extraInstructions}` : undefined,
        ].filter((value): value is string => Boolean(value));
        if (notes.length > 0) {
          ctx.ui.notify(notes.join("\n"), "info");
        }
      }
      const runId = `${timestampId()}-${slugify(basename(planFile))}`;
      const branchName = `pi/${timestampId()}-${slugify(basename(planFile))}`;
      const runDir = join(projectRoot, ".pi", "runs", runId);
      await mkdir(runDir, { recursive: true });

      const repos = await detectTouchedRepos(ctx.cwd, planText);
      const repoBranches = await ensureTaskBranches(repos, branchName);

      const run: RunState = {
        runId,
        planFile,
        extraInstructions: parsedArgs.extraInstructions,
        workdir: ctx.cwd,
        runDir,
        taskFile: join(runDir, "task.md"),
        summaryFile: join(runDir, "summary.md"),
        statusFile: join(runDir, "status.json"),
        stderrLog: join(runDir, "stderr.log"),
        verifyLog: join(runDir, "verify.log"),
        fullJson: join(runDir, "result.json"),
        exitCodeFile: join(runDir, "exit.code"),
        runScript: join(runDir, "run.zsh"),
        tmuxSession: `pi-run-${slugify(basename(planFile)).slice(0, 16)}-${timestampId().slice(-6)}`,
        branchName,
        repos: repoBranches,
        startedAt: new Date().toISOString(),
      };

      await writeInitialArtifacts(run, repoBranches);
      await writeFile(run.taskFile, buildTaskPrompt(run, repoBranches), "utf8");
      await writeFile(run.runScript, buildRunScript(run), "utf8");
      await writeFile(join(runDir, "README.txt"), [
        `Run ID: ${run.runId}`,
        `Plan: ${run.planFile}`,
        ...(run.extraInstructions ? [`Extra instructions: ${run.extraInstructions}`] : []),
        `Tmux session: ${run.tmuxSession}`,
        `Status: ${run.statusFile}`,
        `Summary: ${run.summaryFile}`,
        `Logs: ${run.stderrLog}, ${run.verifyLog}, ${run.fullJson}`,
        "",
      ].join("\n"), "utf8");

      await launchRun(run);

      activeRun = run;
      persistState();
      await refreshStatus(ctx, true);
      startPoller();

      if (ctx.hasUI) {
        const repoNote = repoBranches.length > 0
          ? repoBranches.map((repo) => `${repo.name} -> ${branchName}`).join(", ")
          : "no repo detected";
        ctx.ui.notify(`Started run ${run.runId}\nTmux: ${run.tmuxSession}\nBranches: ${repoNote}`, "success");
      }
    },
  });

  pi.registerCommand("run-status", {
    description: "Show the current plan runner status",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No active run.", "info");
        ctx.ui.setStatus(STATUS_ID, undefined);
        return;
      }
      await refreshStatus(ctx, true);
    },
  });

  pi.registerCommand("run-summary", {
    description: "Show the current plan runner summary",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No active run.", "info");
        return;
      }
      await refreshStatus(ctx);
      await renderSummaryMessage(activeRun);
    },
  });

  pi.registerCommand("run-promote-docs", {
    description: "Trigger documentation promotion from working run artifacts into project long-term docs",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No active run.", "info");
        return;
      }

      const { derivedState } = await currentStatus();
      if (!["done", "blocked", "failed", "stopped"].includes(derivedState)) {
        ctx.ui.notify("Documentation promotion is intended for a finished or stopped run. Use /run-status first.", "warning");
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(`Dispatching documentation-promotion closeout for run ${activeRun.runId}`, "info");
      }
      pi.sendUserMessage(buildPromotionPrompt(activeRun));
    },
  });

  pi.registerCommand("run-stop", {
    description: "Stop the current plan runner tmux session",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No active run.", "info");
        return;
      }

      if (await tmuxSessionExists(activeRun.tmuxSession)) {
        await pi.exec("tmux", ["kill-session", "-t", activeRun.tmuxSession]);
      }

      const stoppedStatus: StatusData = {
        ...(await readJson<StatusData>(activeRun.statusFile)),
        state: "stopped",
        phase: "stopped-by-user",
        success: false,
        blocked: true,
        lastUpdate: new Date().toISOString(),
        summaryFile: activeRun.summaryFile,
        message: "Run stopped by user.",
      };
      await writeFile(activeRun.statusFile, `${JSON.stringify(stoppedStatus, null, 2)}\n`, "utf8");
      await writeFile(activeRun.summaryFile, [
        "# Run Summary",
        "- Result: stopped",
        "- Current phase: stopped-by-user",
        `- Plan: ${activeRun.planFile}`,
        `- Branch: ${activeRun.branchName}`,
        "- Notes: Run was stopped manually.",
        "",
      ].join("\n"), "utf8");

      activeRun.notifiedTerminalState = true;
      persistState();
      await refreshStatus(ctx, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreState(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await restoreState(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });
}
