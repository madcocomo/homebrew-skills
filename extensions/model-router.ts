/**
 * Model router extension — downgrade routing for cost reduction.
 *
 * - Default mode is off; a missing config file keeps the extension inert.
 * - Classifier + weak model identities are fixed by configuration; no candidate discovery.
 * - Shadow mode never calls pi.setModel(); active mode only downgrades to
 *   the configured weak model when the classifier deems the task simple enough.
 * - "Strong verdict" means do not intervene — let the user's current model continue.
 *
 * See docs/pi-model-routing-design.md for the full design.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { basename, dirname, join } from "node:path";
import * as nodeFs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface RouterFs {
  readTextFile(path: string): string;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  appendFile(path: string, data: string, options?: { mode?: number }): void;
  writeFile(path: string, data: string, options?: { mode?: number }): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  realpath(path: string): string;
  remove?(path: string): void;
}

export type RouterClassifier = (input: unknown) => Promise<unknown>;
export type SubPiRunner = (invocation: SubPiInvocation, signal?: AbortSignal) => Promise<SubPiResult>;

export interface RouterDependencies {
  agentDir?: string;
  fs?: RouterFs;
  now?: () => Date;
  randomId?: () => string;
  warn?: (message: string) => void;
  classify?: RouterClassifier;
  childRunner?: SubPiRunner;
  env?: Record<string, string | undefined>;
}

function createNodeFs(): RouterFs {
  return {
    readTextFile: (path) => nodeFs.readFileSync(path, "utf8"),
    mkdir: (path, options) => {
      nodeFs.mkdirSync(path, { recursive: options?.recursive ?? true, mode: options?.mode });
    },
    appendFile: (path, data, options) => {
      nodeFs.appendFileSync(path, data, { mode: options?.mode });
    },
    writeFile: (path, data, options) => {
      nodeFs.writeFileSync(path, data, { mode: options?.mode });
    },
    rename: (from, to) => nodeFs.renameSync(from, to),
    exists: (path) => nodeFs.existsSync(path),
    realpath: (path) => nodeFs.realpathSync(path),
    remove: (path) => nodeFs.rmSync(path, { recursive: true, force: true }),
  };
}

interface ProductionClassifierRequest {
  input: unknown;
  model: any;
  timeoutMs: number;
  signal?: AbortSignal;
  getAuth: () => Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    error?: string;
  }>;
}

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a conservative task router.",
  "Return exactly one JSON object and no markdown or explanatory text.",
  'The exact shape is {"protocolVersion":1,"route":"weak|strong","confidence":0.0,"riskFlags":[],"reasonCode":"..."}.',
  "riskFlags may contain only ambiguous_scope, cross_module, long_horizon, sensitive, image_uncertain, acceptance_uncertain.",
  "reasonCode must be one of localized_explicit_task, broad_task, uncertain_scope, high_risk, other.",
  "Choose weak only for a localized task whose supplied capsule is complete; otherwise choose strong.",
].join(" ");

/** Production adapter for the fixed classifier model. */
export function createProductionClassifier(
  completeFn: typeof complete = complete,
): RouterClassifier {
  return async (rawRequest: unknown): Promise<{ text: string }> => {
    const request = rawRequest as ProductionClassifierRequest;
    const auth = await request.getAuth();
    if (!auth.ok) throw new Error("classifier authentication unavailable");
    const response = await completeFn(
      request.model,
      {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: JSON.stringify(request.input) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        maxRetries: 0,
        maxTokens: 256,
        temperature: 0,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("classifier request failed");
    }
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return { text };
  };
}

// ---------------------------------------------------------------------------
// Strict config parsing (design section 7)
// ---------------------------------------------------------------------------

export type RouterMode = "off" | "shadow" | "active";

export interface ModelIdentityConfig {
  provider: string;
  id: string;
  supportsImages: boolean;
}

export interface ResolvedRouterConfig {
  version: 1;
  mode: RouterMode;
  models?: {
    classifier: ModelIdentityConfig[];
    weak: ModelIdentityConfig[];
  };
  classification: {
    ruleProfile: "conservative-v1";
    minWeakConfidence: number;
    timeoutMs: number;
    totalTimeoutMs: number;
    maxInputChars: number;
  };
  limits: {
    maxWeakContinuationTurns: number;
    maxNoProgressTurns: number;
    maxRepeatedOperationCount: number;
  };
  logging: {
    directory: string;
    maxReasonChars: number;
  };
  subPi: {
    enabled: boolean;
    maxConcurrent: number;
    timeoutMs: number;
  };
}

export type ParsedConfig =
  | { kind: "valid"; config: ResolvedRouterConfig }
  | { kind: "invalid"; errors: string[] };

export type ConfigResult =
  | { kind: "missing"; path: string }
  | { kind: "valid"; path: string; config: ResolvedRouterConfig }
  | { kind: "invalid"; path: string; errors: string[] };

export function getDefaultConfigPath(agentDir: string): string {
  return join(agentDir, "model-router.json");
}

// Implementation-defined numeric bounds (design 7.3 requires explicit ranges).
const BOUNDS = {
  classificationTimeoutMs: { min: 1, max: 600_000 },
  maxInputChars: { min: 1, max: 1_000_000 },
  turnOrCount: { min: 1, max: 1_000 },
  maxReasonChars: { min: 1, max: 10_000 },
  subPiTimeoutMs: { min: 1, max: 86_400_000 },
  subPiMaxConcurrent: { min: 1, max: 8 },
} as const;

type FieldCheck = (value: unknown, path: string, errors: string[]) => unknown;

function checkExactKeys(
  value: unknown,
  path: string,
  allowed: string[],
  errors: string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }
  return true;
}

function checkString(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function checkBoolean(value: unknown, path: string, errors: string[]): boolean | undefined {
  if (typeof value !== "boolean") {
    errors.push(`${path}: must be a boolean`);
    return undefined;
  }
  return value;
}

function checkIntInRange(
  value: unknown,
  path: string,
  range: { min: number; max: number },
  errors: string[],
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    errors.push(`${path}: must be an integer in [${range.min}, ${range.max}]`);
    return undefined;
  }
  return value;
}

function checkConfidence(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path}: must be a finite number in [0, 1]`);
    return undefined;
  }
  return value;
}

function parseModelIdentity(
  value: unknown,
  path: string,
  errors: string[],
): ModelIdentityConfig | undefined {
  if (!checkExactKeys(value, path, ["provider", "id", "supportsImages"], errors)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = checkString(record.provider, `${path}.provider`, errors);
  const id = checkString(record.id, `${path}.id`, errors);
  const supportsImages = checkBoolean(record.supportsImages, `${path}.supportsImages`, errors);
  if (provider === undefined || id === undefined || supportsImages === undefined) return undefined;
  return { provider, id, supportsImages };
}

function parseModelPool(
  value: unknown,
  path: string,
  errors: string[],
): ModelIdentityConfig[] | undefined {
  const rawItems = Array.isArray(value) ? value : [value];
  if (rawItems.length === 0) {
    errors.push(`${path}: must be a non-empty model identity or array`);
    return undefined;
  }
  const items = rawItems
    .map((item, index) => parseModelIdentity(item, Array.isArray(value) ? `${path}[${index}]` : path, errors))
    .filter((item): item is ModelIdentityConfig => item !== undefined);
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.provider}/${item.id}`;
    if (seen.has(key)) errors.push(`${path}: duplicate model identity ${key}`);
    seen.add(key);
  }
  return items.length === rawItems.length ? items : undefined;
}

function expandLogDirectory(directory: string, env: Record<string, string | undefined>): string {
  if (directory === "~" || directory.startsWith("~/")) {
    const home = env.HOME;
    if (home) return join(home, directory.slice(2));
  }
  return directory;
}

/**
 * Strict version 1 schema parser. Rejects unknown fields at every level and
 * never returns a partially usable config on error.
 */
export function parseModelRouterConfig(
  text: string,
  options: { agentDir: string; env?: Record<string, string | undefined> },
): ParsedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", errors: ["config is not valid JSON"] };
  }
  const errors: string[] = [];
  if (
    !checkExactKeys(
      raw,
      "config",
      ["version", "mode", "models", "classification", "limits", "logging", "subPi"],
      errors,
    )
  ) {
    return { kind: "invalid", errors };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) errors.push("config.version: must be exactly 1");
  const mode = record.mode;
  if (mode !== "off" && mode !== "shadow" && mode !== "active") {
    errors.push("config.mode: must be one of off|shadow|active");
  }

  let models: ResolvedRouterConfig["models"];
  if (record.models !== undefined) {
    if (checkExactKeys(record.models, "config.models", ["classifier", "weak"], errors)) {
      const modelsRecord = record.models as Record<string, unknown>;
      const roles: Record<string, ModelIdentityConfig[] | undefined> = {};
      for (const role of ["classifier", "weak"]) {
        if (modelsRecord[role] === undefined) {
          errors.push(`config.models.${role}: required`);
        } else {
          roles[role] = parseModelPool(modelsRecord[role], `config.models.${role}`, errors);
        }
      }
      if (roles.classifier && roles.weak) {
        models = { classifier: roles.classifier, weak: roles.weak };
      }
    }
  }
  if ((mode === "shadow" || mode === "active") && record.models === undefined) {
    errors.push("config.models: required when mode is shadow or active");
  }

  const classification = {
    ruleProfile: "conservative-v1" as const,
    minWeakConfidence: 0.9,
    timeoutMs: 20_000,
    totalTimeoutMs: 30_000,
    maxInputChars: 12_000,
  };
  if (record.classification !== undefined) {
    const path = "config.classification";
    if (
      checkExactKeys(
        record.classification,
        path,
        ["ruleProfile", "minWeakConfidence", "timeoutMs", "totalTimeoutMs", "maxInputChars"],
        errors,
      )
    ) {
      const c = record.classification as Record<string, unknown>;
      if (c.ruleProfile !== undefined && c.ruleProfile !== "conservative-v1") {
        errors.push(`${path}.ruleProfile: unsupported profile`);
      }
      if (c.minWeakConfidence !== undefined) {
        const v = checkConfidence(c.minWeakConfidence, `${path}.minWeakConfidence`, errors);
        if (v !== undefined) classification.minWeakConfidence = v;
      }
      if (c.timeoutMs !== undefined) {
        const v = checkIntInRange(c.timeoutMs, `${path}.timeoutMs`, BOUNDS.classificationTimeoutMs, errors);
        if (v !== undefined) classification.timeoutMs = v;
      }
      if (c.totalTimeoutMs !== undefined) {
        const v = checkIntInRange(
          c.totalTimeoutMs,
          `${path}.totalTimeoutMs`,
          BOUNDS.classificationTimeoutMs,
          errors,
        );
        if (v !== undefined) classification.totalTimeoutMs = v;
      }
      if (c.maxInputChars !== undefined) {
        const v = checkIntInRange(c.maxInputChars, `${path}.maxInputChars`, BOUNDS.maxInputChars, errors);
        if (v !== undefined) classification.maxInputChars = v;
      }
    }
  }

  const limits = {
    maxWeakContinuationTurns: 4,
    maxNoProgressTurns: 2,
    maxRepeatedOperationCount: 2,
  };
  if (record.limits !== undefined) {
    const path = "config.limits";
    if (
      checkExactKeys(
        record.limits,
        path,
        ["maxWeakContinuationTurns", "maxNoProgressTurns", "maxRepeatedOperationCount"],
        errors,
      )
    ) {
      const l = record.limits as Record<string, unknown>;
      for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
        if (l[key] !== undefined) {
          const v = checkIntInRange(l[key], `${path}.${key}`, BOUNDS.turnOrCount, errors);
          if (v !== undefined) limits[key] = v;
        }
      }
    }
  }

  const env = options.env ?? process.env;
  const logging = {
    directory: join(options.agentDir, "model-router-logs"),
    maxReasonChars: 240,
  };
  if (record.logging !== undefined) {
    const path = "config.logging";
    if (checkExactKeys(record.logging, path, ["directory", "maxReasonChars"], errors)) {
      const l = record.logging as Record<string, unknown>;
      if (l.directory !== undefined) {
        const v = checkString(l.directory, `${path}.directory`, errors);
        if (v !== undefined) logging.directory = expandLogDirectory(v, env);
      }
      if (l.maxReasonChars !== undefined) {
        const v = checkIntInRange(l.maxReasonChars, `${path}.maxReasonChars`, BOUNDS.maxReasonChars, errors);
        if (v !== undefined) logging.maxReasonChars = v;
      }
    }
  }

  const subPi = { enabled: false, maxConcurrent: 1, timeoutMs: 1_800_000 };
  if (record.subPi !== undefined) {
    const path = "config.subPi";
    if (checkExactKeys(record.subPi, path, ["enabled", "maxConcurrent", "timeoutMs"], errors)) {
      const s = record.subPi as Record<string, unknown>;
      if (s.enabled !== undefined) {
        const v = checkBoolean(s.enabled, `${path}.enabled`, errors);
        if (v !== undefined) subPi.enabled = v;
      }
      if (s.maxConcurrent !== undefined) {
        const v = checkIntInRange(s.maxConcurrent, `${path}.maxConcurrent`, BOUNDS.subPiMaxConcurrent, errors);
        if (v !== undefined) subPi.maxConcurrent = v;
      }
      if (s.timeoutMs !== undefined) {
        const v = checkIntInRange(s.timeoutMs, `${path}.timeoutMs`, BOUNDS.subPiTimeoutMs, errors);
        if (v !== undefined) subPi.timeoutMs = v;
      }
    }
  }

  if (errors.length > 0) return { kind: "invalid", errors };
  return {
    kind: "valid",
    config: {
      version: 1,
      mode: mode as RouterMode,
      models,
      classification,
      limits,
      logging,
      subPi,
    },
  };
}

