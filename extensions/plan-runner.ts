/**
 * Plan Runner Extension
 *
 * Runs an approved implementation plan in a single child pi session.
 * - /run-plan <plan-file>
 * - /run-status
 * - /run-summary
 * - /run-promote-docs
 * - /run-stop
 * - /run-merge
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

type RepoBranch = {
  name: string;
  root: string;
  previousBranch: string;
  dirty: boolean;
};

type RunModelSnapshot = {
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  modelDisplay: string;
};

type RunState = RunModelSnapshot & {
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

type StatusData = Partial<RunModelSnapshot> & {
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

type GitCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type GitRunner = (repoRoot: string, args: string[]) => Promise<GitCommandResult>;

type RepoBranchObservation = {
  repoName: string;
  currentBranch: string;
  trunkBranch?: string;
};

export type MergeScopeRepo = {
  name: string;
  root: string;
  sourceBranch: string;
  targetBranch: string;
  currentBranch: string;
  dirty: boolean;
  detached: boolean;
};

export type MergeScope = {
  sourceBranch: string;
  repos: MergeScopeRepo[];
  requiresConfirmation: boolean;
  confirmationMessage?: string;
};

type CommitPlanEntry = {
  message: string;
  files?: string[];
};

export type CommitPlan = {
  strategy: "squash" | "atomic";
  commits: CommitPlanEntry[];
};

export type MergePreview = {
  status: "clean" | "conflict" | "noop";
  repo: Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch">;
  targetHead: string;
  mergeBase: string;
  changedFiles: string[];
  commitSubjects: string[];
  tempDir?: string;
  tempBranch?: string;
  conflictFiles?: string[];
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
const ACTIVE_RUN_STATES = new Set(["preparing", "running", "verifying"]);

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

export function formatRunModelDisplay(model: { provider: string; id: string }, thinkingLevel: string): string {
  return `${model.provider}/${model.id}:${thinkingLevel}`;
}

export function formatRunStatusLabel(state: string, phase?: string, modelDisplay?: string): string {
  const parts = (() => {
    switch (state) {
      case "preparing":
        return ["⚙ preparing"];
      case "running":
        return ["▶ running"];
      case "verifying":
        return ["🧪 verifying"];
      case "blocked":
        return ["⛔ blocked"];
      case "failed":
        return ["✗ failed"];
      case "done":
        return ["✓ done"];
      case "stopped":
        return ["■ stopped"];
      default:
        return [state];
    }
  })();

  if (phase) parts.push(phase);
  if (modelDisplay) parts.push(modelDisplay);
  return parts.join(" · ");
}

export function buildInitialStatus(
  run: Pick<RunState, "summaryFile" | "planFile" | "tmuxSession" | "branchName"> & Partial<RunModelSnapshot>,
  repos: RepoBranch[],
): StatusData {
  return {
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
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    thinkingLevel: run.thinkingLevel,
    modelDisplay: run.modelDisplay,
  };
}

export function buildInitialSummary(
  run: Pick<RunState, "planFile" | "branchName"> & Partial<RunModelSnapshot>,
  repos: RepoBranch[],
): string {
  return [
    "# Run Summary",
    `- Result: preparing`,
    `- Plan: ${run.planFile}`,
    `- Branch: ${run.branchName}`,
    ...(run.modelDisplay ? [`- Model: ${run.modelDisplay}`] : []),
    `- Repos: ${repos.length > 0 ? repos.map((repo) => repo.name).join(", ") : "none detected"}`,
    `- Current phase: queued`,
    `- Notes: Child pi has not started yet.`,
    "",
  ].join("\n");
}

function buildStoppedSummary(run: Pick<RunState, "planFile" | "branchName"> & Partial<RunModelSnapshot>): string {
  return [
    "# Run Summary",
    "- Result: stopped",
    "- Current phase: stopped-by-user",
    `- Plan: ${run.planFile}`,
    `- Branch: ${run.branchName}`,
    ...(run.modelDisplay ? [`- Model: ${run.modelDisplay}`] : []),
    "- Notes: Run was stopped manually.",
    "",
  ].join("\n");
}

export function buildRunScript(
  run: Pick<RunState, "workdir" | "taskFile" | "fullJson" | "stderrLog" | "exitCodeFile" | "modelProvider" | "modelId" | "thinkingLevel">,
): string {
  return [
    "#!/bin/zsh",
    "set -u",
    `cd ${shellQuote(run.workdir)} || exit 1`,
    'source "$HOME/.zshrc"',
    `pi --model ${shellQuote(`${run.modelProvider}/${run.modelId}`)} --thinking ${shellQuote(run.thinkingLevel)} --mode json -p @${shellQuote(run.taskFile)} > ${shellQuote(run.fullJson)} 2> ${shellQuote(run.stderrLog)}`,
    "code=$?",
    `printf '%s\\n' \"$code\" > ${shellQuote(run.exitCodeFile)}`,
    "exit \"$code\"",
    "",
  ].join("\n");
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

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function firstPathSegment(path: string): string {
  const normalized = path.replace(/^\.\//, "").replace(/^\//, "");
  const [segment] = normalized.split("/");
  return segment || normalized;
}

function slugFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "tmp";
}

function stripOriginPrefix(value: string): string {
  return value.startsWith("origin/") ? value.slice("origin/".length) : value;
}

function stripPlanSuffix(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/[\[\]]/g, "")
    .replace(/\bimplementation\s+plan\b$/i, "")
    .replace(/\bdesign\b$/i, "")
    .trim();
}

function normalizeSubjectText(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\/(\w+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function inferCommitType(subject: string): string {
  if (/^(feat|fix|docs|refactor|test|chore):\s/i.test(subject)) {
    return subject.split(":", 1)[0].toLowerCase();
  }
  if (/\b(fix|bug|repair|correct)\b/i.test(subject)) return "fix";
  if (/\b(doc|readme)\b/i.test(subject)) return "docs";
  if (/\b(refactor|cleanup)\b/i.test(subject)) return "refactor";
  if (/\b(test|spec)\b/i.test(subject)) return "test";
  return "feat";
}

function planTitleSubject(title?: string): string | undefined {
  if (!title) return undefined;
  const stripped = normalizeSubjectText(stripPlanSuffix(title));
  if (!stripped) return undefined;
  return /^(add|fix|update|improve|refactor|document)\b/.test(stripped) ? stripped : `add ${stripped}`;
}

function goalSubject(goal?: string): string | undefined {
  if (!goal) return undefined;
  const sentence = normalizeSubjectText(goal.split(/[.。]/, 1)[0] ?? goal);
  return sentence || undefined;
}

function fileSubject(planFile?: string): string | undefined {
  if (!planFile) return undefined;
  const base = basename(planFile).replace(/\.[^.]+$/, "");
  const topic = normalizeSubjectText(base.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " "));
  return topic ? `add ${topic}` : undefined;
}

export function chooseDefaultBranch(input: { originHead?: string; localBranches: string[] }): string | undefined {
  const remote = input.originHead ? stripOriginPrefix(input.originHead.trim()) : undefined;
  if (remote) return remote;
  for (const candidate of ["main", "master", "trunk"]) {
    if (input.localBranches.includes(candidate)) return candidate;
  }
  return undefined;
}

export function inferTaskBranchFromStates(states: RepoBranchObservation[]): {
  branchName?: string;
  requiresConfirmation: boolean;
  matchedRepoNames: string[];
  branchCounts: Record<string, number>;
} {
  const branchCounts: Record<string, number> = {};
  for (const state of states) {
    if (!state.currentBranch || state.currentBranch === state.trunkBranch) continue;
    branchCounts[state.currentBranch] = (branchCounts[state.currentBranch] ?? 0) + 1;
  }

  const ranked = Object.entries(branchCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const branchName = ranked[0]?.[0];
  if (!branchName) {
    return { branchName: undefined, requiresConfirmation: false, matchedRepoNames: [], branchCounts };
  }

  const matchedRepoNames = states.filter((state) => state.currentBranch === branchName).map((state) => state.repoName);
  const distinctBranches = new Set(states.map((state) => state.currentBranch));
  return {
    branchName,
    requiresConfirmation: distinctBranches.size > 1,
    matchedRepoNames,
    branchCounts,
  };
}

export function buildMergeCommitMessage(input: {
  planTitle?: string;
  goal?: string;
  planFile?: string;
  commitSubjects?: string[];
  sourceBranch: string;
  targetBranch: string;
}): string {
  const firstSubject = input.commitSubjects?.find((subject) => subject.trim());
  const planSubject = planTitleSubject(input.planTitle)
    ?? goalSubject(input.goal)
    ?? fileSubject(input.planFile);
  if (planSubject) {
    return `${inferCommitType(planSubject)}: ${planSubject.replace(/^(feat|fix|docs|refactor|test|chore):\s*/i, "").trim()}`;
  }
  if (firstSubject && /^(feat|fix|docs|refactor|test|chore):\s/i.test(firstSubject)) {
    return firstSubject.trim();
  }

  const rawSubject = (firstSubject ? normalizeSubjectText(firstSubject) : undefined)
    ?? `merge ${normalizeSubjectText(input.sourceBranch)} back to ${normalizeSubjectText(input.targetBranch)}`;

  const cleanSubject = rawSubject.replace(/^(feat|fix|docs|refactor|test|chore):\s*/i, "").trim();
  return `${inferCommitType(rawSubject)}: ${cleanSubject}`;
}

export function buildCommitPlan(input: {
  changedFiles: string[];
  commitSubjects: string[];
  fallbackMessage: string;
}): CommitPlan {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const file of input.changedFiles) {
    const key = firstPathSegment(file);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)?.push(file);
  }

  const hasTestGroup = order.some((key) => key === "test" || key === "tests");
  const canSplit = order.length >= 2
    && order.length <= 4
    && input.commitSubjects.length === order.length
    && !hasTestGroup;

  if (!canSplit) {
    return { strategy: "squash", commits: [{ message: input.fallbackMessage }] };
  }

  return {
    strategy: "atomic",
    commits: order.map((key, index) => ({
      message: input.commitSubjects[index] ?? input.fallbackMessage,
      files: groups.get(key) ?? [],
    })),
  };
}

async function readGitOutput(git: GitRunner, repoRoot: string, args: string[], label: string): Promise<string> {
  const result = await git(repoRoot, args);
  if (result.code !== 0) {
    throw new Error(`${label}: ${result.stderr || result.stdout || args.join(" ")}`);
  }
  return result.stdout.trim();
}

async function detectWorkspaceRepos(root: string, git: GitRunner): Promise<RepoCandidate[]> {
  const dirs = [root];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        dirs.push(join(root, entry.name));
      }
    }
  } catch {
    // ignore directory scan failures
  }

  const seen = new Set<string>();
  const repos: RepoCandidate[] = [];
  for (const dir of dirs) {
    const result = await git(dir, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) continue;
    const repoRoot = result.stdout.trim();
    if (!repoRoot || seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    repos.push({ name: basename(repoRoot), root: repoRoot });
  }
  return repos.sort((left, right) => left.root.localeCompare(right.root));
}

async function detectRepoState(
  git: GitRunner,
  repo: RepoCandidate,
  targetBranch?: string,
): Promise<Omit<MergeScopeRepo, "sourceBranch"> & { trunkBranch?: string }> {
  const currentBranch = await readGitOutput(git, repo.root, ["rev-parse", "--abbrev-ref", "HEAD"], `Cannot determine branch for ${repo.root}`);
  const dirty = (await readGitOutput(git, repo.root, ["status", "--porcelain"], `Cannot read status for ${repo.root}`)).length > 0;
  const originHeadResult = await git(repo.root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const branchList = splitLines(await readGitOutput(git, repo.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], `Cannot list branches for ${repo.root}`));
  const trunkBranch = targetBranch ?? chooseDefaultBranch({
    originHead: originHeadResult.code === 0 ? originHeadResult.stdout.trim() : undefined,
    localBranches: branchList,
  });

  return {
    name: repo.name,
    root: repo.root,
    currentBranch,
    targetBranch: trunkBranch ?? "",
    dirty,
    detached: currentBranch === "HEAD",
    trunkBranch,
  };
}

function buildScopeConfirmationMessage(branchName: string, repos: Array<{ name: string; currentBranch: string; targetBranch: string }>): string {
  const repoLines = repos.map((repo) => `- ${repo.name}: ${repo.currentBranch} -> ${repo.targetBranch}`).join("\n");
  return [
    `Detected mixed branch states. Use ${branchName} as the task branch?`,
    repoLines,
  ].join("\n");
}

export async function resolveRunMergeScope(input: {
  cwd: string;
  git: GitRunner;
  activeRun?: Pick<RunState, "branchName" | "repos">;
  activeRunState?: string;
}): Promise<MergeScope> {
  if (input.activeRun) {
    const repos: MergeScopeRepo[] = [];
    let canUseActiveRun = true;

    for (const repo of input.activeRun.repos) {
      if (!(await exists(repo.root))) {
        canUseActiveRun = false;
        break;
      }
      try {
        const state = await detectRepoState(input.git, { name: repo.name, root: repo.root }, repo.previousBranch);
        if (state.currentBranch !== input.activeRun.branchName) {
          canUseActiveRun = false;
          break;
        }
        repos.push({
          ...state,
          sourceBranch: input.activeRun.branchName,
          targetBranch: repo.previousBranch,
        });
      } catch {
        canUseActiveRun = false;
        break;
      }
    }

    if (canUseActiveRun && repos.length === input.activeRun.repos.length) {
      return { sourceBranch: input.activeRun.branchName, repos, requiresConfirmation: false };
    }
  }

  const repos = await detectWorkspaceRepos(input.cwd, input.git);
  if (repos.length === 0) {
    throw new Error("No git repos found in the current workspace.");
  }

  const currentRepoResult = await input.git(input.cwd, ["rev-parse", "--show-toplevel"]);
  const states = await Promise.all(repos.map((repo) => detectRepoState(input.git, repo)));
  if (currentRepoResult.code === 0) {
    const currentRoot = currentRepoResult.stdout.trim();
    const currentRepo = states.find((repo) => repo.root === currentRoot);
    if (!currentRepo) {
      throw new Error(`Current repo ${currentRoot} is outside the detected workspace repos.`);
    }
    if (!currentRepo.currentBranch || currentRepo.currentBranch === currentRepo.trunkBranch) {
      throw new Error(`Current branch ${currentRepo.currentBranch} is already the trunk branch.`);
    }
    return {
      sourceBranch: currentRepo.currentBranch,
      requiresConfirmation: false,
      repos: states
        .filter((repo) => repo.currentBranch === currentRepo.currentBranch)
        .map((repo) => ({ ...repo, sourceBranch: currentRepo.currentBranch })),
    };
  }

  const inferred = inferTaskBranchFromStates(states.map((repo) => ({
    repoName: repo.name,
    currentBranch: repo.currentBranch,
    trunkBranch: repo.trunkBranch,
  })));
  if (!inferred.branchName) {
    throw new Error("Could not infer a task branch from the current workspace.");
  }

  const matchedRepos = states.filter((repo) => repo.currentBranch === inferred.branchName);
  return {
    sourceBranch: inferred.branchName,
    requiresConfirmation: inferred.requiresConfirmation,
    confirmationMessage: inferred.requiresConfirmation
      ? buildScopeConfirmationMessage(inferred.branchName, matchedRepos)
      : undefined,
    repos: matchedRepos.map((repo) => ({ ...repo, sourceBranch: inferred.branchName! })),
  };
}

function tempBranchName(repo: Pick<MergeScopeRepo, "name" | "sourceBranch">): string {
  return `pi-merge-${slugFragment(repo.name)}-${Date.now().toString(36)}`;
}

async function createPreviewWorktree(git: GitRunner, repo: MergeScopeRepo): Promise<{ tempDir: string; tempBranch: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), `plan-runner-${slugFragment(repo.name)}-`));
  const tempBranch = tempBranchName(repo);
  const addResult = await git(repo.root, ["worktree", "add", "-b", tempBranch, tempDir, repo.targetBranch]);
  if (addResult.code !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to create merge worktree for ${repo.name}: ${addResult.stderr || addResult.stdout}`);
  }
  return { tempDir, tempBranch };
}