export function loadConfig(
  fs: RouterFs,
  path: string,
  options: { agentDir: string; env?: Record<string, string | undefined> },
): ConfigResult {
  let raw: string;
  try {
    raw = fs.readTextFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { kind: "missing", path };
    }
    return { kind: "invalid", path, errors: [`config unreadable (${code ?? "io error"})`] };
  }
  const parsed = parseModelRouterConfig(raw, options);
  if (parsed.kind === "invalid") {
    return { kind: "invalid", path, errors: parsed.errors };
  }
  return { kind: "valid", path, config: parsed.config };
}

// ---------------------------------------------------------------------------
// Persistent role/model cooldown health store
// ---------------------------------------------------------------------------

export type ModelRole = "classifier" | "weak";
export const COOLDOWN_REASONS = [
  "not_found",
  "auth_missing",
  "image_capability_mismatch",
  "provider_error",
  "timeout",
  "empty_response",
  "invalid_protocol",
  "set_model_failed",
  "weak_model_error",
  "child_model_error",
] as const;
export type CooldownReason = typeof COOLDOWN_REASONS[number];

export interface ModelHealthEntry {
  role: ModelRole;
  provider: string;
  id: string;
  failedAt: number;
  retryAfter: number;
  reason: CooldownReason;
}

export interface ModelHealthStore {
  refresh(): void;
  getCooling(role: ModelRole, identity: Pick<ModelIdentityConfig, "provider" | "id">): ModelHealthEntry | undefined;
  markFailure(
    role: ModelRole,
    identity: Pick<ModelIdentityConfig, "provider" | "id">,
    reason: CooldownReason,
  ): ModelHealthEntry;
  listCooling(): ModelHealthEntry[];
}

const MODEL_COOLDOWN_MS = 1_800_000;

export function getModelHealthPath(agentDir: string): string {
  return join(agentDir, "model-router-health.json");
}

function healthKey(entry: Pick<ModelHealthEntry, "role" | "provider" | "id">): string {
  return `${entry.role}/${entry.provider}/${entry.id}`;
}

function parseHealthFile(text: string): ModelHealthEntry[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const errors: string[] = [];
  if (!checkExactKeys(raw, "health", ["version", "entries"], errors)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) return undefined;
  const entries: ModelHealthEntry[] = [];
  for (const value of record.entries) {
    if (!checkExactKeys(value, "health.entries[]", ["role", "provider", "id", "failedAt", "retryAfter", "reason"], errors)) {
      return undefined;
    }
    const item = value as Record<string, unknown>;
    if (item.role !== "classifier" && item.role !== "weak") return undefined;
    if (typeof item.provider !== "string" || !item.provider || typeof item.id !== "string" || !item.id) return undefined;
    if (!Number.isSafeInteger(item.failedAt) || !Number.isSafeInteger(item.retryAfter)) return undefined;
    if (!COOLDOWN_REASONS.includes(item.reason as CooldownReason)) return undefined;
    entries.push(item as unknown as ModelHealthEntry);
  }
  return errors.length === 0 ? entries : undefined;
}

function mergeHealthEntries(
  target: Map<string, ModelHealthEntry>,
  entries: ModelHealthEntry[],
  nowMs: number,
): void {
  for (const entry of entries) {
    if (entry.retryAfter <= nowMs) continue;
    const key = healthKey(entry);
    const current = target.get(key);
    if (!current || entry.retryAfter > current.retryAfter) target.set(key, { ...entry });
  }
}