async function mergeCommitSubjects(git: GitRunner, repo: MergeScopeRepo, mergeBase: string): Promise<string[]> {
  const log = await readGitOutput(git, repo.root, ["log", "--format=%s", `${mergeBase}..${repo.sourceBranch}`], `Cannot read commit subjects for ${repo.name}`);
  return splitLines(log);
}

async function mergeConflictFiles(git: GitRunner, tempDir: string): Promise<string[]> {
  const result = await git(tempDir, ["diff", "--name-only", "--diff-filter=U"]);
  return splitLines(result.stdout || "");
}

export async function cleanupMergePreview(git: GitRunner, preview: MergePreview): Promise<void> {
  if (!preview.tempDir || !preview.tempBranch) return;
  await git(preview.repo.root, ["worktree", "remove", "--force", preview.tempDir]);
  await git(preview.repo.root, ["branch", "-D", preview.tempBranch]);
  await rm(preview.tempDir, { recursive: true, force: true });
}

export async function previewMergeTarget(git: GitRunner, repo: MergeScopeRepo): Promise<MergePreview> {
  const targetHead = await readGitOutput(git, repo.root, ["rev-parse", repo.targetBranch], `Cannot resolve ${repo.targetBranch}`);
  const sourceHead = await readGitOutput(git, repo.root, ["rev-parse", repo.sourceBranch], `Cannot resolve ${repo.sourceBranch}`);
  const mergeBase = await readGitOutput(git, repo.root, ["merge-base", repo.targetBranch, repo.sourceBranch], `Cannot compute merge base for ${repo.name}`);
  const commitSubjects = await mergeCommitSubjects(git, repo, mergeBase);
  if (mergeBase === sourceHead) {
    return { status: "noop", repo, targetHead, mergeBase, changedFiles: [], commitSubjects };
  }

  const { tempDir, tempBranch } = await createPreviewWorktree(git, repo);
  const mergeResult = await git(tempDir, ["merge", "--squash", "--no-commit", repo.sourceBranch]);
  if (mergeResult.code !== 0) {
    const conflictFiles = await mergeConflictFiles(git, tempDir);
    await git(tempDir, ["reset", "--hard", "HEAD"]);
    const preview: MergePreview = {
      status: "conflict",
      repo,
      targetHead,
      mergeBase,
      changedFiles: [],
      commitSubjects,
      tempDir,
      tempBranch,
      conflictFiles,
    };
    await cleanupMergePreview(git, preview);
    return { ...preview, tempDir: undefined, tempBranch: undefined };
  }

  const changedFiles = splitLines(await readGitOutput(git, tempDir, ["diff", "--cached", "--name-only"], `Cannot inspect merge preview for ${repo.name}`));
  if (changedFiles.length === 0) {
    const preview: MergePreview = { status: "noop", repo, targetHead, mergeBase, changedFiles, commitSubjects, tempDir, tempBranch };
    await cleanupMergePreview(git, preview);
    return { ...preview, tempDir: undefined, tempBranch: undefined };
  }

  return { status: "clean", repo, targetHead, mergeBase, changedFiles, commitSubjects, tempDir, tempBranch };
}

async function commitAllChanges(git: GitRunner, tempDir: string, message: string): Promise<string> {
  const commitResult = await git(tempDir, ["commit", "-m", message]);
  if (commitResult.code !== 0) {
    throw new Error(commitResult.stderr || commitResult.stdout || `Failed to commit ${message}`);
  }
  return readGitOutput(git, tempDir, ["rev-parse", "HEAD"], "Cannot read merge commit id");
}

export async function applyMergeTarget(
  git: GitRunner,
  repo: MergeScopeRepo,
  preview: MergePreview,
  plan: CommitPlan,
): Promise<{ status: "merged" | "noop"; strategy: CommitPlan["strategy"]; commitIds: string[] }> {
  if (preview.status === "noop") {
    return { status: "noop", strategy: plan.strategy, commitIds: [] };
  }
  if (preview.status !== "clean" || !preview.tempDir || !preview.tempBranch) {
    throw new Error(`Cannot apply merge for ${repo.name} from preview status ${preview.status}.`);
  }

  try {
    const commitIds: string[] = [];
    if (plan.strategy === "atomic") {
      const resetResult = await git(preview.tempDir, ["reset"]);
      if (resetResult.code !== 0) {
        throw new Error(resetResult.stderr || resetResult.stdout || `Failed to unstage merge changes for ${repo.name}`);
      }
      for (const commit of plan.commits) {
        const addResult = await git(preview.tempDir, ["add", "--", ...(commit.files ?? [])]);
        if (addResult.code !== 0) {
          throw new Error(addResult.stderr || addResult.stdout || `Failed to stage files for ${repo.name}`);
        }
        commitIds.push(await commitAllChanges(git, preview.tempDir, commit.message));
      }
    } else {
      commitIds.push(await commitAllChanges(git, preview.tempDir, plan.commits[0]?.message ?? `chore: merge ${repo.sourceBranch}`));
    }

    const moveResult = await git(repo.root, ["branch", "-f", repo.targetBranch, preview.tempBranch]);
    if (moveResult.code !== 0) {
      throw new Error(moveResult.stderr || moveResult.stdout || `Failed to update ${repo.targetBranch} for ${repo.name}`);
    }
    return { status: "merged", strategy: plan.strategy, commitIds };
  } finally {
    await cleanupMergePreview(git, preview);
  }
}