export function createModelHealthStore(options: {
  fs: RouterFs;
  agentDir: string;
  now: () => Date;
  randomId: () => string;
  warn: (message: string) => void;
}): ModelHealthStore {
  const path = getModelHealthPath(options.agentDir);
  const memory = new Map<string, ModelHealthEntry>();
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    options.warn("model-router: health store unavailable; in-memory cooldown remains active");
  };
  const readDisk = (): ModelHealthEntry[] => {
    try {
      const entries = parseHealthFile(options.fs.readTextFile(path));
      if (!entries) {
        warnOnce();
        return [];
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnOnce();
      return [];
    }
  };
  const prune = (nowMs: number): void => {
    for (const [key, entry] of memory) {
      if (entry.retryAfter <= nowMs) memory.delete(key);
    }
  };
  const refresh = (): void => {
    const nowMs = options.now().getTime();
    prune(nowMs);
    mergeHealthEntries(memory, readDisk(), nowMs);
  };
  const persist = (): void => {
    const nowMs = options.now().getTime();
    prune(nowMs);
    const tempPath = `${path}.tmp-${options.randomId()}`;
    try {
      options.fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const entries = [...memory.values()].sort((a, b) => healthKey(a).localeCompare(healthKey(b)));
      options.fs.writeFile(tempPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
      options.fs.rename(tempPath, path);
    } catch {
      warnOnce();
      try { options.fs.remove?.(tempPath); } catch { /* best effort */ }
    }
  };
  return {
    refresh,
    getCooling(role, identity) {
      refresh();
      return memory.get(healthKey({ role, ...identity }));
    },
    markFailure(role, identity, reason) {
      if (!COOLDOWN_REASONS.includes(reason)) throw new Error("invalid cooldown reason");
      refresh();
      const failedAt = options.now().getTime();
      const entry = { role, ...identity, failedAt, retryAfter: failedAt + MODEL_COOLDOWN_MS, reason };
      const key = healthKey(entry);
      const current = memory.get(key);
      if (!current || entry.retryAfter >= current.retryAfter) memory.set(key, entry);
      persist();
      return memory.get(key) as ModelHealthEntry;
    },
    listCooling() {
      refresh();
      return [...memory.values()].map((entry) => ({ ...entry }));
    },
  };
}

// ---------------------------------------------------------------------------
// Task capsule: explicit fact extraction + strict validation (design 12)
// ---------------------------------------------------------------------------

export interface TaskCapsule {
  version: 1;
  taskId: string;
  objective: string;
  cwd: string;
  repositoryRoot: string;
  allowedRead: string[];
  allowedWrite: string[];
  forbidden: string[];
  steps: string[];
  expectedArtifacts: Array<{ path?: string; condition: string }>;
  verification: Array<{ command?: string; postcondition?: string }>;
}

export interface ExplicitFacts {
  objective?: string;
  allowedWrite: string[];
  allowedRead: string[];
  forbidden: string[];
  steps: string[];
  artifacts: string[];
  verification: string[];
  /** True when any recognized labeled section was present at all. */
  hasExplicitStructure: boolean;
}

export type CapsuleResult =
  | { status: "complete"; capsule: TaskCapsule }
  | { status: "incomplete"; reasons: string[] }
  | { status: "invalid_scope"; reasons: string[] }
  | { status: "ambiguous" };

/**
 * Extract only explicitly labeled facts from the prompt. Free text never
 * contributes scope, steps, artifacts or verification commands.
 */
export function extractExplicitFacts(prompt: string): ExplicitFacts {
  const facts: ExplicitFacts = {
    allowedWrite: [],
    allowedRead: [],
    forbidden: [],
    steps: [],
    artifacts: [],
    verification: [],
    hasExplicitStructure: false,
  };
  const lines = prompt.split("\n");
  let inSteps = false;
  const splitList = (rest: string): string[] =>
    rest
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  for (const line of lines) {
    const stepMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (inSteps && stepMatch) {
      facts.steps.push(stepMatch[1].trim());
      continue;
    }
    inSteps = false;
    const labelMatch = /^\s*(objective|allowed write|allowed read|forbidden|steps|artifacts|verification)\s*:\s*(.*)$/i.exec(
      line,
    );
    if (!labelMatch) continue;
    facts.hasExplicitStructure = true;
    const label = labelMatch[1].toLowerCase();
    const rest = labelMatch[2].trim();
    if (label === "objective") {
      if (rest) facts.objective = rest;
    } else if (label === "allowed write") {
      facts.allowedWrite.push(...splitList(rest));
    } else if (label === "allowed read") {
      facts.allowedRead.push(...splitList(rest));
    } else if (label === "forbidden") {
      facts.forbidden.push(...splitList(rest));
    } else if (label === "steps") {
      inSteps = true;
      if (rest) facts.steps.push(...splitList(rest));
    } else if (label === "artifacts") {
      facts.artifacts.push(...splitList(rest));
    } else if (label === "verification") {
      const command = /^`(.+)`$/.exec(rest)?.[1] ?? rest;
      if (command) facts.verification.push(command);
    }
  }
  return facts;
}

interface CapsuleContext {
  cwd: string;
  repositoryRoot: string;
  realpath: (path: string) => string;
  randomId: () => string;
}

function resolveThroughExistingParent(
  absolute: string,
  realpath: (path: string) => string,
): string | undefined {
  const suffix: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return join(realpath(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function resolveScopedPath(
  raw: string,
  ctx: CapsuleContext,
  problems: string[],
): string | undefined {
  const trimmed = raw.replace(/^"|"$/g, "").trim();
  if (!trimmed) {
    problems.push("empty path in scope");
    return undefined;
  }
  if (trimmed.split("/").some((part) => part === "..")) {
    problems.push("path traversal (`..`) in scope");
    return undefined;
  }
  const absolute = trimmed.startsWith("/") ? trimmed : join(ctx.cwd, trimmed);
  const rootPrefix = ctx.repositoryRoot.endsWith("/") ? ctx.repositoryRoot : `${ctx.repositoryRoot}/`;
  if (absolute !== ctx.repositoryRoot && !absolute.startsWith(rootPrefix)) {
    problems.push("path outside repository root");
    return undefined;
  }
  const real = resolveThroughExistingParent(absolute, ctx.realpath);
  if (real && real !== ctx.repositoryRoot && !real.startsWith(rootPrefix)) {
    problems.push("symlink escapes repository root");
    return undefined;
  }
  return absolute;
}

function looksLikePath(token: string): boolean {
  return token.includes("/") || /\.[a-z0-9]+$/i.test(token);
}

/**
 * Build a capsule from explicit facts only. Any uncertainty tightens scope or
 * pushes the request toward strong; nothing is guessed.
 */
export function buildTaskCapsule(prompt: string, ctx: CapsuleContext): CapsuleResult {
  const facts = extractExplicitFacts(prompt);
  if (!facts.hasExplicitStructure) {
    return { status: "ambiguous" };
  }
  const scopeProblems: string[] = [];
  const mapPaths = (rawPaths: string[]): string[] =>
    rawPaths
      .map((raw) => resolveScopedPath(raw, ctx, scopeProblems))
      .filter((p): p is string => p !== undefined);
  const allowedWrite = mapPaths(facts.allowedWrite);
  const allowedRead = mapPaths(facts.allowedRead);
  const forbidden = mapPaths(facts.forbidden);
  if (scopeProblems.length > 0) {
    return { status: "invalid_scope", reasons: scopeProblems };
  }

  const missing: string[] = [];
  if (!facts.objective) missing.push("objective missing");
  if (allowedWrite.length === 0) missing.push("allowed write scope empty");
  if (facts.steps.length === 0) missing.push("steps missing");
  if (facts.artifacts.length === 0) missing.push("expected artifacts missing");
  if (facts.verification.length === 0) missing.push("verification missing");
  for (const writePath of allowedWrite) {
    if (forbidden.some((f) => writePath === f || writePath.startsWith(`${f}/`))) {
      missing.push(`conflicting constraints: write scope overlaps forbidden (${writePath})`);
    }
  }
  if (missing.length > 0) {
    return { status: "incomplete", reasons: missing };
  }

  const artifactProblems: string[] = [];
  const expectedArtifacts = facts.artifacts.map((token) => {
    if (looksLikePath(token)) {
      const resolved = resolveScopedPath(token, ctx, artifactProblems);
      return { path: resolved, condition: "exists" };
    }
    return { condition: token };
  });
  if (artifactProblems.length > 0) {
    return { status: "invalid_scope", reasons: artifactProblems };
  }

  return {
    status: "complete",
    capsule: {
      version: 1,
      taskId: ctx.randomId(),
      objective: facts.objective as string,
      cwd: ctx.cwd,
      repositoryRoot: ctx.repositoryRoot,
      allowedRead,
      allowedWrite,
      forbidden,
      steps: facts.steps,
      expectedArtifacts,
      verification: facts.verification.map((command) => ({ command })),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic admission (design section 10 / conservative-v1 profile)
// ---------------------------------------------------------------------------

export type AdmissionVerdict = "eligible" | "strong" | "reject";

export interface AdmissionInput {
  prompt: string;
  imageCount: number;
  weakSupportsImages: boolean;
  maxInputChars: number;
  capsule: CapsuleResult;
}

export interface Admission {
  verdict: AdmissionVerdict;
  reasonCodes: string[];
  capsule?: TaskCapsule;
}

// conservative-v1 hard-rule detectors. These only push toward strong/reject.
const BROAD_ANALYSIS_PATTERN =
  /root cause|architecture|re-?design|re-?architect|open-ended|investigate why|investigate the|audit the entire|根因|架构|开放式|全面(分析|排查)|排查.*(原因|问题)/i;
const CROSS_BOUNDARY_PATTERN =
  /multiple repos|both repos|across (all |the )?(modules|repos|packages|services)|monorepo-wide|跨(模块|仓库|服务)|多个仓库/i;
const LONG_HORIZON_PATTERN =
  /keep .* consistent|long[- ]term|multi-week|migrate (all|every)|shared state across|保持.*一致|长期一致|全部迁移/i;
const INTENT_AMBIGUOUS_PATTERN =
  /or maybe|maybe keep|not sure|either .* or |choose between|要么.*要么|还是说|不确定(要|该)|二选一/i;
const SENSITIVE_PATTERN =
  /\bproduction\b|credential|secret|oauth token|api key|drop table|rm -rf|force[- ]push|irreversible|delete (all|every) |生产(环境|凭据|数据)|凭据|密钥|删库|不可逆/i;

const CROSS_BOUNDARY_MAX_TOP_LEVEL_DIRS = 3;
const LONG_HORIZON_MAX_STEPS = 5;

function topLevelSegments(paths: string[], repositoryRoot: string): Set<string> {
  const segments = new Set<string>();
  const rootPrefix = repositoryRoot.endsWith("/") ? repositoryRoot : `${repositoryRoot}/`;
  for (const path of paths) {
    if (!path.startsWith(rootPrefix)) continue;
    const relative = path.slice(rootPrefix.length);
    const first = relative.split("/")[0];
    if (first) segments.add(first);
  }
  return segments;
}

/**
 * Deterministic admission ahead of any classifier call. Rules may only make
 * the outcome more conservative; priority is reject > strong > eligible.
 */
export function evaluateAdmission(input: AdmissionInput): Admission {
  const reject = new Set<string>();
  const strong = new Set<string>();

  const hasImages = input.imageCount > 0;
  if (hasImages) {
    if (!input.weakSupportsImages) {
      strong.add("image_not_supported_by_weak");
    }
  }

  if (input.prompt.length > input.maxInputChars) strong.add("classifier_input_too_large");

  const capsule = input.capsule;
  if (capsule.status === "invalid_scope") {
    reject.add("invalid_capsule_scope");
  } else if (capsule.status === "ambiguous") {
    strong.add("scope_ambiguous");
  } else if (capsule.status === "incomplete") {
    for (const reason of capsule.reasons) {
      if (reason.includes("artifacts") || reason.includes("verification")) {
        strong.add("acceptance_missing");
      } else if (reason.includes("conflict")) {
        strong.add("intent_ambiguous");
      } else {
        strong.add("scope_ambiguous");
      }
    }
  }

  if (BROAD_ANALYSIS_PATTERN.test(input.prompt)) strong.add("broad_analysis_or_design");
  if (CROSS_BOUNDARY_PATTERN.test(input.prompt)) strong.add("cross_boundary_task");
  if (LONG_HORIZON_PATTERN.test(input.prompt)) strong.add("long_horizon_consistency");
  if (INTENT_AMBIGUOUS_PATTERN.test(input.prompt)) strong.add("intent_ambiguous");
  if (SENSITIVE_PATTERN.test(input.prompt)) strong.add("sensitive_or_irreversible");

  if (capsule.status === "complete") {
    const segments = topLevelSegments(
      [...capsule.capsule.allowedWrite],
      capsule.capsule.repositoryRoot,
    );
    if (segments.size > CROSS_BOUNDARY_MAX_TOP_LEVEL_DIRS) strong.add("cross_boundary_task");
    if (capsule.capsule.steps.length > LONG_HORIZON_MAX_STEPS) strong.add("long_horizon_consistency");
  }

  if (reject.size > 0) {
    return { verdict: "reject", reasonCodes: [...reject, ...strong].sort() };
  }
  if (strong.size > 0) {
    return { verdict: "strong", reasonCodes: [...strong].sort() };
  }
  if (capsule.status !== "complete") {
    // Defensive: never eligible without a complete capsule.
    return { verdict: "strong", reasonCodes: ["scope_ambiguous"] };
  }
  return { verdict: "eligible", reasonCodes: ["capsule_complete"], capsule: capsule.capsule };
}

// ---------------------------------------------------------------------------
// Classifier protocol (design section 11)
// ---------------------------------------------------------------------------

export const CLASSIFIER_RISK_FLAGS = [
  "ambiguous_scope",
  "cross_module",
  "long_horizon",
  "sensitive",
  "image_uncertain",
  "acceptance_uncertain",
] as const;

export const CLASSIFIER_REASON_CODES = [
  "localized_explicit_task",
  "broad_task",
  "uncertain_scope",
  "high_risk",
  "other",
] as const;

export interface ClassifierInput {
  protocolVersion: 1;
  requestId: string;
  promptExcerpt: string;
  cwd: string;
  imageMetadata: Array<{ mimeType: string }>;
  explicitPaths: string[];
  explicitSteps: string[];
  expectedArtifacts: string[];
  verification: string[];
  deterministicReasonCodes: string[];
}

export interface ClassifierResult {
  protocolVersion: 1;
  route: "weak" | "strong";
  confidence: number;
  riskFlags: string[];
  reasonCode: string;
}

export type ClassifierParse =
  | { ok: true; classification: ClassifierResult }
  | { ok: false; code: string };

export type Classification =
  | {
      status: "ok";
      classification: ClassifierResult;
      latencyMs?: number;
      classifierModel?: string;
      attemptCount?: number;
      failureCodes?: string[];
    }
  | {
      status: "failed";
      code: string;
      classifierModel?: string;
      attemptCount?: number;
      failureCodes?: string[];
    };

/**
 * Build the compact classification record. Never includes image binaries,
 * env vars, auth data, history or tool output.
 */
export function buildClassifierInput(options: {
  requestId: string;
  prompt: string;
  capsule: TaskCapsule;
  admission: Admission;
  imageMetadata?: Array<{ mimeType: string }>;
  maxInputChars: number;
}): ClassifierInput {
  const { capsule } = options;
  return {
    protocolVersion: 1,
    requestId: options.requestId,
    promptExcerpt: options.prompt.slice(0, options.maxInputChars),
    cwd: capsule.cwd,
    imageMetadata: (options.imageMetadata ?? []).map((image) => ({ mimeType: image.mimeType })),
    explicitPaths: [...capsule.allowedWrite, ...capsule.allowedRead],
    explicitSteps: [...capsule.steps],
    expectedArtifacts: capsule.expectedArtifacts.map((a) => a.path ?? a.condition),
    verification: capsule.verification.map((v) => v.command ?? v.postcondition ?? ""),
    deterministicReasonCodes: [...options.admission.reasonCodes],
  };
}

/**
 * Strict parser: exactly one bare JSON object with exact keys and closed enums.
 * Anything else fails with an enum code and no retained raw text.
 */
export function parseClassifierResponse(text: string): ClassifierParse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { ok: false, code: "not_single_json_object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: "malformed_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "not_single_json_object" };
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = ["protocolVersion", "route", "confidence", "riskFlags", "reasonCode"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || [...expectedKeys].sort().some((k, i) => keys[i] !== k)) {
    return { ok: false, code: "unexpected_fields" };
  }
  if (record.protocolVersion !== 1) return { ok: false, code: "protocol_mismatch" };
  if (record.route !== "weak" && record.route !== "strong") {
    return { ok: false, code: "invalid_route" };
  }
  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, code: "invalid_confidence" };
  }
  if (
    !Array.isArray(record.riskFlags) ||
    record.riskFlags.some((flag) => !CLASSIFIER_RISK_FLAGS.includes(flag as never))
  ) {
    return { ok: false, code: "invalid_risk_flags" };
  }
  if (!CLASSIFIER_REASON_CODES.includes(record.reasonCode as never)) {
    return { ok: false, code: "invalid_reason_code" };
  }
  return {
    ok: true,
    classification: {
      protocolVersion: 1,
      route: record.route,
      confidence,
      riskFlags: record.riskFlags as string[],
      reasonCode: record.reasonCode as string,
    },
  };
}

export interface RouteDecision {
  route: "weak" | "strong" | "reject";
  reasonCodes: string[];
}

/** Safe combination per design 11.3; classifier can never override hard rules. */
export function combineRouteDecision(
  admission: Pick<Admission, "verdict" | "reasonCodes">,
  classification: Classification | undefined,
  threshold: number,
): RouteDecision {
  if (admission.verdict === "reject") {
    return { route: "reject", reasonCodes: [...admission.reasonCodes] };
  }
  if (admission.verdict === "strong") {
    return { route: "strong", reasonCodes: [...admission.reasonCodes] };
  }
  if (!classification || classification.status === "failed") {
    return { route: "strong", reasonCodes: ["classifier_failure"] };
  }
  const result = classification.classification;
  if (result.route !== "weak") {
    return { route: "strong", reasonCodes: ["classifier_strong"] };
  }
  if (result.confidence < threshold) {
    return { route: "strong", reasonCodes: ["classifier_low_confidence"] };
  }
  if (result.riskFlags.length > 0) {
    return { route: "strong", reasonCodes: ["classifier_risk_flags"] };
  }
  return { route: "weak", reasonCodes: ["eligible_and_classifier_weak"] };
}

// ---------------------------------------------------------------------------
// Fixed model resolution and auth (design section 7.4 / gate 3)
// ---------------------------------------------------------------------------

export type RoleStatus = "ok" | "cooling_down" | "not_found" | "auth_missing" | "image_capability_mismatch";

export interface RoleReadiness {
  provider: string;
  id: string;
  status: RoleStatus;
  /** Effective capability: declared AND registry both support images. */
  supportsImages: boolean;
}

export interface ModelsReadiness {
  roles: { classifier: RoleReadiness; weak: RoleReadiness };
  /** True when active mode may be enabled (classifier and weak resolvable + auth ok). */
  activeReady: boolean;
  reasons: string[];
}

interface RegistryLike {
  find(provider: string, id: string): { input?: string[] } | undefined;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean }>;
}

export type CandidateFailureCode =
  | "cooling_down"
  | "not_found"
  | "auth_missing"
  | "image_capability_mismatch"
  | "image_not_supported"
  | "set_model_failed";

export type CandidateSelection =
  | {
      status: "ready";
      identity: ModelIdentityConfig;
      model: unknown;
      supportsImages: boolean;
      attemptCount: number;
      failureCodes: CandidateFailureCode[];
    }
  | {
      status: "exhausted" | "no_compatible_candidate";
      attemptCount: number;
      failureCodes: CandidateFailureCode[];
      nextRetryAfter?: number;
    };

export async function selectModelCandidate(options: {
  role: ModelRole;
  pool: ModelIdentityConfig[];
  registry: RegistryLike;
  health: ModelHealthStore;
  requireImages?: boolean;
}): Promise<CandidateSelection> {
  const failureCodes: CandidateFailureCode[] = [];
  let attemptCount = 0;
  let nextRetryAfter: number | undefined;
  let capabilitySkipped = false;
  for (const identity of options.pool) {
    if (options.requireImages && !identity.supportsImages) {
      capabilitySkipped = true;
      failureCodes.push("image_not_supported");
      continue;
    }
    const cooling = options.health.getCooling(options.role, identity);
    if (cooling) {
      failureCodes.push("cooling_down");
      nextRetryAfter = Math.min(nextRetryAfter ?? cooling.retryAfter, cooling.retryAfter);
      continue;
    }
    attemptCount += 1;
    const model = options.registry.find(identity.provider, identity.id);
    if (!model) {
      failureCodes.push("not_found");
      const entry = options.health.markFailure(options.role, identity, "not_found");
      nextRetryAfter = Math.min(nextRetryAfter ?? entry.retryAfter, entry.retryAfter);
      continue;
    }
    const registryImages = Array.isArray(model.input) && model.input.includes("image");
    if (identity.supportsImages && !registryImages) {
      failureCodes.push("image_capability_mismatch");
      const entry = options.health.markFailure(options.role, identity, "image_capability_mismatch");
      nextRetryAfter = Math.min(nextRetryAfter ?? entry.retryAfter, entry.retryAfter);
      continue;
    }
    let authReady = false;
    try {
      authReady = (await options.registry.getApiKeyAndHeaders(model)).ok;
    } catch {
      authReady = false;
    }
    if (!authReady) {
      failureCodes.push("auth_missing");
      const entry = options.health.markFailure(options.role, identity, "auth_missing");
      nextRetryAfter = Math.min(nextRetryAfter ?? entry.retryAfter, entry.retryAfter);
      continue;
    }
    return {
      status: "ready",
      identity: { ...identity },
      model,
      supportsImages: identity.supportsImages && registryImages,
      attemptCount,
      failureCodes,
    };
  }
  return {
    status: capabilitySkipped && attemptCount === 0 && nextRetryAfter === undefined
      ? "no_compatible_candidate"
      : "exhausted",
    attemptCount,
    failureCodes,
    ...(nextRetryAfter === undefined ? {} : { nextRetryAfter }),
  };
}

async function resolveRole(
  identity: ModelIdentityConfig,
  registry: RegistryLike,
): Promise<{ readiness: RoleReadiness; model: unknown }> {
  const base = { provider: identity.provider, id: identity.id };
  const model = registry.find(identity.provider, identity.id);
  if (!model) {
    return { readiness: { ...base, status: "not_found", supportsImages: false }, model: undefined };
  }
  const registryImages = Array.isArray(model.input) && model.input.includes("image");
  if (identity.supportsImages && !registryImages) {
    return {
      readiness: { ...base, status: "image_capability_mismatch", supportsImages: false },
      model,
    };
  }
  let auth: { ok: boolean };
  try {
    auth = await registry.getApiKeyAndHeaders(model);
  } catch {
    auth = { ok: false };
  }
  if (!auth.ok) {
    return { readiness: { ...base, status: "auth_missing", supportsImages: false }, model };
  }
  // Conservative: capability is the AND of declaration and registry.
  const supportsImages = identity.supportsImages && registryImages;
  return { readiness: { ...base, status: "ok", supportsImages }, model };
}

// ---------------------------------------------------------------------------
// Sub-pi tool, slot manager, and child runner (Gates 13-15)
// ---------------------------------------------------------------------------

export class SubPiError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.reasonCode = reasonCode;
    this.name = "SubPiError";
  }
}

export interface SlotManager {
  acquire(): boolean;
  release(): void;
  readonly activeCount: number;
  readonly maxConcurrent: number;
}

export function createSlotManager(maxConcurrent: number): SlotManager {
  let active = 0;
  return {
    acquire() {
      if (active >= maxConcurrent) return false;
      active++;
      return true;
    },
    release() {
      if (active > 0) active--;
    },
    get activeCount() { return active; },
    get maxConcurrent() { return maxConcurrent; },
  };
}

const subPiTaskSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  repositoryRoot: Type.String({ minLength: 1 }),
  allowedRead: Type.Array(Type.String()),
  allowedWrite: Type.Array(Type.String(), { minItems: 1 }),
  forbidden: Type.Array(Type.String()),
  steps: Type.Array(Type.String(), { minItems: 1 }),
  expectedArtifacts: Type.Array(Type.String(), { minItems: 1 }),
  verification: Type.Array(Type.String(), { minItems: 1 }),
}, { additionalProperties: false });