export async function pushMergedBranches(
  git: GitRunner,
  repos: Array<Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch">>,
): Promise<Array<Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch"> & {
  remoteName: string;
  refspec: string;
}>> {
  const results = [];
  for (const repo of repos) {
    const localRef = `refs/heads/${repo.targetBranch}`;
    const remoteRef = `refs/heads/${repo.targetBranch}`;
    const refspec = `${localRef}:${remoteRef}`;
    const pushResult = await git(repo.root, ["push", "origin", refspec]);
    if (pushResult.code !== 0) {
      throw new Error(`Failed to push ${repo.name} ${repo.targetBranch} to origin/${repo.targetBranch}: ${pushResult.stderr || pushResult.stdout}`);
    }
    results.push({
      ...repo,
      remoteName: "origin",
      refspec,
    });
  }
  return results;
}

export async function writeMergeReceipt(
  run: Pick<RunState, "runId" | "runDir" | "branchName">,
  result: { strategy: CommitPlan["strategy"]; repos: Array<Record<string, unknown>> },
): Promise<string> {
  const receiptPath = join(run.runDir, "merge-result.json");
  await writeFile(receiptPath, `${JSON.stringify({
    runId: run.runId,
    branchName: run.branchName,
    completedAt: new Date().toISOString(),
    strategy: result.strategy,
    repos: result.repos,
  }, null, 2)}\n`, "utf8");
  return receiptPath;
}

async function readPlanDetails(planFile?: string): Promise<{ title?: string; goal?: string }> {
  if (!planFile || !(await exists(planFile))) return {};
  const text = await readFile(planFile, "utf8");
  const lines = text.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim();
  const goalLine = lines.find((line) => line.startsWith("**Goal:**"));
  return {
    title,
    goal: goalLine?.replace(/^\*\*Goal:\*\*\s*/, "").trim(),
  };
}

function gitRunnerFromPi(pi: ExtensionAPI): GitRunner {
  return async (repoRoot, args) => {
    const result = await pi.exec("git", ["-C", repoRoot, ...args]);
    return {
      code: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function ensureMergeReady(scope: MergeScope): void {
  if (scope.repos.length === 0) {
    throw new Error("No repos are eligible for merge.");
  }
  for (const repo of scope.repos) {
    if (repo.detached) {
      throw new Error(`${repo.name} is on a detached HEAD.`);
    }
    if (repo.dirty) {
      throw new Error(`${repo.name} has uncommitted changes.`);
    }
    if (!repo.targetBranch) {
      throw new Error(`Cannot determine trunk branch for ${repo.name}.`);
    }
  }
}

function buildConflictMessage(preview: MergePreview): string {
  const files = preview.conflictFiles?.length ? `\nFiles: ${preview.conflictFiles.join(", ")}` : "";
  return [
    `${preview.repo.name} conflicted while merging ${preview.repo.sourceBranch} into ${preview.repo.targetBranch}.`,
    "I can't safely decide how to resolve this automatically.",
    "Merge trunk into the task branch and verify there first?",
    files,
  ].join("\n");
}

function buildMergeSummary(results: Array<{ name: string; status: string; targetBranch: string; commitIds: string[] }>): string {
  return results.map((result) => {
    const commits = result.commitIds.length > 0 ? ` (${result.commitIds.join(", ")})` : "";
    return `- ${result.name}: ${result.status} -> ${result.targetBranch}${commits}`;
  }).join("\n");
}

function buildPushSummary(results: Array<{ name: string; targetBranch: string; remoteName: string }>): string {
  if (results.length === 0) return "- No branch push required";
  return results.map((result) => `- ${result.name}: pushed ${result.targetBranch} -> ${result.remoteName}/${result.targetBranch}`).join("\n");
}

export function buildDeleteBranchConfirmationMessage(
  repos: Array<Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch">>,
): string {
  const sourceBranch = repos[0]?.sourceBranch ?? "task branch";
  const repoLines = repos.map((repo) => `- ${repo.name}: ${repo.sourceBranch} -> ${repo.targetBranch}`).join("\n");
  return [
    `Delete merged task branch \`${sourceBranch}\` from these repos?`,
    repoLines,
    "Default: delete. Choose Cancel to keep the branch.",
  ].join("\n");
}

export async function finalizeMergedBranches(
  git: GitRunner,
  repos: Array<Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch">>,
  options: { deleteSourceBranch: boolean },
): Promise<Array<Pick<MergeScopeRepo, "name" | "root" | "sourceBranch" | "targetBranch"> & {
  switched: boolean;
  deleted: boolean;
  deleteError?: string;
}>> {
  const results = repos.map((repo) => ({ ...repo, switched: false, deleted: false as boolean, deleteError: undefined as string | undefined }));

  for (const result of results) {
    const checkoutResult = await git(result.root, ["checkout", result.targetBranch]);
    if (checkoutResult.code !== 0) {
      throw new Error(`Failed to switch ${result.name} to ${result.targetBranch}: ${checkoutResult.stderr || checkoutResult.stdout}`);
    }
    result.switched = true;
  }

  if (!options.deleteSourceBranch) {
    return results;
  }

  for (const result of results) {
    if (result.sourceBranch === result.targetBranch) continue;
    const deleteResult = await git(result.root, ["branch", "-D", result.sourceBranch]);
    if (deleteResult.code !== 0) {
      result.deleteError = deleteResult.stderr || deleteResult.stdout || `Failed to delete ${result.sourceBranch}`;
      continue;
    }
    result.deleted = true;
  }

  return results;
}

function buildCleanupSummary(results: Array<{ name: string; targetBranch: string; deleted: boolean; deleteError?: string }>): string {
  return results.map((result) => {
    const deleteStatus = result.deleteError
      ? `delete failed (${result.deleteError.trim()})`
      : result.deleted
        ? "branch deleted"
        : "branch kept";
    return `- ${result.name}: switched to ${result.targetBranch}; ${deleteStatus}`;
  }).join("\n");
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
    const modelDisplay = run.modelDisplay ?? status?.modelDisplay;
    const label = formatRunStatusLabel(derivedState, phase, modelDisplay);
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
    const initialStatus = buildInitialStatus(run, repos);
    const initialSummary = buildInitialSummary(run, repos);

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
      `固定执行模型：${run.modelDisplay}`,
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
      "2. 每次更新状态文件时，都保留 modelProvider、modelId、thinkingLevel、modelDisplay 这四个字段。",
      "3. 每完成一个 gate 或重要阶段，都更新状态文件和摘要文件。",
      "4. 开始验证时，将 state 或 phase 改成 verifying。",
      "5. 成功完成后，写 state=done、success=true。",
      "6. 被阻塞时，写 state=blocked，并在摘要中说明原因、已尝试动作、建议下一步。",
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
        modelProvider: run.modelProvider,
        modelId: run.modelId,
        thinkingLevel: run.thinkingLevel,
        modelDisplay: run.modelDisplay,
      }, null, 2),
      "```",
      "",
      "摘要文件要求：",
      `- 在摘要里保留固定模型：${run.modelDisplay}`,
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
    const modelLine = run.modelDisplay ? `Model: ${run.modelDisplay}\n\n` : "";
    pi.sendMessage({
      customType: "plan-runner-summary",
      content: `## Plan Runner Summary\n\nRun ID: ${run.runId}\n${modelLine}${summary}`,
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

      const currentModel = ctx.model;
      if (!currentModel) {
        ctx.ui.notify("Cannot start /run-plan because the current session model is unavailable.", "error");
        return;
      }
      const thinkingLevel = pi.getThinkingLevel();
      const modelDisplay = formatRunModelDisplay(currentModel, thinkingLevel);

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
        modelProvider: currentModel.provider,
        modelId: currentModel.id,
        thinkingLevel,
        modelDisplay,
      };

      await writeInitialArtifacts(run, repoBranches);
      await writeFile(run.taskFile, buildTaskPrompt(run, repoBranches), "utf8");
      await writeFile(run.runScript, buildRunScript(run), "utf8");
      await writeFile(join(runDir, "README.txt"), [
        `Run ID: ${run.runId}`,
        `Plan: ${run.planFile}`,
        `Model: ${run.modelDisplay}`,
        `Model provider: ${run.modelProvider}`,
        `Model ID: ${run.modelId}`,
        `Thinking level: ${run.thinkingLevel}`,
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
        ctx.ui.notify(`Started run ${run.runId}\nModel: ${run.modelDisplay}\nTmux: ${run.tmuxSession}\nBranches: ${repoNote}`, "success");
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

  pi.registerCommand("run-merge", {
    description: "Merge the current task branch back to trunk",
    handler: async (_args, ctx) => {
      const git = gitRunnerFromPi(pi);
      let mergeRun: RunState | undefined;
      let mergeRunState: string | undefined;

      if (activeRun) {
        mergeRun = activeRun;
        const running = await tmuxSessionExists(activeRun.tmuxSession);
        if (running) {
          ctx.ui.notify("The current run is still active. Wait for it to finish before merging.", "warning");
          return;
        }

        try {
          const { derivedState } = await currentStatus();
          mergeRunState = derivedState;
        } catch {
          mergeRunState = activeRun.lastKnownState;
        }

        if (mergeRunState && ACTIVE_RUN_STATES.has(mergeRunState)) {
          ctx.ui.notify("The current run is still active. Wait for it to finish before merging.", "warning");
          return;
        }
      }

      const pendingPreviews = new Map<string, MergePreview>();
      try {
        const scope = await resolveRunMergeScope({
          cwd: ctx.cwd,
          git,
          activeRun: mergeRun ? { branchName: mergeRun.branchName, repos: mergeRun.repos } : undefined,
          activeRunState: mergeRunState,
        });
        ensureMergeReady(scope);

        if (scope.requiresConfirmation) {
          if (!ctx.hasUI) {
            throw new Error(scope.confirmationMessage ?? "User confirmation is required before merging.");
          }
          const confirmed = await ctx.ui.confirm("Confirm merge scope?", scope.confirmationMessage ?? "Continue with this merge scope?");
          if (!confirmed) {
            ctx.ui.notify("Merge cancelled.", "info");
            return;
          }
        }

        const planDetails = await readPlanDetails(mergeRun?.planFile);
        const results: Array<{ name: string; status: string; targetBranch: string; commitIds: string[]; strategy?: CommitPlan["strategy"] }> = [];
        for (const repo of scope.repos) {
          const preview = await previewMergeTarget(git, repo);
          if (preview.status === "conflict") {
            const message = buildConflictMessage(preview);
            if (ctx.hasUI) {
              const confirmed = await ctx.ui.confirm("Merge conflict detected", message);
              ctx.ui.notify(
                confirmed
                  ? "Please merge trunk into the task branch, verify there, then run /run-merge again."
                  : "Merge stopped due to conflicts.",
                confirmed ? "warning" : "info",
              );
            } else {
              throw new Error(message);
            }
            return;
          }
          if (preview.status === "noop") {
            results.push({ name: repo.name, status: "noop", targetBranch: repo.targetBranch, commitIds: [] });
            continue;
          }
          if (preview.tempDir) {
            pendingPreviews.set(preview.tempDir, preview);
          }
        }

        for (const preview of pendingPreviews.values()) {
          const fallbackMessage = buildMergeCommitMessage({
            planTitle: planDetails.title,
            goal: planDetails.goal,
            planFile: mergeRun?.planFile,
            commitSubjects: preview.commitSubjects,
            sourceBranch: preview.repo.sourceBranch,
            targetBranch: preview.repo.targetBranch,
          });
          const plan = buildCommitPlan({
            changedFiles: preview.changedFiles,
            commitSubjects: preview.commitSubjects,
            fallbackMessage,
          });
          const applyResult = await applyMergeTarget(git, scope.repos.find((repo) => repo.root === preview.repo.root) ?? {
            ...preview.repo,
            currentBranch: preview.repo.sourceBranch,
            dirty: false,
            detached: false,
          }, preview, plan);
          pendingPreviews.delete(preview.tempDir ?? "");
          results.push({
            name: preview.repo.name,
            status: applyResult.status,
            targetBranch: preview.repo.targetBranch,
            commitIds: applyResult.commitIds,
            strategy: applyResult.strategy,
          });
        }

        const reposToPush = scope.repos.filter((repo) => results.some((result) => result.name === repo.name && result.status === "merged"));
        const pushResults = await pushMergedBranches(git, reposToPush);

        if (mergeRun) {
          await writeMergeReceipt(mergeRun, {
            strategy: results.some((result) => result.strategy === "atomic") ? "atomic" : "squash",
            repos: results.map((result) => ({
              name: result.name,
              root: scope.repos.find((repo) => repo.name === result.name)?.root,
              sourceBranch: scope.sourceBranch,
              targetBranch: result.targetBranch,
              status: result.status,
              commitIds: result.commitIds,
              pushed: pushResults.some((pushResult) => pushResult.name === result.name),
              pushedRemote: pushResults.find((pushResult) => pushResult.name === result.name)?.remoteName,
            })),
          });
        }

        const deleteSourceBranch = ctx.hasUI
          ? await ctx.ui.confirm("Delete merged task branch?", buildDeleteBranchConfirmationMessage(scope.repos))
          : true;
        const cleanupResults = await finalizeMergedBranches(git, scope.repos, { deleteSourceBranch });

        const summary = buildMergeSummary(results);
        const pushSummary = buildPushSummary(pushResults);
        const cleanupSummary = buildCleanupSummary(cleanupResults);
        const deleteFailures = cleanupResults.filter((result) => result.deleteError);
        ctx.ui.notify(
          `Merged ${scope.sourceBranch}\n${summary}\n${pushSummary}\n${cleanupSummary}`,
          deleteFailures.length > 0 ? "warning" : "success",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      } finally {
        for (const preview of pendingPreviews.values()) {
          await cleanupMergePreview(git, preview);
        }
      }
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
        modelProvider: activeRun.modelProvider,
        modelId: activeRun.modelId,
        thinkingLevel: activeRun.thinkingLevel,
        modelDisplay: activeRun.modelDisplay,
      };
      await writeFile(activeRun.statusFile, `${JSON.stringify(stoppedStatus, null, 2)}\n`, "utf8");
      await writeFile(activeRun.summaryFile, buildStoppedSummary(activeRun), "utf8");

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