export type SubPiTaskParams = Static<typeof subPiTaskSchema>;

export interface SubPiInvocation {
  taskId: string;
  capsule: {
    objective: string;
    cwd: string;
    repositoryRoot: string;
    allowedRead: string[];
    allowedWrite: string[];
    forbidden: string[];
    steps: string[];
    expectedArtifacts: Array<{ path?: string; condition: string }>;
    verification: Array<{ command?: string; postcondition?: string }>;
  };
  weakModel: { provider: string; id: string };
  timeoutMs?: number;
}

export interface SubPiResult {
  status: "success" | "failure" | "timeout" | "aborted" | "error";
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
}

function buildCapsuleFromSubPiParams(
  params: SubPiTaskParams,
  randomId: () => string,
): TaskCapsule {
  const absolute = (path: string): string => path.startsWith("/") ? path : join(params.cwd, path);
  return {
    version: 1,
    taskId: randomId(),
    objective: params.objective,
    cwd: params.cwd,
    repositoryRoot: params.repositoryRoot,
    allowedRead: params.allowedRead.map(absolute),
    allowedWrite: params.allowedWrite.map(absolute),
    forbidden: params.forbidden.map(absolute),
    steps: params.steps,
    expectedArtifacts: params.expectedArtifacts.map((path: string) => ({ path: absolute(path), condition: "exists" })),
    verification: params.verification.map((command: string) => ({ command })),
  };
}

function validateSubPiPaths(
  params: SubPiTaskParams,
  ctx: CapsuleContext,
): { valid: true } | { valid: false; reason: string } {
  const allPaths: Array<{ p: string; kind: string }> = [
    ...params.allowedWrite.map((p: string) => ({ p, kind: "allowedWrite" })),
    ...params.allowedRead.map((p: string) => ({ p, kind: "allowedRead" })),
    ...params.forbidden.map((p: string) => ({ p, kind: "forbidden" })),
  ];

  for (const { p, kind } of allPaths) {
    if (!p.trim()) {
      return { valid: false, reason: `empty path in ${kind}` };
    }
    if (p.split("/").includes("..")) {
      return { valid: false, reason: `path traversal in ${kind}: ${p}` };
    }
    const absolute = p.startsWith("/") ? p : join(ctx.cwd, p);
    const rootPrefix = ctx.repositoryRoot.endsWith("/") ? ctx.repositoryRoot : `${ctx.repositoryRoot}/`;
    if (absolute !== ctx.repositoryRoot && !absolute.startsWith(rootPrefix)) {
      return { valid: false, reason: `path outside repository root in ${kind}: ${p}` };
    }
    const real = resolveThroughExistingParent(absolute, ctx.realpath);
    if (real && real !== ctx.repositoryRoot && !real.startsWith(rootPrefix)) {
      return { valid: false, reason: `symlink escapes repository root in ${kind}: ${p}` };
    }
    if (kind === "allowedWrite") {
      for (const f of params.forbidden) {
        const fAbs = f.startsWith("/") ? f : join(ctx.cwd, f);
        if (absolute === fAbs || absolute.startsWith(`${fAbs}/`)) {
          return { valid: false, reason: `write scope conflicts with forbidden: ${p}` };
        }
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Production tmux runner (Gate 14)
// ---------------------------------------------------------------------------

export interface TmuxOperations {
  newSession(sessionName: string, command: string): Promise<void>;
  hasSession(sessionName: string): Promise<boolean>;
  killSession(sessionName: string): Promise<void>;
}

/**
 * Create tmux operations that use the real tmux CLI.
 * All methods accept and return promises for injectability.
 * In tests, provide fake implementations via the deps.
 */
export function createProductionTmuxOps(): TmuxOperations {
  return {
    async newSession(sessionName: string, command: string) {
      execFileSync("tmux", ["new-session", "-d", "-s", sessionName, command], { timeout: 5000 });
    },
    async hasSession(sessionName: string) {
      try {
        execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore", timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    },
    async killSession(sessionName: string) {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore", timeout: 3000 });
      } catch {
        // Ignore cleanup failures
      }
    },
  };
}

function quoteShell(value: string): string {
  // Single-quote with proper escaping
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const COMPACT_COLLECTOR = `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.includes('"type":"message_end"')) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type !== "message_end" || !event.message) continue;
  const message = event.message;
  if (message.role === "assistant") {
    const text = (message.content ?? []).filter((block) => block.type === "text")
      .map((block) => block.text).join("\\n").slice(0, 20000);
    const observedTools = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
    const toolCalls = (message.content ?? [])
      .filter((block) => block.type === "toolCall" && observedTools.has(block.name))
      .map((block) => {
        const raw = block.arguments ?? {};
        const args = block.name === "bash"
          ? { command: typeof raw.command === "string" ? raw.command : "" }
          : { path: typeof raw.path === "string" ? raw.path :
              (typeof raw.file_path === "string" ? raw.file_path : "") };
        return { id: block.id, name: block.name, arguments: args };
      });
    process.stdout.write(JSON.stringify({ type: "assistant", provider: message.provider,
      model: message.model, stopReason: message.stopReason, text, toolCalls, usage: message.usage }) + "\\n");
  } else if (message.role === "toolResult") {
    process.stdout.write(JSON.stringify({ type: "toolResult", toolCallId: message.toolCallId,
      toolName: message.toolName, isError: message.isError }) + "\\n");
  }
}
`;

function buildRunScript(
  invocation: SubPiInvocation,
  weakModel: { provider: string; id: string },
  capsulePath: string,
  collectorPath: string,
  tmpDir: string,
  env: Record<string, string | undefined>,
): string {
  const lines = ["#!/bin/zsh", "set -u", "set -o pipefail", 'source "$HOME/.zshrc"'];
  lines.push(`cd ${quoteShell(invocation.capsule.cwd)} || exit 1`);
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY"]) {
    const value = env[key];
    if (value) lines.push(`export ${key}=${quoteShell(value)}`);
  }
  const modelArg = `${weakModel.provider}/${weakModel.id}`;
  const command = `pi --model ${quoteShell(modelArg)} --mode json --no-session --no-extensions -p ${quoteShell(`@${capsulePath}`)}`;
  lines.push(`${command} 2> ${quoteShell(join(tmpDir, "pi-run.log"))} | node ${quoteShell(collectorPath)} > ${quoteShell(join(tmpDir, "events.jsonl"))}`);
  lines.push("code=$?");
  lines.push(`printf '%s\\n' "$code" > ${quoteShell(join(tmpDir, "exit.code"))}`);
  lines.push('exit "$code"', "");
  return lines.join("\n");
}

function safeSlug(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || fallback).slice(0, 32);
}

function capsulePrompt(invocation: SubPiInvocation): string {
  return [
    "# Fixed-scope child task",
    "Execute only the following capsule. Read allowed files yourself. Do not widen scope.",
    "If blocked or unable to verify, report failure explicitly.",
    "",
    "```json",
    JSON.stringify(invocation.capsule, null, 2),
    "```",
    "",
  ].join("\n");
}

type CompactChildEvent = {
  type: "assistant" | "toolResult";
  stopReason?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  isError?: boolean;
};

function parseCompactEvents(raw: string): CompactChildEvent[] | undefined {
  const events: CompactChildEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line) as CompactChildEvent;
      if (event.type === "assistant" || event.type === "toolResult") events.push(event);
    } catch {
      return undefined;
    }
  }
  return events;
}

function verificationPassed(events: CompactChildEvent[], command: string): boolean {
  const callIds = new Set<string>();
  for (const event of events) {
    for (const call of event.toolCalls ?? []) {
      if (call.name === "bash" && call.arguments?.command === command) callIds.add(call.id);
    }
  }
  return events.some((event) => event.type === "toolResult" && !!event.toolCallId &&
    callIds.has(event.toolCallId) && event.isError === false);
}

function readChildResult(
  fs: RouterFs,
  tmpDir: string,
  invocation: SubPiInvocation,
): SubPiResult {
  const exitPath = join(tmpDir, "exit.code");
  const eventsPath = join(tmpDir, "events.jsonl");
  if (!fs.exists(exitPath) || !fs.exists(eventsPath)) {
    return { status: "failure", errorCode: "no_result", errorMessage: "child produced no result" };
  }
  const exitCode = Number(fs.readTextFile(exitPath).trim());
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    return { status: "failure", errorCode: "child_nonzero", errorMessage: "child process failed" };
  }
  const events = parseCompactEvents(fs.readTextFile(eventsPath));
  const assistants = events?.filter((event) => event.type === "assistant") ?? [];
  const final = assistants[assistants.length - 1];
  if (!events || !final) {
    return { status: "failure", errorCode: "no_compact_result", errorMessage: "child returned no assistant result" };
  }
  if (final.stopReason === "error") {
    return { status: "failure", errorCode: "weak_model_failure", errorMessage: "child model failed" };
  }
  if (final.stopReason === "aborted") {
    return { status: "aborted", errorCode: "child_aborted", errorMessage: "child task aborted" };
  }
  for (const event of assistants) {
    for (const call of event.toolCalls ?? []) {
      const scope = observeScope(call.name, call.arguments, invocation.capsule as TaskCapsule);
      if (scope.status === "out_of_scope") {
        return { status: "failure", errorCode: "scope_drift", errorMessage: "child left the allowed scope" };
      }
      if (scope.status === "uncertain") {
        return { status: "failure", errorCode: "scope_observation_uncertain", errorMessage: "child scope could not be verified" };
      }
    }
  }
  for (const artifact of invocation.capsule.expectedArtifacts) {
    if (!artifact.path) continue;
    const path = artifact.path.startsWith("/") ? artifact.path : join(invocation.capsule.cwd, artifact.path);
    if (!fs.exists(path)) {
      return { status: "failure", errorCode: "expected_artifact_missing", errorMessage: "expected artifact missing" };
    }
  }
  for (const verification of invocation.capsule.verification) {
    if (verification.command && !verificationPassed(events, verification.command)) {
      return { status: "failure", errorCode: "verification_failed", errorMessage: "verification did not pass" };
    }
  }
  return { status: "success", summary: final.text?.trim() || "child task completed" };
}

/**
 * Create a production child runner that uses tmux + real pi CLI.
 * All external operations (tmux, fs, timing) are injectable for testing.
 */
export function createProductionSubPiRunner(
  config: ResolvedRouterConfig,
  deps?: {
    fs?: RouterFs;
    tmuxOps?: TmuxOperations;
    now?: () => Date;
    randomId?: () => string;
    env?: Record<string, string | undefined>;
    sleep?: (milliseconds: number) => Promise<void>;
    warn?: (message: string) => void;
  },
): SubPiRunner {
  const fs = deps?.fs ?? createNodeFs();
  const tmuxOps = deps?.tmuxOps ?? createProductionTmuxOps();
  const now = deps?.now ?? (() => new Date());
  const randomId = deps?.randomId ?? (() => randomUUID());
  const env = deps?.env ?? process.env;
  const sleep = deps?.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const warn = deps?.warn ?? (() => {});

  return async (invocation: SubPiInvocation, signal?: AbortSignal): Promise<SubPiResult> => {
    const weakModel = invocation.weakModel;
    if (!weakModel?.provider || !weakModel.id) {
      return { status: "error", errorCode: "no_weak_model", errorMessage: "no weak model configured" };
    }
    const runId = safeSlug(randomId(), "run");
    const tmpDir = join(tmpdir(), `mr-${runId}`);
    const project = safeSlug(basename(invocation.capsule.repositoryRoot), "project");
    const task = safeSlug(invocation.taskId, "task").slice(0, 16);
    const sessionName = `pi-${project}-${task}`.slice(0, 64);
    fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });

    try {
      const capsulePath = join(tmpDir, "capsule.md");
      const collectorPath = join(tmpDir, "collector.mjs");
      const scriptPath = join(tmpDir, "run.zsh");
      fs.writeFile(capsulePath, capsulePrompt(invocation), { mode: 0o600 });
      fs.writeFile(collectorPath, COMPACT_COLLECTOR, { mode: 0o600 });
      fs.writeFile(
        scriptPath,
        buildRunScript(invocation, weakModel, capsulePath, collectorPath, tmpDir, env),
        { mode: 0o600 },
      );
      await tmuxOps.newSession(sessionName, `zsh ${quoteShell(scriptPath)}`);

      const deadline = now().getTime() + (invocation.timeoutMs ?? config.subPi.timeoutMs);
      while (now().getTime() < deadline) {
        if (signal?.aborted) {
          return { status: "aborted", errorCode: "child_aborted", errorMessage: "child task aborted" };
        }
        if (!(await tmuxOps.hasSession(sessionName))) {
          return readChildResult(fs, tmpDir, invocation);
        }
        await sleep(500);
      }
      return { status: "timeout", errorCode: "child_timeout", errorMessage: "child pi timed out" };
    } finally {
      await tmuxOps.killSession(sessionName).catch(() => warn("model-router: child tmux cleanup failed"));
      try {
        fs.remove?.(tmpDir);
      } catch {
        warn("model-router: child temporary directory cleanup failed");
      }
    }
  };
}

/**
 * Register the route_task_block tool for sub-pi delegation.
 * Returns an unregister function that marks the tool unavailable.
 */
export function registerSubPiTool(
  pi: ExtensionAPI,
  config: ResolvedRouterConfig,
  childRunner: SubPiRunner,
  randomId: () => string,
  _now: () => Date,
  _warn: (message: string) => void,
  fs: RouterFs,
  isEnabled: () => boolean = () => true,
  poolOptions?: {
    health?: ModelHealthStore;
    ensureAvailable?: (ctx: ExtensionContext) => Promise<boolean>;
    onExhausted?: () => Promise<void>;
  },
): () => void {
  const slotManager = createSlotManager(config.subPi.maxConcurrent);
  const transientHealth: ModelHealthStore = poolOptions?.health ?? {
    refresh() {}, getCooling() { return undefined; }, listCooling() { return []; },
    markFailure(role, identity, reason) {
      const failedAt = _now().getTime();
      return { role, ...identity, reason, failedAt, retryAfter: failedAt + MODEL_COOLDOWN_MS };
    },
  };
  let unregistered = false;
  const reject = (reasonCode: string, message: string): never => {
    throw new SubPiError(reasonCode, `[${reasonCode}] ${message}`);
  };

  pi.registerTool({
    name: "route_task_block",
    label: "Route Task Block",
    description: "Delegate a well-scoped task to a child pi process with a weaker model. " +
      "The task must have explicit objective, scope, steps, expected artifacts, and verification. " +
      "Additional fields are not accepted.",
    parameters: subPiTaskSchema,
    async execute(
      _toolCallId: string,
      params: SubPiTaskParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!isEnabled()) {
        reject("routing_off", "routing is disabled");
      }
      if (poolOptions?.ensureAvailable && !(await poolOptions.ensureAvailable(ctx))) {
        reject("routing_suspended", "routing is suspended until a configured model is eligible");
      }
      // 1. cwd consistency
      if (params.cwd !== ctx.cwd || params.repositoryRoot !== ctx.cwd) {
        reject("cwd_mismatch", "child cwd and repository root must match parent cwd");
      }

      // 2. Path validation (escape, cross-repo, conflict)
      const pathResult = validateSubPiPaths(params, {
        cwd: params.cwd,
        repositoryRoot: params.repositoryRoot,
        realpath: (p: string) => fs.realpath(p),
        randomId,
      });
      if (!pathResult.valid) {
        reject("invalid_capsule_scope", "child task scope is invalid");
      }

      // 3. Build capsule and run admission (broad, long, conflict patterns)
      const capsule = buildCapsuleFromSubPiParams(params, randomId);
      const promptForAdmission = [
        `Objective: ${params.objective}`,
        `Steps:\n${params.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`,
      ].join("\n");
      const admission = evaluateAdmission({
        prompt: promptForAdmission,
        imageCount: 0,
        weakSupportsImages: config.models?.weak[0]?.supportsImages ?? false,
        maxInputChars: config.classification.maxInputChars,
        capsule: { status: "complete", capsule },
      });
      if (admission.verdict !== "eligible") {
        reject("task_ineligible", admission.reasonCodes.join(", "));
      }

      // 4. Slot management
      if (!slotManager.acquire()) {
        reject("concurrent_limit", `max concurrent (${config.subPi.maxConcurrent}) reached`);
      }

      try {
        if (unregistered) reject("unregistered", "sub-pi tool is no longer available");
        if (!config.models?.weak.length) reject("no_weak_model", "no weak model configured");
        const taskId = randomId();
        const deadline = _now().getTime() + config.subPi.timeoutMs;
        let pool = [...config.models.weak];
        while (pool.length > 0) {
          const remaining = deadline - _now().getTime();
          if (remaining <= 0) reject("child_timeout", "child fallback budget exhausted");
          const selection = await selectModelCandidate({
            role: "weak", pool, registry: ctx.modelRegistry, health: transientHealth,
          });
          if (selection.status !== "ready") {
            await poolOptions?.onExhausted?.();
            reject("weak_pool_exhausted", "configured weak model pool is exhausted");
          }
          pool = pool.slice(pool.findIndex((item) => modelKey(item) === modelKey(selection.identity)) + 1);
          const invocation: SubPiInvocation = {
            taskId,
            capsule: {
              objective: capsule.objective, cwd: capsule.cwd, repositoryRoot: capsule.repositoryRoot,
              allowedRead: capsule.allowedRead, allowedWrite: capsule.allowedWrite,
              forbidden: capsule.forbidden, steps: capsule.steps,
              expectedArtifacts: capsule.expectedArtifacts, verification: capsule.verification,
            },
            weakModel: { provider: selection.identity.provider, id: selection.identity.id },
            timeoutMs: remaining,
          };
          let result: SubPiResult;
          try {
            result = await childRunner(invocation, signal);
          } catch (error) {
            if (error instanceof SubPiError) throw error;
            reject("child_runner_error", "child runner failed");
          }
          if (result.status === "success") {
            return {
              content: [{ type: "text" as const, text: result.summary ?? "task completed" }],
              details: { status: "success", taskId },
            };
          }
          const rawCode = result.errorCode ?? "child_failed";
          const errorCode = /^[a-z0-9_]+$/.test(rawCode) ? rawCode : "child_failed";
          const retryable = new Set(["weak_model_failure", "child_model_error", "child_timeout"]);
          if (!retryable.has(errorCode) || result.status === "aborted" || signal?.aborted) {
            reject(errorCode, "child task did not complete successfully");
          }
          transientHealth.markFailure("weak", selection.identity, "child_model_error");
        }
        if (deadline <= _now().getTime()) reject("child_timeout", "child fallback budget exhausted");
        await poolOptions?.onExhausted?.();
        reject("weak_pool_exhausted", "configured weak model pool is exhausted");
      } finally {
        slotManager.release();
      }
    },
  } as never);

  return () => {
    unregistered = true;
  };
}

/**
 * Resolve only the configured classifier/weak. Never searches for
 * alternatives; readiness holds identity, capability booleans and reason codes.
 */
export async function resolveConfiguredModels(
  config: ResolvedRouterConfig,
  registry: RegistryLike,
  mode: RouterMode,
  health?: ModelHealthStore,
): Promise<ModelsReadiness & {
  resolved: { classifier?: unknown; weak?: unknown };
  selections: { classifier: CandidateSelection; weak: CandidateSelection };
}> {
  if (!config.models) {
    throw new Error(`cannot resolve models: config has no models section (mode=${mode})`);
  }
  const transientHealth: ModelHealthStore = health ?? {
    refresh() {},
    getCooling() { return undefined; },
    markFailure(role, identity, reason) {
      const failedAt = Date.now();
      return { role, ...identity, reason, failedAt, retryAfter: failedAt + MODEL_COOLDOWN_MS };
    },
    listCooling() { return []; },
  };
  const classifier = await selectModelCandidate({
    role: "classifier",
    pool: config.models.classifier,
    registry,
    health: transientHealth,
  });
  const weak = await selectModelCandidate({
    role: "weak",
    pool: config.models.weak,
    registry,
    health: transientHealth,
  });
  const readiness = (selection: CandidateSelection, fallback: ModelIdentityConfig): RoleReadiness => {
    if (selection.status === "ready") {
      return { ...selection.identity, status: "ok", supportsImages: selection.supportsImages };
    }
    const status = selection.failureCodes.find((code) => code !== "cooling_down" && code !== "image_not_supported")
      ?? "cooling_down";
    return { provider: fallback.provider, id: fallback.id, status: status as RoleStatus, supportsImages: false };
  };
  const classifierReadiness = readiness(classifier, config.models.classifier[0]);
  const weakReadiness = readiness(weak, config.models.weak[0]);
  const reasons: string[] = [];
  if (classifier.status !== "ready") reasons.push("classifier_unavailable");
  if (weak.status !== "ready") reasons.push("weak_unavailable");
  return {
    roles: { classifier: classifierReadiness, weak: weakReadiness },
    activeReady: classifier.status === "ready" && weak.status === "ready",
    reasons,
    resolved: {
      classifier: classifier.status === "ready" ? classifier.model : undefined,
      weak: weak.status === "ready" ? weak.model : undefined,
    },
    selections: { classifier, weak },
  };
}

// ---------------------------------------------------------------------------
// Effect signals, progress and weak-lease evaluation (design sections 13-14)
// ---------------------------------------------------------------------------

export type ScopeStatus = "in_scope" | "out_of_scope" | "uncertain" | "no_path";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

function withinAny(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

/**
 * Observe (never intercept) a tool operation against the capsule scope.
 * Unresolvable bash/git targets are reported as uncertain, not safe.
 */
export function observeScope(
  toolName: string,
  input: Record<string, unknown>,
  capsule: TaskCapsule,
): { status: ScopeStatus } {
  if (PATH_TOOLS.has(toolName)) {
    const raw = typeof input.path === "string" ? (input.path as string) : undefined;
    if (!raw) return { status: "no_path" };
    const absolute = raw.startsWith("/") ? raw : join(capsule.cwd, raw);
    if (withinAny(absolute, capsule.forbidden)) return { status: "out_of_scope" };
    const scopes = WRITE_TOOLS.has(toolName)
      ? capsule.allowedWrite
      : [...capsule.allowedRead, ...capsule.allowedWrite];
    return { status: withinAny(absolute, scopes) ? "in_scope" : "out_of_scope" };
  }
  if (toolName === "bash") {
    const command = typeof input.command === "string" ? (input.command as string) : "";
    const normalized = command.trim();
    if (capsule.verification.some((v) => v.command !== undefined && v.command.trim() === normalized)) {
      return { status: "in_scope" };
    }
    const target = /(?:git\s+-C\s+|\bcd\s+)(\S+)/.exec(normalized)?.[1];
    if (target) {
      const absolute = target.startsWith("/") ? target : join(capsule.cwd, target);
      const root = capsule.repositoryRoot;
      const inside = absolute === root || absolute.startsWith(`${root}/`);
      return { status: inside ? "in_scope" : "out_of_scope" };
    }
    return { status: "uncertain" };
  }
  return { status: "no_path" };
}

/** Missing explicit expected artifacts (paths only; fs failure is a signal, not success). */
export function checkExpectedArtifacts(
  capsule: TaskCapsule,
  fsExists: (path: string) => boolean,
): { missing: string[] } {
  const missing: string[] = [];
  for (const artifact of capsule.expectedArtifacts) {
    if (!artifact.path) continue;
    let exists = false;
    try {
      exists = fsExists(artifact.path);
    } catch {
      exists = false;
    }
    if (!exists) missing.push(artifact.path);
  }
  return { missing };
}

export interface BatchItem {
  toolName: string;
  input: Record<string, unknown>;
  fingerprint: string;
  isError: boolean;
  exitCode: number | null;
  isVerification: boolean;
}

export interface EvaluatorState {
  operationCounts: Map<string, number>;
  progressMemo: Set<string>;
  noProgressCount: number;
  weakContinuationCount: number;
}

export interface BatchEvaluationInput {
  batch: BatchItem[];
  capsule?: TaskCapsule;
  limits: {
    maxWeakContinuationTurns: number;
    maxNoProgressTurns: number;
    maxRepeatedOperationCount: number;
  };
  state: EvaluatorState;
  target: ModelIdentityConfig | { provider: string; id: string } | null;
  actual: { provider: string; id: string } | null;
  fsExists: (path: string) => boolean;
}

export interface BatchEvaluation {
  hasToolBatch: boolean;
  signals: string[];
  progress: boolean;
}

function detectProgress(input: BatchEvaluationInput, newFingerprints: Set<string>): boolean {
  const { capsule, state } = input;
  let progress = false;
  if (capsule) {
    for (const artifact of capsule.expectedArtifacts) {
      if (!artifact.path) continue;
      const memoKey = `artifact:${artifact.path}`;
      let exists = false;
      try {
        exists = input.fsExists(artifact.path);
      } catch {
        exists = false;
      }
      if (exists && !state.progressMemo.has(memoKey)) {
        state.progressMemo.add(memoKey);
        progress = true;
      }
    }
  }
  for (const item of input.batch) {
    if (capsule && WRITE_TOOLS.has(item.toolName) && typeof item.input.path === "string") {
      const scope = observeScope(item.toolName, item.input, capsule);
      const memoKey = `modify:${item.input.path as string}`;
      if (scope.status === "in_scope" && !state.progressMemo.has(memoKey)) {
        state.progressMemo.add(memoKey);
        progress = true;
      }
    }
    const succeeded = !item.isError && (item.exitCode === null || item.exitCode === 0);
    if (item.isVerification && succeeded && !state.progressMemo.has("verification")) {
      state.progressMemo.add("verification");
      progress = true;
    }
    // Discovering a blocker for the first time (without repeating) is progress.
    if (!succeeded && newFingerprints.has(item.fingerprint)) {
      progress = true;
    }
  }
  return progress;
}

/**
 * Deterministic evaluation of one tool batch. Produces weak-lease release
 * signals and progress accounting; never intercepts tools and never calls a model.
 */
export function evaluateToolBatch(input: BatchEvaluationInput): BatchEvaluation {
  if (input.batch.length === 0) {
    return { hasToolBatch: false, signals: [], progress: false };
  }
  const signals = new Set<string>();
  const { state, limits, capsule } = input;
  const newFingerprints = new Set<string>();

  for (const item of input.batch) {
    const nonzero = item.exitCode !== null && item.exitCode !== 0;
    if (item.isVerification && (item.isError || nonzero)) signals.add("verification_failed");
    else if (item.isError) signals.add("tool_error");
    if (!item.isVerification && nonzero) signals.add("nonzero_exit");
    if (capsule) {
      const scope = observeScope(item.toolName, item.input, capsule);
      if (scope.status === "out_of_scope") signals.add("scope_drift");
      if (scope.status === "uncertain") signals.add("scope_observation_uncertain");
    }
    const count = (state.operationCounts.get(item.fingerprint) ?? 0) + 1;
    state.operationCounts.set(item.fingerprint, count);
    if (count === 1) newFingerprints.add(item.fingerprint);
    if (count > limits.maxRepeatedOperationCount) signals.add("repeated_operation");
  }

  if (capsule && input.batch.some((item) => item.isVerification)) {
    const missing = checkExpectedArtifacts(capsule, input.fsExists).missing;
    if (missing.length > 0) signals.add("expected_artifact_missing");
  }

  const progress = detectProgress(input, newFingerprints);
  if (progress) {
    state.noProgressCount = 0;
  } else {
    state.noProgressCount += 1;
    if (state.noProgressCount >= limits.maxNoProgressTurns) signals.add("no_progress_limit");
  }

  state.weakContinuationCount += 1;
  if (state.weakContinuationCount >= limits.maxWeakContinuationTurns) signals.add("weak_turn_limit");

  if (input.target && input.actual) {
    const targetKey = `${input.target.provider}/${input.target.id}`;
    const actualKey = `${input.actual.provider}/${input.actual.id}`;
    if (targetKey !== actualKey) signals.add("actual_model_mismatch");
  }
  return { hasToolBatch: true, signals: [...signals], progress };
}

// ---------------------------------------------------------------------------
// Audit record formatting (design section 16)
// ---------------------------------------------------------------------------

export interface ToolSummary {
  count: number;
  errors: number;
  nonzeroExits: number;
  operationHashes: string[];
}

export interface AuditRecordInput {
  timestamp: string;
  mode: RouterMode;
  sessionId: string;
  requestId: string;
  turnIndex: number;
  decisionKind: "initial" | "continuation" | "completion";
  admission: { verdict: AdmissionVerdict; reasonCodes: string[] };
  classification:
    | { status: "ok"; route: string; confidence: number; riskFlags: string[]; reasonCode: string; latencyMs: number | null;
        classifierModel?: string; attemptCount?: number; failureCodes?: string[] }
    | { status: "failed"; code: string; classifierModel?: string; attemptCount?: number; failureCodes?: string[] }
    | { status: "skipped" };
  targetModel: string | null;
  actualModel: string | null;
  reasonCodes: string[];
  toolSummary: ToolSummary;
  actualUsage: unknown;
  expectedAcceptanceHit: boolean | null;
  maxReasonChars: number;
}

/** Minimal, redacted audit record. Never receives prompt/tool/auth payloads. */
export function formatAuditRecord(input: AuditRecordInput): Record<string, unknown> {
  const trim = (value: string): string => value.slice(0, input.maxReasonChars);
  return {
    schemaVersion: 1,
    timestamp: input.timestamp,
    mode: input.mode,
    sessionId: input.sessionId,
    requestId: input.requestId,
    turnIndex: input.turnIndex,
    decisionKind: input.decisionKind,
    admission: {
      verdict: input.admission.verdict,
      reasonCodes: input.admission.reasonCodes.map(trim),
    },
    classification: input.classification,
    targetModel: input.targetModel,
    actualModel: input.actualModel,
    reasonCodes: input.reasonCodes.map(trim),
    toolSummary: input.toolSummary,
    providerLatencyMs: null,
    actualUsage: input.actualUsage ?? null,
    expectedAcceptanceHit: input.expectedAcceptanceHit,
  };
}

// ---------------------------------------------------------------------------
// Extension factory and runtime orchestration
// ---------------------------------------------------------------------------

type ModelIdentity = { provider: string; id: string };
type RuntimeModel = NonNullable<ExtensionContext["model"]>;

export type RouteState = "undecided" | "weak-lease";

interface ToolObservation {
  toolCallId: string;
  toolName: string;
  fingerprint: string;
  input: Record<string, unknown>;
  paths: string[];
  isVerification: boolean;
  isError: boolean;
  exitCode: number | null;
  bytes: number;
}

interface RequestState {
  requestId: string;
  turnIndex: number;
  routeState: RouteState;
  admission: { verdict: AdmissionVerdict; reasonCodes: string[] };
  classification: AuditRecordInput["classification"];
  decision: RouteDecision;
  capsule?: TaskCapsule;
  targetModel: ModelIdentity | null;
  leaseReturnModel?: RuntimeModel;
  weakContinuationCount: number;
  noProgressCount: number;
  operationCounts: Map<string, number>;
  progressMemo: Set<string>;
  signals: Set<string>;
  observations: Map<string, ToolObservation>;
  verificationSucceeded: boolean;
}

interface RuntimeState {
  configResult: ConfigResult;
  config?: ResolvedRouterConfig;
  configuredMode: RouterMode;
  runtimeMode: RouterMode;
  effectiveState: "off" | "off-error" | "shadow-ready" | "active-ready" | "suspended" | "restore-error" | "error";
  suspendedReason?: string;
  suspendedUntil?: number;
  activationModel?: ModelIdentity;
  handlersRegistered: boolean;
  readiness?: Awaited<ReturnType<typeof resolveConfiguredModels>>;
  request?: RequestState;
  sessionId?: string;
  lastActualModel?: ModelIdentity;
  logWarned: boolean;
}

function modelKey(model: ModelIdentity | null | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}

function classifierFailureReason(error: unknown): CooldownReason {
  const value = error as { name?: string; code?: string };
  return value?.name === "TimeoutError" || value?.code === "ETIMEDOUT" ? "timeout" : "provider_error";
}

export function createModelRouterExtension(dependencies: RouterDependencies = {}) {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const fs = dependencies.fs ?? createNodeFs();
  const configPath = getDefaultConfigPath(agentDir);
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => randomUUID());
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));
  const classify = dependencies.classify ?? createProductionClassifier();

  return function modelRouterFactory(pi: ExtensionAPI): void {
    const configResult = loadConfig(fs, configPath, { agentDir, env });
    const state: RuntimeState = {
      configResult,
      config: configResult.kind === "valid" ? configResult.config : undefined,
      configuredMode: configResult.kind === "valid" ? configResult.config.mode : "off",
      runtimeMode: "off",
      effectiveState: configResult.kind === "invalid" ? "off-error" : "off",
      handlersRegistered: false,
      logWarned: false,
    };
    const health = createModelHealthStore({ fs, agentDir, now, randomId, warn });

    // -----------------------------------------------------------------------
    // Audit logging (best effort, rate-limited warning)
    // -----------------------------------------------------------------------

    function appendAudit(record: Record<string, unknown>): void {
      const config = state.config;
      if (!config) return;
      try {
        const directory = config.logging.directory;
        fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const date = now().toISOString().slice(0, 10);
        const file = join(directory, `${date}.jsonl`);
        fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch {
        if (!state.logWarned) {
          state.logWarned = true;
          warn("model-router: audit log write failed; routing continues without logs");
        }
      }
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    async function ensureReadiness(ctx: ExtensionContext): Promise<RuntimeState["readiness"]> {
      if (state.config?.models) {
        state.readiness = await resolveConfiguredModels(
          state.config,
          ctx.modelRegistry,
          state.runtimeMode,
          health,
        );
      }
      return state.readiness;
    }

    function captureActivationModel(ctx: ExtensionContext): void {
      if (!state.activationModel && ctx.model) {
        state.activationModel = { provider: ctx.model.provider, id: ctx.model.id };
      }
    }

    function actualModelOf(ctx: ExtensionContext): ModelIdentity | null {
      return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    }

    function targetIdentity(
      route: RouteDecision["route"],
      selection: CandidateSelection | undefined,
    ): ModelIdentity | null {
      return route === "weak" && selection?.status === "ready"
        ? { provider: selection.identity.provider, id: selection.identity.id }
        : null;
    }

    async function switchWeakModel(
      ctx: ExtensionContext,
      requireImages: boolean,
    ): Promise<CandidateSelection> {
      const models = state.config?.models;
      if (!models) return { status: "exhausted", attemptCount: 0, failureCodes: [] };
      let pool = [...models.weak];
      const failureCodes: CandidateFailureCode[] = [];
      while (pool.length > 0) {
        const selection = await selectModelCandidate({
          role: "weak", pool, registry: ctx.modelRegistry, health, requireImages,
        });
        failureCodes.push(...selection.failureCodes);
        if (selection.status !== "ready") return { ...selection, failureCodes };
        pool = pool.slice(pool.findIndex((item) => modelKey(item) === modelKey(selection.identity)) + 1);
        let switched = false;
        try {
          switched = (await pi.setModel(selection.model as RuntimeModel)) !== false;
        } catch {
          switched = false;
        }
        if (switched) return { ...selection, failureCodes };
        health.markFailure("weak", selection.identity, "set_model_failed");
        failureCodes.push("set_model_failed");
      }
      return { status: "exhausted", attemptCount: 0, failureCodes };
    }

    function toolSummaryOf(observations: ToolObservation[]): ToolSummary {
      return {
        count: observations.length,
        errors: observations.filter((o) => o.isError).length,
        nonzeroExits: observations.filter((o) => o.exitCode !== null && o.exitCode !== 0).length,
        operationHashes: observations.map((o) => o.fingerprint),
      };
    }

    async function runClassifierAttempt(
      model: unknown,
      input: ClassifierInput,
      timeoutMs: number,
      ctx: ExtensionContext,
    ): Promise<
      | { kind: "ok"; classification: ClassifierResult }
      | { kind: "abort" }
      | { kind: "failure"; reason: CooldownReason; code: string }
    > {
      try {
        const response = (await classify({
          input,
          model,
          timeoutMs,
          signal: ctx.signal,
          getAuth: () => ctx.modelRegistry.getApiKeyAndHeaders(model as never),
        })) as { text?: string };
        const text = response?.text ?? "";
        if (!text.trim()) return { kind: "failure", reason: "empty_response", code: "empty_response" };
        const parsed = parseClassifierResponse(text);
        return parsed.ok
          ? { kind: "ok", classification: parsed.classification }
          : { kind: "failure", reason: "invalid_protocol", code: parsed.code };
      } catch (error) {
        if (ctx.signal?.aborted || (error as { name?: string })?.name === "AbortError") {
          return { kind: "abort" };
        }
        const reason = classifierFailureReason(error);
        return { kind: "failure", reason, code: reason };
      }
    }

    async function classifyEligible(
      admission: Admission,
      prompt: string,
      images: Array<{ mimeType: string }> | undefined,
      requestId: string,
      ctx: ExtensionContext,
    ): Promise<Classification> {
      const config = state.config as ResolvedRouterConfig;
      if (!admission.capsule || !config.models) return { status: "failed", code: "classifier_unavailable" };
      const input = buildClassifierInput({
        requestId,
        prompt,
        capsule: admission.capsule,
        admission,
        imageMetadata: (images ?? []).map((image) => ({ mimeType: image.mimeType })),
        maxInputChars: config.classification.maxInputChars,
      });
      const startedAt = now().getTime();
      const deadline = startedAt + config.classification.totalTimeoutMs;
      const failureCodes: string[] = [];
      let attemptCount = 0;
      let pool = [...config.models.classifier];
      let selected: ModelIdentityConfig | undefined;
      while (pool.length > 0) {
        const remaining = deadline - now().getTime();
        if (remaining <= 0) break;
        const selection = await selectModelCandidate({ role: "classifier", pool, registry: ctx.modelRegistry, health });
        failureCodes.push(...selection.failureCodes);
        if (selection.status !== "ready") break;
        selected = selection.identity;
        pool = pool.slice(pool.findIndex((item) => modelKey(item) === modelKey(selected)) + 1);
        attemptCount += 1;
        const result = await runClassifierAttempt(
          selection.model,
          input,
          Math.min(config.classification.timeoutMs, remaining),
          ctx,
        );
        if (result.kind === "abort") {
          return { status: "failed", code: "user_aborted", classifierModel: modelKey(selected) ?? undefined, attemptCount, failureCodes };
        }
        if (result.kind === "ok") {
          return { status: "ok", classification: result.classification, latencyMs: now().getTime() - startedAt,
            classifierModel: modelKey(selected) ?? undefined, attemptCount, failureCodes };
        }
        health.markFailure("classifier", selected, result.reason);
        failureCodes.push(result.code);
      }
      return { status: "failed", code: deadline <= now().getTime() ? "classifier_budget_exhausted" : "classifier_unavailable",
        classifierModel: modelKey(selected) ?? undefined, attemptCount, failureCodes };
    }

    function auditClassification(classification: Classification | undefined): AuditRecordInput["classification"] {
      if (!classification) return { status: "skipped" };
      const metadata = {
        ...(classification.classifierModel ? { classifierModel: classification.classifierModel } : {}),
        ...(classification.attemptCount === undefined ? {} : { attemptCount: classification.attemptCount }),
        ...(classification.failureCodes ? { failureCodes: classification.failureCodes } : {}),
      };
      if (classification.status === "failed") {
        return { status: "failed", code: classification.code, ...metadata };
      }
      const c = classification.classification;
      return {
        status: "ok",
        route: c.route,
        confidence: c.confidence,
        riskFlags: c.riskFlags,
        reasonCode: c.reasonCode,
        latencyMs: classification.latencyMs ?? null,
        ...metadata,
      };
    }

    function updateStatusBar(ctx: ExtensionContext): void {
      try {
        ctx.ui.setStatus("model-router", statusBarText(state));
      } catch {
        // UI-less modes may reject status updates; routing semantics unchanged.
      }
    }

    function earliestHealthRetry(): number | undefined {
      const retries = health.listCooling().map((entry) => entry.retryAfter);
      return retries.length > 0 ? Math.min(...retries) : undefined;
    }

    async function suspendRouter(reason: string): Promise<void> {
      await releaseWeakLease();
      state.effectiveState = "suspended";
      state.suspendedReason = reason;
      state.suspendedUntil = earliestHealthRetry();
    }

    async function ensureRouterAvailable(ctx: ExtensionContext): Promise<boolean> {
      if (state.effectiveState === "suspended" && state.suspendedUntil !== undefined &&
        now().getTime() < state.suspendedUntil) {
        return false;
      }
      const readiness = await ensureReadiness(ctx);
      if (!readiness?.activeReady) {
        const reason = readiness?.reasons[0] ?? "required_pool_exhausted";
        await suspendRouter(reason);
        return false;
      }
      if (state.effectiveState === "suspended") {
        state.effectiveState = state.runtimeMode === "active" ? "active-ready" : "shadow-ready";
        state.suspendedReason = undefined;
        state.suspendedUntil = undefined;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    async function onBeforeAgentStart(
      event: { prompt: string; images?: Array<{ mimeType: string }> },
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | void> {
      if (state.runtimeMode === "off" || !state.config?.models) return;
      if (state.runtimeMode === "active" && state.request?.routeState === "weak-lease") {
        await releaseWeakLease();
      }
      state.request = undefined;
      captureActivationModel(ctx);
      if (!(await ensureRouterAvailable(ctx))) {
        updateStatusBar(ctx);
        return;
      }
      const readiness = state.readiness;
      const requireImages = (event.images?.length ?? 0) > 0;
      const weakSelection = requireImages
        ? await selectModelCandidate({
            role: "weak",
            pool: state.config.models.weak,
            registry: ctx.modelRegistry,
            health,
            requireImages: true,
          })
        : readiness?.selections.weak;
      const requestId = randomId();
      const capsuleResult = buildTaskCapsule(event.prompt, {
        cwd: ctx.cwd,
        repositoryRoot: ctx.cwd,
        realpath: (p) => fs.realpath(p),
        randomId,
      });
      const admission = evaluateAdmission({
        prompt: event.prompt,
        imageCount: event.images?.length ?? 0,
        weakSupportsImages: requireImages ? weakSelection?.status === "ready" : true,
        maxInputChars: state.config.classification.maxInputChars,
        capsule: capsuleResult,
      });
      let classification: Classification | undefined;
      if (admission.verdict === "eligible") {
        classification = await classifyEligible(admission, event.prompt, event.images, requestId, ctx);
      }
      const decision = combineRouteDecision(
        admission,
        classification,
        state.config.classification.minWeakConfidence,
      );
      state.request = {
        requestId,
        turnIndex: 0,
        routeState: "undecided",
        admission: { verdict: admission.verdict, reasonCodes: admission.reasonCodes },
        classification: auditClassification(classification),
        decision,
        capsule: admission.capsule,
        targetModel: targetIdentity(decision.route, weakSelection),
        weakContinuationCount: 0,
        noProgressCount: 0,
        operationCounts: new Map(),
        progressMemo: new Set(),
        signals: new Set(),
        observations: new Map(),
        verificationSucceeded: false,
      };
      let hookResult: BeforeAgentStartEventResult | undefined;
      // === Gate 9: Active mode model switching ===
      if (classification?.status === "failed" && classification.code !== "user_aborted") {
        const refreshed = await ensureReadiness(ctx);
        if (!refreshed?.activeReady) await suspendRouter("classifier_pool_exhausted");
      }
      if (state.runtimeMode === "active" && state.effectiveState !== "suspended") {
        if (decision.route === "weak" && ctx.model) {
          const leaseReturnModel = ctx.model;
          const switched = await switchWeakModel(ctx, requireImages);
          if (switched.status === "ready") {
            state.request.targetModel = {
              provider: switched.identity.provider,
              id: switched.identity.id,
            };
            state.request.routeState = "weak-lease";
            state.request.leaseReturnModel = leaseReturnModel;
            if (admission.capsule) {
              const capsule = admission.capsule;
              hookResult = {
                message: {
                  customType: "model-router-capsule",
                  content: `objective: ${capsule.objective}\nallowed write: ${capsule.allowedWrite.join(", ")}\nexpected artifacts: ${capsule.expectedArtifacts.map((a) => a.path ?? a.condition).join(", ")}\nverification: ${capsule.verification.map((v) => v.command ?? v.postcondition ?? "").join(", ")}`,
                  display: false,
                },
              };
            }
          } else {
            state.request.targetModel = null;
            await suspendRouter("weak_pool_exhausted");
            warn("model-router: weak pool unavailable, router suspended");
          }
        } else if (decision.route === "reject") {
          state.effectiveState = "error";
          warn("model-router: request rejected by deterministic routing rules");
          ctx.abort();
        }
      }
      appendAudit(formatAuditRecord({
        timestamp: now().toISOString(),
        mode: state.runtimeMode,
        sessionId: ctx.sessionManager.getSessionId(),
        requestId,
        turnIndex: 0,
        decisionKind: "initial",
        admission: state.request.admission,
        classification: state.request.classification,
        targetModel: modelKey(state.request.targetModel),
        actualModel: modelKey(actualModelOf(ctx)),
        reasonCodes: state.request.decision.reasonCodes,
        toolSummary: { count: 0, errors: 0, nonzeroExits: 0, operationHashes: [] },
        actualUsage: null,
        expectedAcceptanceHit: null,
        maxReasonChars: state.config.logging.maxReasonChars,
      }));
      updateStatusBar(ctx);
      return hookResult;
    }

    function onToolCall(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }): void {
      const request = state.request;
      if (state.runtimeMode === "off" || state.effectiveState === "suspended" || !request) return;
      const observation: ToolObservation = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        fingerprint: fingerprintOperation(event.toolName, event.input),
        input: { ...event.input },
        paths: explicitPathsOf(event.toolName, event.input),
        isVerification: isVerificationCommand(event.toolName, event.input, request.capsule),
        isError: false,
        exitCode: null,
        bytes: 0,
      };
      request.observations.set(event.toolCallId, observation);
    }

    function onToolResult(event: {
      toolCallId: string;
      content: Array<{ type: string; text?: string }>;
      isError: boolean;
      details?: unknown;
    }): void {
      const request = state.request;
      if (state.runtimeMode === "off" || state.effectiveState === "suspended" || !request) return;
      const observation = request.observations.get(event.toolCallId);
      if (!observation) return;
      observation.isError = event.isError;
      observation.exitCode = extractExitCode(event.content, event.details);
      observation.bytes = event.content.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
      if (observation.isVerification && !observation.isError &&
        (observation.exitCode === null || observation.exitCode === 0)) {
        request.verificationSucceeded = true;
      }
    }

    async function onTurnEnd(
      event: { turnIndex: number; message: Record<string, unknown>; toolResults: Array<{ toolCallId: string }> },
      ctx: ExtensionContext,
    ): Promise<void> {
      const request = state.request;
      if (state.runtimeMode === "off" || state.effectiveState === "suspended" || !request || !state.config) return;
      const message = event.message as { provider?: string; model?: string; usage?: unknown; stopReason?: string };
      const actual = message.provider && message.model
        ? { provider: message.provider, id: message.model }
        : actualModelOf(ctx);
      if (actual) state.lastActualModel = actual;
      const batch = event.toolResults
        .map((result) => request.observations.get(result.toolCallId))
        .filter((observation): observation is ToolObservation => observation !== undefined);

      const weakResponseFailed = message.stopReason === "error";
      const weakResponseAborted = message.stopReason === "aborted";
      if (weakResponseFailed && request.routeState === "weak-lease") {
        if (request.targetModel) health.markFailure("weak", request.targetModel, "weak_model_error");
        request.signals.add("weak_model_failure");
        await releaseWeakLease();
      } else if (weakResponseAborted && request.routeState === "weak-lease") {
        request.signals.add("weak_model_aborted");
        await releaseWeakLease();
      }

      if (batch.length === 0) {
        const artifactsPresent = request.capsule
          ? checkExpectedArtifacts(request.capsule, (path) => fs.exists(path)).missing.length === 0
          : false;
        appendAudit(formatAuditRecord({
          timestamp: now().toISOString(),
          mode: state.runtimeMode,
          sessionId: ctx.sessionManager.getSessionId(),
          requestId: request.requestId,
          turnIndex: event.turnIndex,
          decisionKind: "completion",
          admission: request.admission,
          classification: request.classification,
          targetModel: modelKey(request.targetModel),
          actualModel: modelKey(actual),
          reasonCodes: request.decision.reasonCodes,
          toolSummary: { count: 0, errors: 0, nonzeroExits: 0, operationHashes: [] },
          actualUsage: message.usage ?? null,
          expectedAcceptanceHit: request.verificationSucceeded && artifactsPresent,
          maxReasonChars: state.config.logging.maxReasonChars,
        }));
        updateStatusBar(ctx);
        return;
      }

      request.turnIndex = event.turnIndex;
      const shouldEvaluate = request.decision.route === "weak" &&
        (state.runtimeMode === "shadow" || request.routeState === "weak-lease");
      if (shouldEvaluate) {
        const evalState = {
          operationCounts: request.operationCounts,
          progressMemo: request.progressMemo,
          noProgressCount: request.noProgressCount,
          weakContinuationCount: request.weakContinuationCount,
        };
        const evaluation = evaluateToolBatch({
          batch: batch.map((observation) => ({
            toolName: observation.toolName,
            input: observation.input,
            fingerprint: observation.fingerprint,
            isError: observation.isError,
            exitCode: observation.exitCode,
            isVerification: observation.isVerification,
          })),
          capsule: request.capsule,
          limits: state.config.limits,
          state: evalState,
          target: state.runtimeMode === "active" ? request.targetModel : null,
          actual: state.runtimeMode === "active" ? actual : null,
          fsExists: (path) => fs.exists(path),
        });
        request.noProgressCount = evalState.noProgressCount;
        request.weakContinuationCount = evalState.weakContinuationCount;
        for (const signal of evaluation.signals) request.signals.add(signal);
        if (state.runtimeMode === "active" && evaluation.signals.length > 0) {
          await releaseWeakLease();
        }
      }

      const artifactsPresent = request.capsule
        ? checkExpectedArtifacts(request.capsule, (path) => fs.exists(path)).missing.length === 0
        : false;
      appendAudit(formatAuditRecord({
        timestamp: now().toISOString(),
        mode: state.runtimeMode,
        sessionId: ctx.sessionManager.getSessionId(),
        requestId: request.requestId,
        turnIndex: event.turnIndex,
        decisionKind: "continuation",
        admission: request.admission,
        classification: request.classification,
        targetModel: modelKey(request.targetModel),
        actualModel: modelKey(actual),
        reasonCodes: request.decision.reasonCodes,
        toolSummary: toolSummaryOf(batch),
        actualUsage: message.usage ?? null,
        expectedAcceptanceHit: request.verificationSucceeded && artifactsPresent,
        maxReasonChars: state.config.logging.maxReasonChars,
      }));
      for (const result of event.toolResults) request.observations.delete(result.toolCallId);
      updateStatusBar(ctx);
    }

    async function onAgentEnd(ctx: ExtensionContext): Promise<void> {
      const request = state.request;
      if (state.runtimeMode === "off" || state.effectiveState === "suspended" || !request || request.decision.route !== "weak") return;
      const missingArtifacts = request.capsule
        ? checkExpectedArtifacts(request.capsule, (path) => fs.exists(path)).missing.length > 0
        : false;
      if (missingArtifacts) request.signals.add("expected_artifact_missing");
      if (request.capsule?.verification.length && !request.verificationSucceeded) {
        request.signals.add("acceptance_missing_after_work");
      }
      if (state.config && request.signals.size > 0) {
        appendAudit(formatAuditRecord({
          timestamp: now().toISOString(),
          mode: state.runtimeMode,
          sessionId: ctx.sessionManager.getSessionId(),
          requestId: request.requestId,
          turnIndex: request.turnIndex,
          decisionKind: "continuation",
          admission: request.admission,
          classification: request.classification,
          targetModel: modelKey(request.targetModel),
          actualModel: modelKey(actualModelOf(ctx)),
          reasonCodes: request.decision.reasonCodes,
          toolSummary: { count: 0, errors: 0, nonzeroExits: 0, operationHashes: [] },
          actualUsage: null,
          expectedAcceptanceHit: false,
          maxReasonChars: state.config.logging.maxReasonChars,
        }));
      }
      await releaseWeakLease();
      updateStatusBar(ctx);
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    function registerRoutingHandlers(): void {
      if (state.handlersRegistered) return;
      state.handlersRegistered = true;
      pi.on("before_agent_start", (event, ctx) => onBeforeAgentStart(event as never, ctx));
      pi.on("tool_call", (event) => {
        onToolCall(event as never);
        return undefined;
      });
      pi.on("tool_result", (event) => {
        onToolResult(event as never);
        return undefined;
      });
      pi.on("turn_end", (event, ctx) => onTurnEnd(event as never, ctx));
      pi.on("agent_end", (_event, ctx) => onAgentEnd(ctx));
    }

    if (state.config) {
      if (state.config.mode !== "off") {
        state.runtimeMode = state.config.mode;
        state.effectiveState = state.config.mode === "shadow" ? "shadow-ready" : "active-ready";
        registerRoutingHandlers();
      }
      if (state.config.subPi.enabled) {
        const runner = dependencies.childRunner ??
          createProductionSubPiRunner(state.config, { fs, now, randomId, env, warn });
        registerSubPiTool(
          pi,
          state.config,
          runner,
          randomId,
          now,
          warn,
          fs,
          () => state.runtimeMode !== "off",
          {
            health,
            ensureAvailable: (ctx) => ensureRouterAvailable(ctx),
            onExhausted: () => suspendRouter("weak_pool_exhausted"),
          },
        );
      }
    }

    pi.registerCommand("routing", {
      description: "Model router: off | shadow | active | status",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const arg = args.trim().toLowerCase();
        if (arg === "status" || arg === "") {
          reportStatus(state, configPath, ctx);
          return;
        }
        if (arg === "off") {
          await cmdOff(ctx);
          return;
        }
        if (arg === "shadow") {
          await cmdShadow(ctx);
          return;
        }
        if (arg === "active") {
          await cmdActive(ctx);
          return;
        }
        notify(ctx, `usage: /routing off|shadow|active|status`, "info");
      },
    });

    // -----------------------------------------------------------------------
    // Gate 10: Runtime mode switching
    // -----------------------------------------------------------------------

    async function applySetModel(target: ModelIdentity | null, ctx: ExtensionContext): Promise<boolean> {
      if (!target) return false;
      const model = ctx.modelRegistry.find(target.provider, target.id);
      if (!model) return false;
      try {
        return (await pi.setModel(model)) !== false;
      } catch {
        return false;
      }
    }

    async function releaseWeakLease(): Promise<boolean> {
      const request = state.request;
      if (state.runtimeMode !== "active" || request?.routeState !== "weak-lease") return true;

      const returnModel = request.leaseReturnModel;
      request.routeState = "undecided";
      request.leaseReturnModel = undefined;
      if (!returnModel) {
        warn("model-router: weak lease return model missing; lease ended without fallback");
        return false;
      }

      let restored = false;
      try {
        restored = (await pi.setModel(returnModel)) !== false;
      } catch {
        restored = false;
      }
      if (!restored) {
        warn("model-router: weak lease return model restore failed; lease ended without fallback");
      }
      return restored;
    }

    async function captureAndRegisterHandlers(): Promise<void> {
      if (!state.handlersRegistered) {
        registerRoutingHandlers();
      }
    }

    async function cmdOff(ctx: ExtensionCommandContext): Promise<void> {
      await ctx.waitForIdle();
      let restoreFailed = false;
      if (state.activationModel) {
        restoreFailed = !(await applySetModel(state.activationModel, ctx));
      }
      state.runtimeMode = "off";
      state.effectiveState = restoreFailed ? "restore-error" : "off";
      state.suspendedReason = undefined;
      state.suspendedUntil = undefined;
      state.request = undefined;
      state.lastActualModel = undefined;
      state.readiness = undefined;
      pi.appendEntry("model-router-state", {
        version: 1,
        mode: "off",
        activationModel: state.activationModel ? { ...state.activationModel } : null,
      });
      try { ctx.ui.setStatus("model-router", undefined); } catch { /* no-op */ }
      if (restoreFailed) {
        notify(ctx, "model-router: off - activation model restore failed (restore-error)", "error");
      } else {
        state.activationModel = undefined;
        notify(ctx, "model-router: off", "info");
      }
    }

    async function cmdShadow(ctx: ExtensionCommandContext): Promise<void> {
      if (!state.config?.models) {
        notify(ctx, "model-router: no configured models; cannot enable shadow mode", "error");
        return;
      }
      if (state.runtimeMode === "active" && state.activationModel) {
        await ctx.waitForIdle();
        if (!(await applySetModel(state.activationModel, ctx))) {
          state.runtimeMode = "off";
          state.effectiveState = "restore-error";
          notify(ctx, "model-router: cannot enter shadow - activation model restore failed", "error");
          return;
        }
      }
      await captureAndRegisterHandlers();
      captureActivationModel(ctx);
      state.runtimeMode = "shadow";
      if (state.effectiveState !== "suspended") state.effectiveState = "shadow-ready";
      const available = await ensureRouterAvailable(ctx);
      pi.appendEntry("model-router-state", {
        version: 1,
        mode: "shadow",
        activationModel: state.activationModel ? { provider: state.activationModel.provider, id: state.activationModel.id } : null,
      });
      notify(ctx, available ? "model-router: shadow mode enabled" : "model-router: shadow intent preserved; router suspended", available ? "info" : "warning");
    }

    async function cmdActive(ctx: ExtensionCommandContext): Promise<void> {
      if (!state.config?.models) {
        notify(ctx, "model-router: no configured models; cannot enable active mode", "error");
        return;
      }
      if (state.runtimeMode === "active" && state.effectiveState === "active-ready") {
        notify(ctx, "model-router: already active", "info");
        return;
      }
      if (state.runtimeMode !== "off" && state.runtimeMode !== "active" && state.activationModel) {
        await ctx.waitForIdle();
        await applySetModel(state.activationModel, ctx);
      }
      await captureAndRegisterHandlers();
      captureActivationModel(ctx);
      state.runtimeMode = "active";
      if (state.effectiveState !== "suspended") state.effectiveState = "active-ready";
      const available = await ensureRouterAvailable(ctx);
      pi.appendEntry("model-router-state", {
        version: 1,
        mode: "active",
        activationModel: state.activationModel ? { provider: state.activationModel.provider, id: state.activationModel.id } : null,
      });
      notify(ctx, available ? "model-router: active mode enabled" : "model-router: active intent preserved; router suspended (models unavailable)", available ? "info" : "warning");
    }

    // -----------------------------------------------------------------------
    // Gate 11: Session persistence
    // -----------------------------------------------------------------------

    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      state.request = undefined;
      state.lastActualModel = undefined;
      state.activationModel = undefined;
      state.logWarned = false;
      state.readiness = undefined;
      state.sessionId = ctx.sessionManager.getSessionId();
      state.runtimeMode = state.config?.models ? state.configuredMode : "off";
      state.effectiveState = state.runtimeMode === "active"
        ? "active-ready"
        : state.runtimeMode === "shadow" ? "shadow-ready" : "off";
      try {
        const entries = ctx.sessionManager.getBranch();
        const routerEntries = entries
          .filter((entry: { customType?: string }) => entry?.customType === "model-router-state")
          .map((entry: { data?: unknown }) => entry?.data);
        const data = routerEntries[routerEntries.length - 1] as Record<string, unknown> | undefined;
        const mode = data?.mode;
        if (data?.version === 1 && (mode === "off" || mode === "shadow" || mode === "active")) {
          state.runtimeMode = mode === "off" || state.config?.models ? mode : "off";
          state.effectiveState = state.runtimeMode === "active"
            ? "active-ready"
            : state.runtimeMode === "shadow" ? "shadow-ready" : "off";
          const activation = data.activationModel as { provider?: unknown; id?: unknown } | null;
          if (activation && typeof activation.provider === "string" && typeof activation.id === "string") {
            state.activationModel = { provider: activation.provider, id: activation.id };
          }
        }
      } catch {
        warn("model-router: ignored malformed persisted state");
      }
      if (state.runtimeMode !== "off") registerRoutingHandlers();
    });

    pi.on("model_select", (event: { model: { provider: string; id: string } }) => {
      state.lastActualModel = { provider: event.model.provider, id: event.model.id };
    });

    pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
      if (state.runtimeMode === "active" && state.activationModel) {
        if (!(await applySetModel(state.activationModel, ctx))) {
          const message = "model-router: activation model restore failed during session shutdown";
          warn(message);
          notify(ctx, message, "error");
        }
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Tool observation helpers (shared with the gate 8 evaluator)
// ---------------------------------------------------------------------------

/** Irreversible fingerprint of a normalized tool operation. */
export function fingerprintOperation(toolName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ toolName, input: sortKeysDeep(input) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function explicitPathsOf(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof input[key] === "string") paths.push(input[key] as string);
  }
  return paths;
}

function isVerificationCommand(
  toolName: string,
  input: Record<string, unknown>,
  capsule: TaskCapsule | undefined,
): boolean {
  if (!capsule || toolName !== "bash" || typeof input.command !== "string") return false;
  const normalized = (input.command as string).trim();
  return capsule.verification.some((v) => v.command !== undefined && v.command.trim() === normalized);
}

function extractExitCode(
  content: Array<{ type: string; text?: string }>,
  details: unknown,
): number | null {
  const detailExit = (details as { exitCode?: unknown } | undefined)?.exitCode;
  if (typeof detailExit === "number") return detailExit;
  for (const block of content) {
    const match = /Command exited with code (\d+)/.exec(block.text ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status bar / command output
// ---------------------------------------------------------------------------

function statusBarText(state: RuntimeState): string | undefined {
  if (state.runtimeMode === "off") return undefined;
  if (state.effectiveState === "suspended") {
    const retry = state.suspendedUntil === undefined
      ? "unknown"
      : `${Math.max(0, Math.ceil((state.suspendedUntil - Date.now()) / 60_000))}m`;
    return `routing:suspended · retry=${retry}`;
  }
  const request = state.request;
  if (state.runtimeMode === "shadow") {
    const target = request?.decision.route ?? "-";
    return `routing:shadow · target=${target}`;
  }
  if (request?.routeState === "weak-lease") {
    const cap = state.config?.limits.maxWeakContinuationTurns ?? 0;
    return `routing:active · weak · turn=${request.weakContinuationCount}/${cap}`;
  }
  return `routing:active · strong`;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // Non-UI modes may not support notifications; state is still consistent.
  }
}

function reportStatus(state: RuntimeState, configPath: string, ctx: ExtensionCommandContext): void {
  const lines = [
    `model-router config: ${configPath}`,
    `configured mode: ${state.configuredMode}`,
    `effective mode: ${state.runtimeMode}`,
    `state: ${state.effectiveState}`,
  ];
  const models = state.config?.models;
  if (models) {
    lines.push(`classifier model: ${models.classifier[0].provider}/${models.classifier[0].id}`);
    lines.push(`weak model: ${models.weak[0].provider}/${models.weak[0].id}`);
  }
  if (state.config) {
    lines.push(`log directory: ${state.config.logging.directory}`);
    lines.push(`sub-pi: ${state.config.subPi.enabled ? "enabled" : "disabled"}`);
  }
  if (state.effectiveState === "suspended") {
    lines.push(`suspended reason: ${state.suspendedReason ?? "required_pool_exhausted"}`);
    if (state.suspendedUntil !== undefined) {
      lines.push(`suspended retry after: ${new Date(state.suspendedUntil).toISOString()}`);
    }
  }
  if (state.activationModel) {
    lines.push(`activation model: ${state.activationModel.provider}/${state.activationModel.id}`);
  }
  const request = state.request;
  if (request) {
    if (request.routeState !== "undecided") {
      lines.push(`route: ${request.routeState}`);
    }
    if (request.targetModel) {
      lines.push(`target model: ${request.targetModel.provider}/${request.targetModel.id}`);
    }

  }
  if (state.configResult.kind === "invalid") {
    lines.push(`config errors: ${state.configResult.errors.join("; ")}`);
  }
  notify(ctx, lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Production default export
// ---------------------------------------------------------------------------

export default function modelRouter(pi: ExtensionAPI): void {
  const factory = createModelRouterExtension({
    now: () => new Date(),
    randomId: () => randomUUID(),
    env: process.env,
  });
  factory(pi);
}
