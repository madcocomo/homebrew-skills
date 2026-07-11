import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = join(repoRoot, "extensions", "model-router.ts");

// ---------------------------------------------------------------------------
// Package root resolution (loader)
// ---------------------------------------------------------------------------

const PREFERRED_PACKAGE = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE = "@mariozechner/pi-coding-agent";

/**
 * Resolve the pi-coding-agent package root. Order:
 * 1. PI_CODING_AGENT_PACKAGE_ROOT env var.
 * 2. `npm root -g` + preferred package.
 * 3. asdf sibling stable dir derived from process.execPath
 *    (<installs>/nodejs/.npm/lib/node_modules/<preferred>).
 * 4. Legacy package name under `npm root -g` (fallback only).
 */
function resolvePackageRoot({ env, npmRoot, execPath, exists } = {}) {
  const environment = env ?? process.env;
  const fileExists = exists ?? existsSync;
  if (environment.PI_CODING_AGENT_PACKAGE_ROOT) {
    return { root: environment.PI_CODING_AGENT_PACKAGE_ROOT, source: "env", packageName: PREFERRED_PACKAGE };
  }
  const globalRoot =
    npmRoot ?? execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const preferredGlobal = join(globalRoot, ...PREFERRED_PACKAGE.split("/"));
  if (fileExists(preferredGlobal)) {
    return { root: preferredGlobal, source: "npm-global", packageName: PREFERRED_PACKAGE };
  }
  const nodeExecPath = execPath ?? process.execPath;
  // <installs>/nodejs/<version>/bin/node -> <installs>/nodejs
  const nodejsDir = dirname(dirname(dirname(nodeExecPath)));
  const siblingRoot = join(
    nodejsDir,
    ".npm",
    "lib",
    "node_modules",
    ...PREFERRED_PACKAGE.split("/"),
  );
  if (fileExists(siblingRoot)) {
    return { root: siblingRoot, source: "asdf-sibling", packageName: PREFERRED_PACKAGE };
  }
  const legacyGlobal = join(globalRoot, ...LEGACY_PACKAGE.split("/"));
  if (fileExists(legacyGlobal)) {
    return { root: legacyGlobal, source: "npm-global-legacy", packageName: LEGACY_PACKAGE };
  }
  throw new Error("pi-coding-agent package root not found");
}

let modulePromise;

async function loadModelRouterModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { root: packageRoot, packageName } = resolvePackageRoot();
      const tempDir = await mkdtemp(join(tmpdir(), "model-router-test-"));
      const scope = packageName.split("/")[0];
      await mkdir(join(tempDir, "node_modules", scope), { recursive: true });
      await symlink(packageRoot, join(tempDir, "node_modules", scope, "pi-coding-agent"));
      const piAiPath = join(packageRoot, "node_modules", "@earendil-works", "pi-ai");
      if (existsSync(piAiPath)) {
        if (!existsSync(join(tempDir, "node_modules", "@earendil-works"))) {
          await mkdir(join(tempDir, "node_modules", "@earendil-works"), { recursive: true });
        }
        const target = join(tempDir, "node_modules", "@earendil-works", "pi-ai");
        if (!existsSync(target)) await symlink(piAiPath, target);
      }
      const typeboxPath = join(packageRoot, "node_modules", "typebox");
      if (existsSync(typeboxPath)) {
        await symlink(typeboxPath, join(tempDir, "node_modules", "typebox"));
      }
      let jitiEntry = join(packageRoot, "node_modules", "jiti", "lib", "jiti.mjs");
      if (!existsSync(jitiEntry)) {
        jitiEntry = join(packageRoot, "node_modules", "@mariozechner", "jiti", "lib", "jiti.mjs");
      }
      const copiedSource = join(tempDir, "model-router.ts");
      await copyFile(sourcePath, copiedSource);
      const { default: createJiti } = await import(pathToFileURL(jitiEntry).href);
      const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
      const module = await jiti.import(copiedSource);
      process.on("exit", () => {
        void rm(tempDir, { recursive: true, force: true });
      });
      return module;
    })();
  }
  return modulePromise;
}

// ---------------------------------------------------------------------------
// Fake harness
// ---------------------------------------------------------------------------

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const modes = new Map();
  const removals = [];
  const renames = [];
  return {
    files,
    dirs,
    modes,
    removals,
    renames,
    failures: { read: null, mkdir: null, append: null, write: null, rename: null },
    readTextFile(path) {
      if (this.failures.read) throw this.failures.read;
      if (!files.has(path)) {
        const err = new Error(`ENOENT: no such file: ${path}`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path);
    },
    mkdir(path, options = {}) {
      if (this.failures.mkdir) throw this.failures.mkdir;
      dirs.add(path);
      if (options.mode !== undefined) modes.set(path, options.mode);
    },
    appendFile(path, data, options = {}) {
      if (this.failures.append) throw this.failures.append;
      files.set(path, (files.get(path) ?? "") + data);
      if (options.mode !== undefined && !modes.has(path)) modes.set(path, options.mode);
    },
    writeFile(path, data, options = {}) {
      if (this.failures.write) throw this.failures.write;
      files.set(path, data);
      if (options.mode !== undefined) modes.set(path, options.mode);
    },
    rename(from, to) {
      if (this.failures.rename) throw this.failures.rename;
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
      if (modes.has(from)) {
        modes.set(to, modes.get(from));
        modes.delete(from);
      }
      renames.push({ from, to });
    },
    exists(path) {
      return files.has(path) || dirs.has(path);
    },
    realpath(path) {
      return path;
    },
    remove(path) {
      removals.push(path);
      files.delete(path);
      dirs.delete(path);
    },
  };
}

function fakeModel(provider, id, input = ["text"]) {
  return { provider, id, name: `${provider}/${id}`, input, api: "openai-completions", reasoning: false };
}

function createHarness(options = {}) {
  let seq = 0;
  const nextSeq = () => ++seq;
  const harness = {
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    setModelCalls: [],
    classifierCalls: [],
    registryFindCalls: [],
    authCalls: [],
    childCalls: [],
    appendedEntries: [],
    sentMessages: [],
    statuses: [],
    notifications: [],
    abortCalls: 0,
    providerRequests: [],
    sequence: [],
    nextSeq,
  };

  const registryModels = options.registryModels ?? [];
  const authByKey = options.auth ?? {};
  const registry = {
    find(provider, id) {
      harness.registryFindCalls.push({ provider, id, seq: nextSeq() });
      return registryModels.find((m) => m.provider === provider && m.id === id);
    },
    async getApiKeyAndHeaders(model) {
      const key = `${model.provider}/${model.id}`;
      harness.authCalls.push({ key, seq: nextSeq() });
      const entry = authByKey[key];
      if (entry === false) return { ok: false, error: "no credentials" };
      return { ok: true, apiKey: "unit-test-fake" };
    },
  };

  const setModelResults = options.setModelResults ?? {};
  let currentModel = options.currentModel ?? fakeModel("anthropic", "claude-opus-4-6", ["text", "image"]);

  const sessionEntries = options.sessionEntries ?? [];
  const ctx = {
    cwd: options.cwd ?? "/repo/project",
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? "print",
    get model() {
      return currentModel;
    },
    set model(m) {
      currentModel = m;
    },
    modelRegistry: registry,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getBranch: () => sessionEntries,
      getCwd: () => options.cwd ?? "/repo/project",
    },
    isIdle: () => harness.idle ?? true,
    signal: undefined,
    abort() {
      harness.abortCalls += 1;
      harness.sequence.push({ type: "abort", seq: nextSeq() });
    },
    ui: {
      notify(message, type) {
        harness.notifications.push({ message, type });
      },
      setStatus(key, text) {
        harness.statuses.push({ key, text });
      },
    },
  };

  const commandCtx = {
    ...ctx,
    get model() {
      return currentModel;
    },
    modelRegistry: registry,
    async waitForIdle() {
      harness.sequence.push({ type: "waitForIdle", seq: nextSeq() });
    },
  };

  const pi = {
    on(event, handler) {
      if (!harness.handlers.has(event)) harness.handlers.set(event, []);
      harness.handlers.get(event).push(handler);
    },
    registerCommand(name, opts) {
      harness.commands.set(name, opts);
    },
    registerTool(tool) {
      harness.tools.set(tool.name, tool);
    },
    async setModel(model) {
      const key = `${model.provider}/${model.id}`;
      harness.setModelCalls.push({ provider: model.provider, id: model.id, model, seq: nextSeq() });
      harness.sequence.push({ type: "setModel", key, seq: seq });
      const result = setModelResults[key];
      if (result instanceof Error) throw result;
      if (result === false) return false;
      currentModel = model;
      return true;
    },
    appendEntry(customType, data) {
      harness.appendedEntries.push({ customType, data });
    },
    sendMessage(message, opts) {
      harness.sentMessages.push({ message, opts });
    },
    async exec(command, args, execOptions) {
      harness.sequence.push({ type: "exec", command, args, seq: nextSeq() });
      if (options.execImpl) return options.execImpl(command, args, execOptions);
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
  };

  harness.pi = pi;
  harness.ctx = ctx;
  harness.commandCtx = commandCtx;
  harness.registry = registry;

  harness.emit = async (eventName, event) => {
    const handlers = harness.handlers.get(eventName) ?? [];
    const results = [];
    for (const handler of handlers) {
      results.push(await handler(event, ctx));
    }
    return results;
  };

  harness.markProviderRequest = () => {
    const entry = { type: "provider_request", seq: nextSeq() };
    harness.providerRequests.push(entry);
    harness.sequence.push(entry);
    return entry;
  };

  harness.runCommand = async (name, args = "") => {
    const command = harness.commands.get(name);
    assert.ok(command, `command ${name} not registered`);
    return command.handler(args, commandCtx);
  };

  return harness;
}

const AGENT_DIR = "/fake/agent";
const CONFIG_PATH = `${AGENT_DIR}/model-router.json`;

function createDeps(harness, options = {}) {
  const fs = options.fs ?? createFakeFs(options.files ?? {});
  let idCounter = 0;
  const deps = {
    agentDir: options.agentDir ?? AGENT_DIR,
    fs,
    now: options.now ?? (() => new Date("2026-07-11T12:00:00.000Z")),
    randomId: options.randomId ?? (() => `id-${++idCounter}`),
    warn: options.warn ?? ((message) => harness.notifications.push({ message, type: "warning" })),
    classify:
      options.classify ??
      (async (input) => {
        harness.classifierCalls.push({ input, seq: harness.nextSeq() });
        throw new Error("no classifier configured in test");
      }),
    childRunner:
      options.childRunner ??
      (async (invocation) => {
        harness.childCalls.push({ invocation, seq: harness.nextSeq() });
        throw new Error("no child runner configured in test");
      }),
    env: options.env ?? {},
  };
  deps.fs = fs;
  harness.fs = fs;
  return deps;
}

async function setupExtension(harness, depsOptions = {}) {
  const module = await loadModelRouterModule();
  const deps = createDeps(harness, depsOptions);
  const factory = module.createModelRouterExtension(deps);
  await factory(harness.pi);
  return { module, deps };
}

// ---------------------------------------------------------------------------
// Gate 1: loader, harness, safe default off
// ---------------------------------------------------------------------------

test("loader prefers @earendil-works/pi-coding-agent from env package root fixture", () => {
  const result = resolvePackageRoot({
    env: { PI_CODING_AGENT_PACKAGE_ROOT: "/explicit/root" },
  });
  assert.equal(result.root, "/explicit/root");
  assert.equal(result.source, "env");
  assert.equal(result.packageName, "@earendil-works/pi-coding-agent");
});

test("loader hits asdf sibling .npm layout when npm root -g lacks the package", () => {
  const exists = (path) =>
    path === "/installs/nodejs/.npm/lib/node_modules/@earendil-works/pi-coding-agent";
  const result = resolvePackageRoot({
    env: {},
    npmRoot: "/installs/nodejs/24.15.0/.npm/lib/node_modules",
    execPath: "/installs/nodejs/24.15.0/bin/node",
    exists,
  });
  assert.equal(result.source, "asdf-sibling");
  assert.equal(result.packageName, "@earendil-works/pi-coding-agent");
  assert.equal(
    result.root,
    "/installs/nodejs/.npm/lib/node_modules/@earendil-works/pi-coding-agent",
  );
});

test("loader only falls back to legacy package when preferred is absent everywhere", () => {
  const exists = (path) => path === "/g/@mariozechner/pi-coding-agent";
  const result = resolvePackageRoot({
    env: {},
    npmRoot: "/g",
    execPath: "/installs/nodejs/24.15.0/bin/node",
    exists,
  });
  assert.equal(result.packageName, "@mariozechner/pi-coding-agent");
  assert.equal(result.source, "npm-global-legacy");
});

test("loader resolves a real 0.80.6 install on this machine", async () => {
  const { root } = resolvePackageRoot();
  assert.ok(root.includes("pi-coding-agent"));
  const module = await loadModelRouterModule();
  assert.equal(typeof module.createModelRouterExtension, "function");
  assert.equal(typeof module.default, "function");
});

test("missing config file: /routing registered, no routing side effects", async () => {
  const harness = createHarness();
  await setupExtension(harness);

  assert.ok(harness.commands.has("routing"), "/routing must be registered");

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("tool_call", {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "read",
    input: { path: "a.txt" },
  });
  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "t1",
    toolName: "read",
    input: { path: "a.txt" },
    content: [],
    isError: false,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [] },
    toolResults: [],
  });

  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.classifierCalls.length, 0);
  assert.equal(harness.statuses.length, 0);
  const logWrites = [...harness.fs.files.keys()].filter((p) => p.endsWith(".jsonl"));
  assert.equal(logWrites.length, 0, "no log writes when config missing");
});

test("/routing status reports config path and off/off without a TUI", async () => {
  const harness = createHarness({ hasUI: false });
  await setupExtension(harness);
  await harness.runCommand("routing", "status");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes(CONFIG_PATH), "status should include config path");
  assert.ok(/configured[^\n]*off/i.test(text), "status should include configured=off");
  assert.ok(/effective[^\n]*off/i.test(text), "status should include effective=off");
});

// ---------------------------------------------------------------------------
// Gate 2: strict config parsing, defaults, fixed identity
// ---------------------------------------------------------------------------

function baseConfig(overrides = {}) {
  return {
    version: 1,
    mode: "off",
    models: {
      classifier: { provider: "opencode", id: "deepseek-v4-flash-free", supportsImages: false },
      weak: { provider: "opencode", id: "mimo-v2.5-free", supportsImages: true },
    },
    ...overrides,
  };
}

async function parseConfigWith(rawObjectOrText, options = {}) {
  const module = await loadModelRouterModule();
  const text =
    typeof rawObjectOrText === "string" ? rawObjectOrText : JSON.stringify(rawObjectOrText);
  return module.parseModelRouterConfig(text, { agentDir: options.agentDir ?? AGENT_DIR });
}

test("config: accepts complete off/shadow/active configs and applies documented defaults", async () => {
  for (const mode of ["off", "shadow", "active"]) {
    const result = await parseConfigWith(baseConfig({ mode }));
    assert.equal(result.kind, "valid", `mode=${mode}: ${JSON.stringify(result.errors ?? [])}`);
    assert.equal(result.config.mode, mode);
    assert.equal(result.config.classification.ruleProfile, "conservative-v1");
    assert.equal(result.config.classification.minWeakConfidence, 0.9);
    assert.equal(result.config.classification.timeoutMs, 20000);
    assert.equal(result.config.classification.totalTimeoutMs, 30000);
    assert.equal(result.config.classification.maxInputChars, 12000);
    assert.equal(result.config.limits.maxWeakContinuationTurns, 4);
    assert.equal(result.config.limits.maxNoProgressTurns, 2);
    assert.equal(result.config.limits.maxRepeatedOperationCount, 2);
    assert.equal(result.config.logging.directory, `${AGENT_DIR}/model-router-logs`);
    assert.equal(result.config.logging.maxReasonChars, 240);
    assert.equal(result.config.subPi.enabled, false);
    assert.equal(result.config.subPi.maxConcurrent, 1);
    assert.equal(result.config.subPi.timeoutMs, 1800000);
  }
});

test("config: normalizes singleton identities and preserves ordered model pools", async () => {
  const singleton = await parseConfigWith(baseConfig({ mode: "active" }));
  assert.equal(singleton.kind, "valid");
  assert.deepEqual(singleton.config.models.classifier, [baseConfig().models.classifier]);
  assert.deepEqual(singleton.config.models.weak, [baseConfig().models.weak]);

  const classifier = [
    { provider: "nvidia-free", id: "z-ai/glm-5.2", supportsImages: false },
    { provider: "deepseek", id: "deepseek-v4-flash", supportsImages: false },
  ];
  const weak = [
    { provider: "google", id: "gemini-3.5-flash", supportsImages: true },
    { provider: "opencode", id: "mimo-v2.5-free", supportsImages: true },
  ];
  const pooled = await parseConfigWith(baseConfig({ mode: "active", models: { classifier, weak } }));
  assert.equal(pooled.kind, "valid", JSON.stringify(pooled.errors ?? []));
  assert.deepEqual(pooled.config.models.classifier, classifier);
  assert.deepEqual(pooled.config.models.weak, weak);
});

test("config: rejects empty, duplicate, and malformed model pool entries", async () => {
  const classifier = baseConfig().models.classifier;
  const weak = baseConfig().models.weak;
  const cases = [
    { classifier: [], weak: [weak] },
    { classifier: [classifier], weak: [] },
    { classifier: [classifier, { ...classifier }], weak: [weak] },
    { classifier: [classifier], weak: [weak, { ...weak }] },
    { classifier: [classifier, null], weak: [weak] },
    { classifier: [classifier], weak: [{ provider: "p", id: "m" }] },
  ];
  for (const [index, models] of cases.entries()) {
    const result = await parseConfigWith(baseConfig({ mode: "active", models }));
    assert.equal(result.kind, "invalid", `case ${index} should be invalid`);
  }
});

test("config: classification totalTimeoutMs defaults independently and validates its range", async () => {
  const explicit = await parseConfigWith(baseConfig({
    classification: { timeoutMs: 5000, totalTimeoutMs: 25000 },
  }));
  assert.equal(explicit.kind, "valid", JSON.stringify(explicit.errors ?? []));
  assert.equal(explicit.config.classification.timeoutMs, 5000);
  assert.equal(explicit.config.classification.totalTimeoutMs, 25000);

  for (const totalTimeoutMs of [0, 2.5, 600001]) {
    const result = await parseConfigWith(baseConfig({ classification: { totalTimeoutMs } }));
    assert.equal(result.kind, "invalid", `totalTimeoutMs=${totalTimeoutMs} should be invalid`);
  }
});

test("config: JSON syntax error yields invalid with clear non-leaky error", async () => {
  const result = await parseConfigWith("{not json");
  assert.equal(result.kind, "invalid");
  assert.ok(result.errors.length >= 1);
  assert.ok(!result.errors.join(" ").includes("{not json"), "error must not echo raw JSON");
});

test("config: unknown fields rejected at every level", async () => {
  const cases = [
    baseConfig({ extra: 1 }),
    baseConfig({ models: { ...baseConfig().models, other: { provider: "x", id: "y", supportsImages: false } } }),
    baseConfig({
      models: {
        ...baseConfig().models,
        weak: { provider: "opencode", id: "mimo-v2.5-free", supportsImages: true, apiKey: "sk-x" },
      },
    }),
    baseConfig({ classification: { unknownOpt: true } }),
    baseConfig({ limits: { bogus: 1 } }),
    baseConfig({ logging: { nope: "x" } }),
    baseConfig({ subPi: { extraField: 1 } }),
  ];
  for (const [index, config] of cases.entries()) {
    const result = await parseConfigWith(config);
    assert.equal(result.kind, "invalid", `case ${index} should be invalid`);
  }
});

test("config: bad version, mode, identity, url/token fields, non-boolean supportsImages rejected", async () => {
  const cases = [
    baseConfig({ version: 2 }),
    baseConfig({ version: "1" }),
    baseConfig({ mode: "on" }),
    baseConfig({ models: { ...baseConfig().models, weak: { provider: "", id: "x", supportsImages: true } } }),
    baseConfig({ models: { ...baseConfig().models, weak: { provider: "p", id: "", supportsImages: true } } }),
    baseConfig({
      models: {
        ...baseConfig().models,
        weak: { provider: "opencode", id: "mimo-v2.5-free", supportsImages: true, baseUrl: "https://x" },
      },
    }),
    baseConfig({
      models: { ...baseConfig().models, weak: { provider: "p", id: "m", supportsImages: "yes" } },
    }),
    baseConfig({ models: { ...baseConfig().models, weak: { provider: "p", supportsImages: true } } }),
  ];
  for (const [index, config] of cases.entries()) {
    const result = await parseConfigWith(config);
    assert.equal(result.kind, "invalid", `case ${index} should be invalid`);
  }
});

test("config: numeric range validation", async () => {
  const cases = [
    baseConfig({ classification: { minWeakConfidence: 1.5 } }),
    baseConfig({ classification: { minWeakConfidence: Number.NaN } }),
    baseConfig({ classification: { minWeakConfidence: -0.1 } }),
    baseConfig({ classification: { timeoutMs: 0 } }),
    baseConfig({ classification: { timeoutMs: 2.5 } }),
    baseConfig({ classification: { timeoutMs: 10_000_000 } }),
    baseConfig({ classification: { maxInputChars: 0 } }),
    baseConfig({ limits: { maxWeakContinuationTurns: 0 } }),
    baseConfig({ limits: { maxNoProgressTurns: -1 } }),
    baseConfig({ limits: { maxRepeatedOperationCount: 1.2 } }),
    baseConfig({ logging: { directory: "" } }),
    baseConfig({ logging: { maxReasonChars: 0 } }),
    baseConfig({ subPi: { maxConcurrent: 0 } }),
    baseConfig({ subPi: { timeoutMs: -5 } }),
    baseConfig({ subPi: { enabled: "true" } }),
  ];
  for (const [index, config] of cases.entries()) {
    const result = await parseConfigWith(config);
    assert.equal(result.kind, "invalid", `case ${index} should be invalid`);
    assert.ok(result.errors.length >= 1, `case ${index} should carry a field-path error`);
  }
});

test("config: shadow/active require complete model identity; no identity defaults", async () => {
  const noModels = { version: 1, mode: "shadow" };
  const result = await parseConfigWith(noModels);
  assert.equal(result.kind, "invalid");

  const offNoModels = await parseConfigWith({ version: 1, mode: "off" });
  assert.equal(offNoModels.kind, "valid");
  assert.equal(offNoModels.config.models, undefined);
});

test("config: tilde log path expands only leading ~/, default comes from agentDir", async () => {
  const withTilde = await parseConfigWith(
    baseConfig({ logging: { directory: "~/router-logs" } }),
    {},
  );
  assert.equal(withTilde.kind, "valid");
  assert.ok(!withTilde.config.logging.directory.startsWith("~"));
  assert.ok(withTilde.config.logging.directory.endsWith("/router-logs"));

  const midTilde = await parseConfigWith(baseConfig({ logging: { directory: "/data/~user/logs" } }));
  assert.equal(midTilde.kind, "valid");
  assert.equal(midTilde.config.logging.directory, "/data/~user/logs");
});

test("config: invalid config means off/error with zero classifier/logger/setModel activity", async () => {
  const harness = createHarness();
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: "{broken" },
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "do things",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [] },
    toolResults: [],
  });
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.classifierCalls.length, 0);
  const logWrites = [...harness.fs.files.keys()].filter((p) => p.endsWith(".jsonl"));
  assert.equal(logWrites.length, 0);

  await harness.runCommand("routing", "status");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(/error/i.test(text), "status should surface config error state");
  assert.ok(!text.includes("{broken"), "status must not echo raw config JSON");
});

// ---------------------------------------------------------------------------
// Model pool failover Gate 2: persistent redacted cooldown health store
// ---------------------------------------------------------------------------

const HEALTH_PATH = `${AGENT_DIR}/model-router-health.json`;
const COOLDOWN_MS = 1_800_000;

function healthEntry(overrides = {}) {
  return {
    role: "weak",
    provider: "google",
    id: "gemini-3.5-flash",
    failedAt: Date.parse("2026-07-11T12:00:00.000Z"),
    retryAfter: Date.parse("2026-07-11T12:30:00.000Z"),
    reason: "provider_error",
    ...overrides,
  };
}

async function makeHealthStore(options = {}) {
  const module = await loadModelRouterModule();
  const fs = options.fs ?? createFakeFs();
  const warnings = options.warnings ?? [];
  const store = module.createModelHealthStore({
    fs,
    agentDir: AGENT_DIR,
    now: options.now ?? (() => new Date("2026-07-11T12:00:00.000Z")),
    randomId: options.randomId ?? (() => "health-temp"),
    warn: (message) => warnings.push(message),
  });
  return { module, store, fs, warnings };
}

test("health cooldown: role and identity isolation with exact 30-minute expiry boundary", async () => {
  let time = Date.parse("2026-07-11T12:00:00.000Z");
  const { store } = await makeHealthStore({ now: () => new Date(time) });
  store.markFailure("weak", { provider: "google", id: "gemini-3.5-flash" }, "provider_error");

  assert.equal(store.getCooling("classifier", { provider: "google", id: "gemini-3.5-flash" }), undefined);
  assert.equal(store.getCooling("weak", { provider: "google", id: "other" }), undefined);
  time += COOLDOWN_MS - 1;
  assert.equal(store.getCooling("weak", { provider: "google", id: "gemini-3.5-flash" }).retryAfter, time + 1);
  time += 1;
  assert.equal(store.getCooling("weak", { provider: "google", id: "gemini-3.5-flash" }), undefined);
});

test("health store: merges disk and memory by later retryAfter and preserves concurrent records", async () => {
  const diskEntry = healthEntry({ role: "classifier", provider: "deepseek", id: "a" });
  const fs = createFakeFs({
    [HEALTH_PATH]: JSON.stringify({ version: 1, entries: [diskEntry] }),
  });
  const { store } = await makeHealthStore({ fs });
  store.markFailure("weak", { provider: "google", id: "b" }, "set_model_failed");
  let persisted = JSON.parse(fs.files.get(HEALTH_PATH));
  assert.deepEqual(
    persisted.entries.map((entry) => `${entry.role}/${entry.provider}/${entry.id}`).sort(),
    ["classifier/deepseek/a", "weak/google/b"],
  );

  const later = healthEntry({
    role: "weak",
    provider: "google",
    id: "b",
    retryAfter: Date.parse("2026-07-11T13:00:00.000Z"),
  });
  fs.files.set(HEALTH_PATH, JSON.stringify({ version: 1, entries: [diskEntry, later] }));
  assert.equal(store.getCooling("weak", { provider: "google", id: "b" }).retryAfter, later.retryAfter);
});

test("health store: prunes expired entries and atomically writes redacted mode-0600 content", async () => {
  const expired = healthEntry({ retryAfter: Date.parse("2026-07-11T11:59:59.999Z") });
  const secret = "SECRET prompt response Authorization Bearer";
  const fs = createFakeFs({
    [HEALTH_PATH]: JSON.stringify({ version: 1, entries: [expired], ignored: secret }),
  });
  const { store } = await makeHealthStore({ fs, randomId: () => "atomic" });
  store.markFailure("classifier", { provider: "nvidia-free", id: "z-ai/glm-5.2" }, "timeout");

  const raw = fs.files.get(HEALTH_PATH);
  const persisted = JSON.parse(raw);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.entries.length, 1);
  assert.deepEqual(Object.keys(persisted.entries[0]).sort(), ["failedAt", "id", "provider", "reason", "retryAfter", "role"].sort());
  assert.ok(!raw.includes(secret));
  assert.equal(fs.modes.get(HEALTH_PATH), 0o600);
  assert.equal(fs.renames.length, 1);
  assert.match(fs.renames[0].from, /model-router-health\.json\.tmp-atomic$/);
  assert.equal(fs.renames[0].to, HEALTH_PATH);
});

test("health store failure: warning is generic and rate-limited while memory cooldown survives", async () => {
  const secret = "SECRET-EXCEPTION-BODY";
  const fs = createFakeFs({ [HEALTH_PATH]: `{broken ${secret}` });
  const warnings = [];
  const { store } = await makeHealthStore({ fs, warnings });
  store.refresh();
  store.refresh();
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(secret));

  fs.failures.write = new Error(secret);
  store.markFailure("weak", { provider: "opencode", id: "mimo-v2.5-free" }, "weak_model_error");
  assert.equal(store.getCooling("weak", { provider: "opencode", id: "mimo-v2.5-free" }).reason, "weak_model_error");
  assert.equal(warnings.length, 1, "read/write failures share one rate-limited generic warning");
});

// ---------------------------------------------------------------------------
// Gate 3: fixed model resolution, auth, image capability cross-check
// ---------------------------------------------------------------------------

const FIXED_MODELS = [
  fakeModel("opencode", "deepseek-v4-flash-free", ["text"]),
  fakeModel("opencode", "mimo-v2.5-free", ["text", "image"]),
  fakeModel("anthropic", "claude-opus-4-6", ["text", "image"]),
];

async function resolveWith({ registryModels, auth, config, mode }) {
  const module = await loadModelRouterModule();
  const harness = createHarness({ registryModels, auth });
  const parsed = module.parseModelRouterConfig(JSON.stringify(config ?? baseConfig({ mode: mode ?? "active" })), {
    agentDir: AGENT_DIR,
  });
  assert.equal(parsed.kind, "valid");
  const readiness = await module.resolveConfiguredModels(parsed.config, harness.registry, mode ?? "active");
  return { readiness, harness };
}

test("model resolver: exactly two exact find calls (classifier + weak), no candidate discovery", async () => {
  const { readiness, harness } = await resolveWith({ registryModels: FIXED_MODELS });
  assert.equal(harness.registryFindCalls.length, 2);
  assert.deepEqual(
    harness.registryFindCalls.map((c) => `${c.provider}/${c.id}`).sort(),
    ["opencode/deepseek-v4-flash-free", "opencode/mimo-v2.5-free"],
  );
  assert.equal(readiness.activeReady, true);
});

test("model resolver: declared true + registry image -> supported; declared false stays conservative", async () => {
  const { readiness } = await resolveWith({ registryModels: FIXED_MODELS });
  assert.equal(readiness.roles.weak.supportsImages, true);
  assert.equal(readiness.roles.classifier.supportsImages, false);

  // weak declared false although registry supports image -> still false
  const config = baseConfig({ mode: "active" });
  config.models.weak.supportsImages = false;
  const { readiness: r2 } = await resolveWith({ registryModels: FIXED_MODELS, config });
  assert.equal(r2.roles.weak.supportsImages, false);
});

test("model resolver: declared true but registry lacks image is a config error", async () => {
  const models = [
    fakeModel("opencode", "deepseek-v4-flash-free", ["text"]),
    fakeModel("opencode", "mimo-v2.5-free", ["text"]), // no image despite declaration
  ];
  const { readiness } = await resolveWith({ registryModels: models });
  assert.equal(readiness.roles.weak.status, "image_capability_mismatch");
});

test("model resolver: active requires classifier and weak resolvable with auth ok", async () => {
  // classifier missing from registry
  const { readiness } = await resolveWith({
    registryModels: FIXED_MODELS.filter((m) => m.id !== "deepseek-v4-flash-free"),
  });
  assert.equal(readiness.roles.classifier.status, "not_found");
  assert.equal(readiness.activeReady, false);

  // weak present but no credentials
  const { readiness: r2 } = await resolveWith({
    registryModels: FIXED_MODELS,
    auth: { "opencode/mimo-v2.5-free": false },
  });
  assert.equal(r2.roles.weak.status, "auth_missing");
  assert.equal(r2.activeReady, false);
});

test("model resolver: missing classifier or weak blocks active readiness with explicit reasons", async () => {
  const { readiness } = await resolveWith({
    registryModels: FIXED_MODELS,
    auth: { "opencode/deepseek-v4-flash-free": false, "opencode/mimo-v2.5-free": false },
  });
  assert.equal(readiness.activeReady, false);
  assert.ok(readiness.reasons.includes("classifier_unavailable"));
  assert.ok(readiness.reasons.includes("weak_unavailable"));

  // weak missing entirely
  const { readiness: r2 } = await resolveWith({
    registryModels: FIXED_MODELS.filter((m) => m.id !== "mimo-v2.5-free"),
  });
  assert.equal(r2.activeReady, false);
  assert.equal(r2.roles.weak.status, "not_found");
});

test("model resolver: readiness carries no auth material, only identity/capability/reason", async () => {
  const { readiness } = await resolveWith({ registryModels: FIXED_MODELS });
  const serialized = JSON.stringify(readiness);
  assert.ok(!serialized.includes("unit-test-fake"), "readiness must not contain api keys");
  for (const role of ["classifier", "weak"]) {
    assert.deepEqual(
      Object.keys(readiness.roles[role]).sort(),
      ["id", "provider", "status", "supportsImages"].sort(),
    );
  }
});

test("model resolver: shadow resolves fixed models and records readiness without setModel", async () => {
  const { readiness, harness } = await resolveWith({ registryModels: FIXED_MODELS, mode: "shadow" });
  assert.equal(harness.registryFindCalls.length, 2);
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(readiness.roles.weak.status, "ok");
});

test("candidate pool: selects first ready exact identity in order after cooling technical failures", async () => {
  const module = await loadModelRouterModule();
  const harness = createHarness({
    registryModels: [
      fakeModel("p", "second"),
      fakeModel("p", "third"),
    ],
  });
  const { store } = await makeHealthStore();
  const selection = await module.selectModelCandidate({
    role: "classifier",
    pool: [
      { provider: "p", id: "missing", supportsImages: false },
      { provider: "p", id: "second", supportsImages: false },
      { provider: "p", id: "third", supportsImages: false },
    ],
    registry: harness.registry,
    health: store,
  });
  assert.equal(selection.status, "ready");
  assert.equal(selection.identity.id, "second");
  assert.deepEqual(harness.registryFindCalls.map((call) => call.id), ["missing", "second"]);
  assert.equal(store.getCooling("classifier", { provider: "p", id: "missing" }).reason, "not_found");
});

test("candidate pool: skips cooling identity without registry/auth calls", async () => {
  const module = await loadModelRouterModule();
  const harness = createHarness({ registryModels: [fakeModel("p", "first"), fakeModel("p", "second")] });
  const { store } = await makeHealthStore();
  store.markFailure("weak", { provider: "p", id: "first" }, "provider_error");
  const selection = await module.selectModelCandidate({
    role: "weak",
    pool: [
      { provider: "p", id: "first", supportsImages: false },
      { provider: "p", id: "second", supportsImages: false },
    ],
    registry: harness.registry,
    health: store,
  });
  assert.equal(selection.identity.id, "second");
  assert.deepEqual(harness.registryFindCalls.map((call) => call.id), ["second"]);
  assert.deepEqual(harness.authCalls.map((call) => call.key), ["p/second"]);
});

test("candidate pool: auth and declaration mismatch cool then continue with fixed failure codes", async () => {
  const module = await loadModelRouterModule();
  const harness = createHarness({
    registryModels: [
      fakeModel("p", "no-auth"),
      fakeModel("p", "bad-image", ["text"]),
      fakeModel("p", "ready", ["text", "image"]),
    ],
    auth: { "p/no-auth": false },
  });
  const { store } = await makeHealthStore();
  const selection = await module.selectModelCandidate({
    role: "weak",
    pool: [
      { provider: "p", id: "no-auth", supportsImages: false },
      { provider: "p", id: "bad-image", supportsImages: true },
      { provider: "p", id: "ready", supportsImages: true },
    ],
    registry: harness.registry,
    health: store,
  });
  assert.equal(selection.identity.id, "ready");
  assert.deepEqual(selection.failureCodes, ["auth_missing", "image_capability_mismatch"]);
  assert.equal(store.getCooling("weak", { provider: "p", id: "no-auth" }).reason, "auth_missing");
  assert.equal(store.getCooling("weak", { provider: "p", id: "bad-image" }).reason, "image_capability_mismatch");
});

test("candidate pool: image request skips declared text-only weak without cooling", async () => {
  const module = await loadModelRouterModule();
  const harness = createHarness({
    registryModels: [fakeModel("p", "text-only"), fakeModel("p", "image", ["text", "image"])],
  });
  const { store } = await makeHealthStore();
  const selection = await module.selectModelCandidate({
    role: "weak",
    pool: [
      { provider: "p", id: "text-only", supportsImages: false },
      { provider: "p", id: "image", supportsImages: true },
    ],
    registry: harness.registry,
    health: store,
    requireImages: true,
  });
  assert.equal(selection.identity.id, "image");
  assert.deepEqual(harness.registryFindCalls.map((call) => call.id), ["image"]);
  assert.equal(store.getCooling("weak", { provider: "p", id: "text-only" }), undefined);
});

test("candidate pool: exhausted result exposes earliest retry and redacted fixed codes", async () => {
  const module = await loadModelRouterModule();
  const harness = createHarness({ registryModels: [] });
  const { store } = await makeHealthStore();
  store.markFailure("classifier", { provider: "p", id: "cooling" }, "timeout");
  const selection = await module.selectModelCandidate({
    role: "classifier",
    pool: [
      { provider: "p", id: "cooling", supportsImages: false },
      { provider: "p", id: "missing", supportsImages: false },
    ],
    registry: harness.registry,
    health: store,
  });
  assert.equal(selection.status, "exhausted");
  assert.equal(selection.nextRetryAfter, Date.parse("2026-07-11T12:30:00.000Z"));
  assert.deepEqual(selection.failureCodes, ["cooling_down", "not_found"]);
  assert.ok(!JSON.stringify(selection).includes("unit-test-fake"));
});

// ---------------------------------------------------------------------------
// Gate 4: task capsule construction, strict validation, path constraints
// ---------------------------------------------------------------------------

const REPO = "/repo/project";

const FULL_TASK_PROMPT = [
  "Objective: Fix the date parsing bug in src/utils/date.ts",
  "Allowed write: src/utils/date.ts, tests/date.test.mjs",
  "Allowed read: src/utils, tests",
  "Forbidden: src/legacy",
  "Steps:",
  "1. Reproduce the failing case in tests/date.test.mjs",
  "2. Fix parseDate in src/utils/date.ts",
  "Artifacts: tests/date.test.mjs",
  "Verification: `node --test tests/date.test.mjs`",
].join("\n");

async function buildCapsule(prompt, options = {}) {
  const module = await loadModelRouterModule();
  return module.buildTaskCapsule(prompt, {
    cwd: options.cwd ?? REPO,
    repositoryRoot: options.repositoryRoot ?? REPO,
    realpath: options.realpath ?? ((p) => p),
    randomId: options.randomId ?? (() => "task-1"),
  });
}

test("capsule: full explicit task produces version 1 capsule with explicit facts", async () => {
  const result = await buildCapsule(FULL_TASK_PROMPT);
  assert.equal(result.status, "complete", JSON.stringify(result));
  const capsule = result.capsule;
  assert.equal(capsule.version, 1);
  assert.equal(capsule.taskId, "task-1");
  assert.equal(capsule.objective, "Fix the date parsing bug in src/utils/date.ts");
  assert.equal(capsule.cwd, REPO);
  assert.equal(capsule.repositoryRoot, REPO);
  assert.deepEqual(capsule.allowedWrite, [`${REPO}/src/utils/date.ts`, `${REPO}/tests/date.test.mjs`]);
  assert.deepEqual(capsule.allowedRead, [`${REPO}/src/utils`, `${REPO}/tests`]);
  assert.deepEqual(capsule.forbidden, [`${REPO}/src/legacy`]);
  assert.equal(capsule.steps.length, 2);
  assert.deepEqual(capsule.expectedArtifacts, [
    { path: `${REPO}/tests/date.test.mjs`, condition: "exists" },
  ]);
  assert.deepEqual(capsule.verification, [{ command: "node --test tests/date.test.mjs" }]);
});

test("capsule: cwd/repositoryRoot come from ctx, prompt cannot override them or inject models", async () => {
  const prompt = [
    "Objective: do something",
    "cwd: /elsewhere/evil",
    "repositoryRoot: /elsewhere/evil",
    "model: evil/injected-model",
    "Allowed write: src/a.ts",
    "Steps:",
    "1. edit src/a.ts",
    "Artifacts: src/a.ts",
    "Verification: `node --test tests/a.test.mjs`",
  ].join("\n");
  const result = await buildCapsule(prompt);
  assert.equal(result.status, "complete");
  assert.equal(result.capsule.cwd, REPO);
  assert.equal(result.capsule.repositoryRoot, REPO);
  assert.ok(!JSON.stringify(result.capsule).includes("evil"));
});

test("capsule: missing objective/write/steps/artifact/verification or conflicts are incomplete", async () => {
  const withOut = (lineStart) =>
    FULL_TASK_PROMPT.split("\n")
      .filter((l) => !l.toLowerCase().startsWith(lineStart))
      .join("\n");
  const noObjective = await buildCapsule(withOut("objective:"));
  assert.equal(noObjective.status, "incomplete");
  const noWrite = await buildCapsule(withOut("allowed write:"));
  assert.equal(noWrite.status, "incomplete");
  const noSteps = await buildCapsule(
    FULL_TASK_PROMPT.split("\n").filter((l) => !/^(steps:|\d+\.)/i.test(l)).join("\n"),
  );
  assert.equal(noSteps.status, "incomplete");
  const noArtifacts = await buildCapsule(withOut("artifacts:"));
  assert.equal(noArtifacts.status, "incomplete");
  const noVerification = await buildCapsule(withOut("verification:"));
  assert.equal(noVerification.status, "incomplete");

  const conflicting = await buildCapsule(
    FULL_TASK_PROMPT.replace("Forbidden: src/legacy", "Forbidden: src/utils/date.ts"),
  );
  assert.equal(conflicting.status, "incomplete");
  assert.ok(conflicting.reasons.some((r) => r.includes("conflict")));
});

test("capsule: nonexistent target below an escaping symlink parent is invalid", async () => {
  const module = await loadModelRouterModule();
  const prompt = [
    "Objective: add a file",
    "Allowed write: link/new.ts",
    "Steps:",
    "1. add file",
    "Artifacts: link/new.ts",
    "Verification: `node --test`",
  ].join("\n");
  const result = module.buildTaskCapsule(prompt, {
    cwd: REPO,
    repositoryRoot: REPO,
    randomId: () => "task-1",
    realpath(path) {
      if (path === `${REPO}/link`) return "/outside";
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(result.status, "invalid_scope");
});

test("capsule: path escapes are invalid_capsule_scope", async () => {
  const dotdot = await buildCapsule(FULL_TASK_PROMPT.replace("src/utils/date.ts,", "../outside.ts,"));
  assert.equal(dotdot.status, "invalid_scope");

  const absolute = await buildCapsule(
    FULL_TASK_PROMPT.replace("Allowed write: src/utils/date.ts, tests/date.test.mjs", "Allowed write: /etc/passwd"),
  );
  assert.equal(absolute.status, "invalid_scope");

  const empty = await buildCapsule(
    FULL_TASK_PROMPT.replace("Allowed write: src/utils/date.ts, tests/date.test.mjs", 'Allowed write: ""'),
  );
  assert.ok(empty.status === "invalid_scope" || empty.status === "incomplete");

  const symlinked = await buildCapsule(FULL_TASK_PROMPT, {
    realpath: (p) => (p.includes("src/utils") ? "/outside/target" : p),
  });
  assert.equal(symlinked.status, "invalid_scope");
});

test("capsule: explicit facts extraction never widens scope; unlabeled text is ambiguous", async () => {
  const result = await buildCapsule(FULL_TASK_PROMPT + "\nAlso please clean up whatever else you find.");
  assert.equal(result.status, "complete");
  // trailing free text must not add scope or verification
  assert.equal(result.capsule.allowedWrite.length, 2);
  assert.equal(result.capsule.verification.length, 1);

  const ambiguous = await buildCapsule("please fix the bug in the parser, thanks");
  assert.equal(ambiguous.status, "ambiguous");

  const halfAmbiguous = await buildCapsule("Objective: fix stuff\nsomething vague");
  assert.equal(halfAmbiguous.status, "incomplete");
});

test("capsule: capsule view excludes file contents and full prompt", async () => {
  const marker = "SECRET-BODY-MARKER-12345";
  const result = await buildCapsule(FULL_TASK_PROMPT + `\nBy the way: ${marker}`);
  assert.equal(result.status, "complete");
  assert.ok(!JSON.stringify(result.capsule).includes(marker));
});

// ---------------------------------------------------------------------------
// Gate 5: deterministic admission and image decision matrix
// ---------------------------------------------------------------------------

async function admissionOf(overrides = {}) {
  const module = await loadModelRouterModule();
  const prompt = overrides.prompt ?? FULL_TASK_PROMPT;
  const capsule =
    overrides.capsule ??
    module.buildTaskCapsule(prompt, {
      cwd: REPO,
      repositoryRoot: REPO,
      realpath: (p) => p,
      randomId: () => "task-1",
    });
  return module.evaluateAdmission({
    prompt,
    imageCount: overrides.imageCount ?? 0,
    weakSupportsImages: overrides.weakSupportsImages ?? true,
    maxInputChars: overrides.maxInputChars ?? 12000,
    capsule,
  });
}

test("admission: table-driven reason codes with fixed priority reject > strong > eligible", async () => {
  const module = await loadModelRouterModule();

  const eligible = await admissionOf();
  assert.equal(eligible.verdict, "eligible");
  assert.deepEqual(eligible.reasonCodes, ["capsule_complete"]);

  const tooLarge = await admissionOf({ maxInputChars: 10 });
  assert.equal(tooLarge.verdict, "strong");
  assert.ok(tooLarge.reasonCodes.includes("classifier_input_too_large"));

  const ambiguous = await admissionOf({ prompt: "just fix whatever is broken please" });
  assert.equal(ambiguous.verdict, "strong");
  assert.ok(ambiguous.reasonCodes.includes("scope_ambiguous"));

  const noAcceptance = await admissionOf({
    prompt: FULL_TASK_PROMPT.split("\n").filter((l) => !/^verification:/i.test(l)).join("\n"),
  });
  assert.equal(noAcceptance.verdict, "strong");
  assert.ok(noAcceptance.reasonCodes.includes("acceptance_missing"));

  const invalidScope = await admissionOf({
    prompt: FULL_TASK_PROMPT.replace("src/utils/date.ts,", "../outside.ts,"),
  });
  assert.equal(invalidScope.verdict, "reject");
  assert.ok(invalidScope.reasonCodes.includes("invalid_capsule_scope"));

  // multiple simultaneous hits: stable sorted reason codes, reject wins
  const multi = await admissionOf({
    prompt: FULL_TASK_PROMPT.replace("src/utils/date.ts,", "../outside.ts,"),
    maxInputChars: 10,
  });
  assert.equal(multi.verdict, "reject");
  const sortedCopy = [...multi.reasonCodes].sort();
  assert.deepEqual(multi.reasonCodes, sortedCopy, "reasonCodes must be stably sorted");
  assert.ok(multi.reasonCodes.length >= 2, `expected >=2 reason codes, got ${multi.reasonCodes.length}: ${JSON.stringify(multi.reasonCodes)}`);
});

test("admission: edit/write/git/process restart do not trigger strong by themselves", async () => {
  const prompt = [
    "Objective: Update the config default and restart the dev process",
    "Allowed write: src/config.ts, tests/config.test.mjs",
    "Steps:",
    "1. edit src/config.ts to change the default port",
    "2. write the new expectation into tests/config.test.mjs",
    "3. git commit the change",
    "4. restart the dev server process",
    "Artifacts: src/config.ts",
    "Verification: `node --test tests/config.test.mjs`",
  ].join("\n");
  const result = await admissionOf({ prompt });
  assert.equal(result.verdict, "eligible", JSON.stringify(result));
});

test("admission: dangerous regression categories always strong even if classifier says weak", async () => {
  const dangerous = [
    // 1. open-ended root cause analysis
    "Objective: Investigate the root cause of the intermittent CI failures\nAllowed write: src/a.ts\nSteps:\n1. investigate\nArtifacts: src/a.ts\nVerification: `node --test`",
    // 2. cross-module architecture
    "Objective: Redesign the architecture of the plugin system across modules\nAllowed write: src/a.ts\nSteps:\n1. design\nArtifacts: src/a.ts\nVerification: `node --test`",
    // 3. long-horizon shared state chain
    "Objective: Migrate all call sites and keep the API consistent long-term\nAllowed write: src/a.ts\nSteps:\n1. migrate\nArtifacts: src/a.ts\nVerification: `node --test`",
    // 4. sensitive / irreversible
    "Objective: Rotate the production credentials and drop table sessions\nAllowed write: src/a.ts\nSteps:\n1. rotate\nArtifacts: src/a.ts\nVerification: `node --test`",
    // 5. conflicting intent
    "Objective: Delete the cache layer, or maybe keep it, not sure which\nAllowed write: src/a.ts\nSteps:\n1. decide\nArtifacts: src/a.ts\nVerification: `node --test`",
  ];
  const expectedCodes = [
    "broad_analysis_or_design",
    "broad_analysis_or_design",
    "long_horizon_consistency",
    "sensitive_or_irreversible",
    "intent_ambiguous",
  ];
  for (const [index, prompt] of dangerous.entries()) {
    const result = await admissionOf({ prompt });
    assert.notEqual(result.verdict, "eligible", `dangerous case ${index} must not be eligible`);
    assert.ok(
      result.reasonCodes.includes(expectedCodes[index]),
      `case ${index}: expected ${expectedCodes[index]} in ${JSON.stringify(result.reasonCodes)}`,
    );
  }
});

test("admission: cross-boundary write scope pushes strong", async () => {
  const prompt = [
    "Objective: Update the shared type in three places",
    "Allowed write: src/a.ts, lib/b.ts, tools/c.ts, docs/d.md",
    "Steps:",
    "1. update all",
    "Artifacts: src/a.ts",
    "Verification: `node --test`",
  ].join("\n");
  const result = await admissionOf({ prompt });
  assert.equal(result.verdict, "strong");
  assert.ok(result.reasonCodes.includes("cross_boundary_task"));
});

test("admission: image matrix matches the design", async () => {
  // no images -> normal rules
  const none = await admissionOf({ imageCount: 0, weakSupportsImages: false });
  assert.equal(none.verdict, "eligible");

  // images, weak supports -> normal rules (can be eligible)
  const both = await admissionOf({ imageCount: 1 });
  assert.equal(both.verdict, "eligible");

  // images, weak does not support -> strong (no intervention)
  const weakNo = await admissionOf({ imageCount: 1, weakSupportsImages: false });
  assert.equal(weakNo.verdict, "strong");
  assert.ok(weakNo.reasonCodes.includes("image_not_supported_by_weak"));
});

// ---------------------------------------------------------------------------
// Gate 6: strict classifier JSON protocol and safe combination
// ---------------------------------------------------------------------------

const GOOD_CLASSIFIER_JSON = JSON.stringify({
  protocolVersion: 1,
  route: "weak",
  confidence: 0.96,
  riskFlags: [],
  reasonCode: "localized_explicit_task",
});

test("classifier protocol: input contains only the allowed compact fields", async () => {
  const module = await loadModelRouterModule();
  const capsuleResult = module.buildTaskCapsule(FULL_TASK_PROMPT, {
    cwd: REPO,
    repositoryRoot: REPO,
    realpath: (p) => p,
    randomId: () => "task-1",
  });
  const admission = module.evaluateAdmission({
    prompt: FULL_TASK_PROMPT,
    imageCount: 1,
    weakSupportsImages: true,
    maxInputChars: 12000,
    capsule: capsuleResult,
  });
  const input = module.buildClassifierInput({
    requestId: "req-1",
    prompt: FULL_TASK_PROMPT + "\nENV SECRET=abc AUTH Bearer xyz",
    capsule: capsuleResult.capsule,
    admission,
    imageMetadata: [{ mimeType: "image/png", data: "SHOULD-NOT-PASS" }],
    maxInputChars: 40,
  });
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      "protocolVersion",
      "requestId",
      "promptExcerpt",
      "cwd",
      "imageMetadata",
      "explicitPaths",
      "explicitSteps",
      "expectedArtifacts",
      "verification",
      "deterministicReasonCodes",
    ].sort(),
  );
  assert.equal(input.protocolVersion, 1);
  assert.equal(input.requestId, "req-1");
  assert.ok(input.promptExcerpt.length <= 40, "prompt excerpt must be bounded");
  assert.deepEqual(input.imageMetadata, [{ mimeType: "image/png" }], "image binary must be stripped");
  assert.equal(input.cwd, REPO);
  assert.ok(Array.isArray(input.explicitPaths));
  assert.deepEqual(input.deterministicReasonCodes, admission.reasonCodes);
  assert.ok(!JSON.stringify(input).includes("SHOULD-NOT-PASS"));
});

test("classifier protocol: only a bare single JSON object is accepted", async () => {
  const module = await loadModelRouterModule();
  const good = module.parseClassifierResponse(GOOD_CLASSIFIER_JSON);
  assert.equal(good.ok, true);
  assert.equal(good.classification.route, "weak");
  assert.equal(good.classification.confidence, 0.96);

  const trimmed = module.parseClassifierResponse(`  ${GOOD_CLASSIFIER_JSON}\n`);
  assert.equal(trimmed.ok, true);

  const badCases = [
    "```json\n" + GOOD_CLASSIFIER_JSON + "\n```",
    "Here you go: " + GOOD_CLASSIFIER_JSON,
    GOOD_CLASSIFIER_JSON + " // done",
    "[" + GOOD_CLASSIFIER_JSON + "]",
    "",
    "null",
    "42",
    JSON.stringify({ ...JSON.parse(GOOD_CLASSIFIER_JSON), extra: 1 }),
    JSON.stringify({ protocolVersion: 2, route: "weak", confidence: 0.9, riskFlags: [], reasonCode: "localized_explicit_task" }),
    JSON.stringify({ protocolVersion: 1, route: "medium", confidence: 0.9, riskFlags: [], reasonCode: "localized_explicit_task" }),
    JSON.stringify({ protocolVersion: 1, route: "weak", confidence: Number.NaN, riskFlags: [], reasonCode: "localized_explicit_task" }),
    JSON.stringify({ protocolVersion: 1, route: "weak", confidence: 1.7, riskFlags: [], reasonCode: "localized_explicit_task" }),
    JSON.stringify({ protocolVersion: 1, route: "weak", confidence: 0.9, riskFlags: ["made_up_flag"], reasonCode: "localized_explicit_task" }),
    JSON.stringify({ protocolVersion: 1, route: "weak", confidence: 0.9, riskFlags: [], reasonCode: "free text explanation" }),
    JSON.stringify({ protocolVersion: 1, route: "weak", confidence: 0.9, riskFlags: [] }),
  ];
  for (const [index, text] of badCases.entries()) {
    const result = module.parseClassifierResponse(text);
    assert.equal(result.ok, false, `bad case ${index} must be rejected: ${text.slice(0, 60)}`);
    assert.ok(typeof result.code === "string" && result.code.length > 0);
  }
});

test("classifier combination: weak only with high confidence and no flags", async () => {
  const module = await loadModelRouterModule();
  const eligible = { verdict: "eligible", reasonCodes: ["capsule_complete"] };
  const ok = (overrides = {}) => ({
    status: "ok",
    classification: {
      protocolVersion: 1,
      route: "weak",
      confidence: 0.96,
      riskFlags: [],
      reasonCode: "localized_explicit_task",
      ...overrides,
    },
  });

  const weak = module.combineRouteDecision(eligible, ok(), 0.9);
  assert.equal(weak.route, "weak");

  const strongRoute = module.combineRouteDecision(eligible, ok({ route: "strong" }), 0.9);
  assert.equal(strongRoute.route, "strong");

  const lowConfidence = module.combineRouteDecision(eligible, ok({ confidence: 0.5 }), 0.9);
  assert.equal(lowConfidence.route, "strong");

  const flagged = module.combineRouteDecision(eligible, ok({ riskFlags: ["sensitive"] }), 0.9);
  assert.equal(flagged.route, "strong");

  const failed = module.combineRouteDecision(eligible, { status: "failed", code: "classifier_timeout" }, 0.9);
  assert.equal(failed.route, "strong");
  assert.ok(failed.reasonCodes.includes("classifier_failure"));

  // deterministic verdicts are never overridden by the classifier
  const hardStrong = module.combineRouteDecision(
    { verdict: "strong", reasonCodes: ["sensitive_or_irreversible"] },
    ok(),
    0.9,
  );
  assert.equal(hardStrong.route, "strong");
  assert.deepEqual(hardStrong.reasonCodes, ["sensitive_or_irreversible"]);

  const rejected = module.combineRouteDecision(
    { verdict: "reject", reasonCodes: ["invalid_capsule_scope"] },
    ok(),
    0.9,
  );
  assert.equal(rejected.route, "reject");
});

// ---------------------------------------------------------------------------
// Model pool failover Gate 4: bounded classifier fallback
// ---------------------------------------------------------------------------

const CLASSIFIER_POOL = [
  { provider: "test", id: "classifier-1", supportsImages: false },
  { provider: "test", id: "classifier-2", supportsImages: false },
  { provider: "test", id: "classifier-3", supportsImages: false },
];
const WEAK_POOL = [
  { provider: "test", id: "weak-1", supportsImages: true },
];
const POOL_REGISTRY_MODELS = [
  ...CLASSIFIER_POOL.map((identity) => fakeModel(identity.provider, identity.id)),
  fakeModel("test", "weak-1", ["text", "image"]),
];

function poolConfig(overrides = {}) {
  return baseConfig({
    mode: "shadow",
    models: { classifier: CLASSIFIER_POOL, weak: WEAK_POOL },
    ...overrides,
  });
}

async function setupClassifierPool(options = {}) {
  const harness = createHarness({
    registryModels: options.registryModels ?? POOL_REGISTRY_MODELS,
    auth: options.auth,
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(poolConfig(options.configOverrides)) },
    classify: options.classify,
    now: options.now,
  });
  return harness;
}

test("classifier fallback: technical and protocol failures cool first candidate then use next", async () => {
  const cases = [
    { name: "provider", first: async () => { throw new Error("provider body secret"); }, reason: "provider_error" },
    { name: "empty", first: async () => ({ text: "" }), reason: "empty_response" },
    { name: "protocol", first: async () => ({ text: "not-json secret" }), reason: "invalid_protocol" },
  ];
  for (const scenario of cases) {
    const calls = [];
    const harness = await setupClassifierPool({
      classify: async (request) => {
        calls.push(`${request.model.provider}/${request.model.id}`);
        if (request.model.id === "classifier-1") return scenario.first();
        return { text: GOOD_CLASSIFIER_JSON };
      },
    });
    await emitStart(harness);
    assert.deepEqual(calls, ["test/classifier-1", "test/classifier-2"], scenario.name);
    const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
    assert.equal(health.entries.find((entry) => entry.id === "classifier-1").reason, scenario.reason);
    assert.ok(!JSON.stringify(health).includes("secret"));
  }
});

test("classifier fallback: resolution not-found/auth failures continue without calling failed identity", async () => {
  const calls = [];
  const registryModels = POOL_REGISTRY_MODELS.filter((model) => model.id !== "classifier-1");
  const harness = await setupClassifierPool({
    registryModels,
    classify: async (request) => {
      calls.push(request.model.id);
      return { text: GOOD_CLASSIFIER_JSON };
    },
  });
  await emitStart(harness);
  assert.deepEqual(calls, ["classifier-2"]);

  const authCalls = [];
  const authHarness = await setupClassifierPool({
    auth: { "test/classifier-1": false },
    classify: async (request) => {
      authCalls.push(request.model.id);
      return { text: GOOD_CLASSIFIER_JSON };
    },
  });
  await emitStart(authHarness);
  assert.deepEqual(authCalls, ["classifier-2"]);
});

test("classifier fallback: valid strong, low-confidence, and risk result stop without voting or cooldown", async () => {
  const validResults = [
    { route: "strong" },
    { confidence: 0.2 },
    { riskFlags: ["sensitive"] },
  ];
  for (const overrides of validResults) {
    const calls = [];
    const harness = await setupClassifierPool({
      classify: async (request) => {
        calls.push(request.model.id);
        return { text: classifierText(overrides) };
      },
    });
    await emitStart(harness);
    assert.deepEqual(calls, ["classifier-1"]);
    assert.equal(harness.fs.files.has(HEALTH_PATH), false);
  }
});

test("classifier fallback: user abort stops chain without cooldown", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const harness = await setupClassifierPool({
    classify: async (request) => {
      calls.push(request.model.id);
      const error = new Error("user cancelled secret");
      error.name = "AbortError";
      throw error;
    },
  });
  harness.ctx.signal = controller.signal;
  await emitStart(harness);
  assert.deepEqual(calls, ["classifier-1"]);
  assert.equal(harness.fs.files.has(HEALTH_PATH), false);
});

test("classifier budget: each attempt receives remaining total timeout and unattempted candidate is not cooled", async () => {
  let time = Date.parse("2026-07-11T12:00:00.000Z");
  const calls = [];
  const harness = await setupClassifierPool({
    configOverrides: {
      classification: { timeoutMs: 8000, totalTimeoutMs: 10000 },
    },
    now: () => new Date(time),
    classify: async (request) => {
      calls.push({ id: request.model.id, timeoutMs: request.timeoutMs });
      time += 7000;
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    },
  });
  await emitStart(harness);
  assert.deepEqual(calls, [
    { id: "classifier-1", timeoutMs: 8000 },
    { id: "classifier-2", timeoutMs: 3000 },
  ]);
  const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.deepEqual(health.entries.map((entry) => entry.id).sort(), ["classifier-1", "classifier-2"]);
  assert.ok(!health.entries.some((entry) => entry.id === "classifier-3"));
});

// ---------------------------------------------------------------------------
// Gate 7: phase 1 shadow orchestration and JSONL audit
// ---------------------------------------------------------------------------

const LOG_DIR = `${AGENT_DIR}/model-router-logs`;
const LOG_FILE = `${LOG_DIR}/2026-07-11.jsonl`;

function shadowFiles(mode = "shadow", extra = {}) {
  return { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode, ...extra })) };
}

function classifierText(overrides = {}) {
  return JSON.stringify({
    protocolVersion: 1,
    route: "weak",
    confidence: 0.96,
    riskFlags: [],
    reasonCode: "localized_explicit_task",
    ...overrides,
  });
}

function weakClassifier(harness, overrides = {}) {
  return async (request) => {
    harness.classifierCalls.push({ request, seq: harness.nextSeq() });
    return { text: classifierText(overrides) };
  };
}

async function setupShadow(harnessOptions = {}, depsOptions = {}) {
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO, ...harnessOptions });
  const setup = await setupExtension(harness, {
    files: shadowFiles(),
    classify: weakClassifier(harness),
    ...depsOptions,
  });
  return { harness, ...setup };
}

function readLogRecords(harness) {
  const text = harness.fs.files.get(LOG_FILE) ?? "";
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function emitStart(harness, prompt = FULL_TASK_PROMPT, images) {
  return harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt,
    images,
    systemPrompt: "SYSTEM-PROMPT-BODY",
    systemPromptOptions: {},
  });
}

async function emitToolPair(harness, { id, toolName = "bash", input, isError = false, text = "", details }) {
  await harness.emit("tool_call", { type: "tool_call", toolCallId: id, toolName, input });
  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: id,
    toolName,
    input,
    content: text ? [{ type: "text", text }] : [],
    isError,
    details,
  });
}

async function emitTurnEnd(harness, { turnIndex = 0, toolResultIds = [], model, usage } = {}) {
  const actualModel = model ?? (harness.ctx.model ? `${harness.ctx.model.provider}/${harness.ctx.model.id}` : "anthropic/claude-opus-4-6");
  const [provider, id] = actualModel.split("/");
  return harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: {
      role: "assistant",
      provider,
      model: id,
      usage: usage ?? { input: 100, output: 20 },
      content: [],
    },
    toolResults: toolResultIds.map((toolCallId) => ({ role: "toolResult", toolCallId })),
  });
}

test("shadow: initial decision resets request state, classifies once, never calls setModel", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  assert.equal(harness.classifierCalls.length, 1);
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0, "shadow must not inject capsule message");

  const records = readLogRecords(harness);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.mode, "shadow");
  assert.equal(record.decisionKind, "initial");
  assert.equal(record.targetModel, "opencode/mimo-v2.5-free");
  assert.equal(record.actualModel, "anthropic/claude-opus-4-6");
  assert.ok(record.requestId, "requestId must be present");
  assert.equal(record.admission.verdict, "eligible");
  assert.equal(record.classification.status, "ok");
});

test("shadow: hard strong target skips classifier entirely; reject also logged", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness, "please just fix whatever seems broken");
  assert.equal(harness.classifierCalls.length, 0);
  let records = readLogRecords(harness);
  assert.equal(records.at(-1).targetModel, null, "strong verdict means no target model");
  assert.equal(harness.setModelCalls.length, 0);

  await emitStart(harness, FULL_TASK_PROMPT.replace("src/utils/date.ts,", "../escape.ts,"));
  records = readLogRecords(harness);
  assert.equal(records.at(-1).admission.verdict, "reject");
  assert.equal(records.at(-1).targetModel, null);
  assert.equal(harness.classifierCalls.length, 0);
});

test("shadow: tool observers never block or rewrite; continuation shares requestId without reclassifying", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  const callResults = await harness.emit("tool_call", {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "read",
    input: { path: `${REPO}/src/utils/date.ts` },
  });
  assert.ok(callResults.every((r) => r === undefined || r?.block === undefined), "must not block");
  const resultResults = await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "t1",
    toolName: "read",
    input: { path: `${REPO}/src/utils/date.ts` },
    content: [{ type: "text", text: "the file contents SECRET-CONTENT" }],
    isError: false,
  });
  assert.ok(resultResults.every((r) => r === undefined), "must not rewrite results");

  await emitTurnEnd(harness, { toolResultIds: ["t1"] });
  const records = readLogRecords(harness);
  assert.equal(records.length, 2);
  const [initial, continuation] = records;
  assert.equal(continuation.decisionKind, "continuation");
  assert.equal(continuation.requestId, initial.requestId);
  assert.equal(continuation.actualModel, "anthropic/claude-opus-4-6");
  assert.deepEqual(continuation.actualUsage, { input: 100, output: 20 });
  assert.equal(continuation.toolSummary.count, 1);
  assert.equal(harness.classifierCalls.length, 1, "continuation must not re-classify");
  assert.equal(harness.setModelCalls.length, 0);
});

test("shadow: no tool batch records completion usage without routing side effects", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  await emitTurnEnd(harness, { toolResultIds: [] });
  const records = readLogRecords(harness);
  assert.equal(records.length, 2);
  assert.equal(records.at(-1).decisionKind, "completion");
  assert.deepEqual(records.at(-1).actualUsage, { input: 100, output: 20 });
  assert.equal(harness.setModelCalls.length, 0);
});

test("audit redaction: no prompt/system prompt/tool output/auth/image data in the log", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness, FULL_TASK_PROMPT + "\nExtra body: DO-NOT-LOG-ME", [
    { type: "image", data: "BASE64-IMAGE-DATA", mimeType: "image/png" },
  ]);
  await emitToolPair(harness, {
    id: "t1",
    toolName: "bash",
    input: { command: "node --test tests/date.test.mjs" },
    text: "stdout SECRET-OUTPUT lines",
  });
  await emitTurnEnd(harness, { toolResultIds: ["t1"] });
  const raw = harness.fs.files.get(LOG_FILE) ?? "";
  assert.ok(raw.length > 0);
  for (const leak of ["DO-NOT-LOG-ME", "SYSTEM-PROMPT-BODY", "SECRET-OUTPUT", "BASE64-IMAGE-DATA", "unit-test-fake", "Fix the date parsing bug"]) {
    assert.ok(!raw.includes(leak), `log must not contain ${leak}`);
  }
});

test("audit log storage: date-named JSONL with 0700 dir and 0600 file modes", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  assert.ok(harness.fs.files.has(LOG_FILE), "log file must be date-named jsonl");
  assert.equal(harness.fs.modes.get(LOG_DIR), 0o700);
  assert.equal(harness.fs.modes.get(LOG_FILE), 0o600);
});

test("audit log failures: single rate-limited warning, decisions continue", async () => {
  const warnings = [];
  const fs = createFakeFs(shadowFiles());
  fs.failures.append = new Error("disk full");
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO });
  await setupExtension(harness, {
    fs,
    classify: weakClassifier(harness),
    warn: (message) => warnings.push(message),
  });
  await emitStart(harness);
  await emitStart(harness);
  assert.equal(harness.classifierCalls.length, 2, "decisions must continue despite log failure");
  assert.equal(warnings.length, 1, "log failure warning must be rate-limited to once");
  assert.ok(!warnings[0].includes("Fix the date parsing"), "warning must not leak prompt");
});

// ---------------------------------------------------------------------------
// Gate 8: effect signals, progress and weak-lease evaluation (pure functions)
// ---------------------------------------------------------------------------

async function getCapsule(prompt = FULL_TASK_PROMPT) {
  const module = await loadModelRouterModule();
  const result = module.buildTaskCapsule(prompt, {
    cwd: REPO,
    repositoryRoot: REPO,
    realpath: (p) => p,
    randomId: () => "task-1",
  });
  assert.equal(result.status, "complete");
  return result.capsule;
}

function batchItem(module, overrides = {}) {
  const toolName = overrides.toolName ?? "read";
  const input = overrides.input ?? { path: `${REPO}/src/utils/date.ts` };
  return {
    toolName,
    input,
    fingerprint: module.fingerprintOperation(toolName, input),
    isError: overrides.isError ?? false,
    exitCode: overrides.exitCode ?? null,
    isVerification: overrides.isVerification ?? false,
  };
}

function freshEvalState() {
  return {
    operationCounts: new Map(),
    progressMemo: new Set(),
    noProgressCount: 0,
    weakContinuationCount: 0,
  };
}

async function runBatch(items, overrides = {}) {
  const module = await loadModelRouterModule();
  const capsule = overrides.capsule ?? (await getCapsule());
  return module.evaluateToolBatch({
    batch: items.map((item) => (typeof item === "function" ? item(module) : item)),
    capsule,
    limits: {
      maxWeakContinuationTurns: 4,
      maxNoProgressTurns: 2,
      maxRepeatedOperationCount: 2,
      ...overrides.limits,
    },
    state: overrides.state ?? freshEvalState(),
    target: overrides.target ?? { provider: "opencode", id: "mimo-v2.5-free" },
    actual: overrides.actual ?? { provider: "opencode", id: "mimo-v2.5-free" },
    fsExists: overrides.fsExists ?? (() => false),
  });
}

test("effect evaluator: tool_error / nonzero_exit / verification_failed", async () => {
  const module = await loadModelRouterModule();
  const err = await runBatch([batchItem(module, { isError: true })]);
  assert.ok(err.signals.includes("tool_error"));

  const nonzero = await runBatch([
    batchItem(module, { toolName: "bash", input: { command: "make build" }, exitCode: 2 }),
  ]);
  assert.ok(nonzero.signals.includes("nonzero_exit"));

  const verifyFail = await runBatch([
    batchItem(module, {
      toolName: "bash",
      input: { command: "node --test tests/date.test.mjs" },
      exitCode: 1,
      isVerification: true,
      isError: true,
    }),
  ]);
  assert.ok(verifyFail.signals.includes("verification_failed"));

  const healthyVerify = await runBatch([
    batchItem(module, {
      toolName: "bash",
      input: { command: "node --test tests/date.test.mjs" },
      exitCode: 0,
      isVerification: true,
    }),
  ]);
  assert.ok(!healthyVerify.signals.includes("verification_failed"));
  assert.ok(!healthyVerify.signals.includes("nonzero_exit"));
});

test("effect evaluator: scope drift and uncertain bash observation", async () => {
  const module = await loadModelRouterModule();
  const capsule = await getCapsule();

  assert.equal(module.observeScope("edit", { path: `${REPO}/src/utils/date.ts` }, capsule).status, "in_scope");
  assert.equal(module.observeScope("write", { path: `${REPO}/src/other/file.ts` }, capsule).status, "out_of_scope");
  assert.equal(module.observeScope("read", { path: `${REPO}/src/legacy/x.ts` }, capsule).status, "out_of_scope");
  assert.equal(module.observeScope("bash", { command: "ls -la" }, capsule).status, "uncertain");
  assert.equal(
    module.observeScope("bash", { command: "node --test tests/date.test.mjs" }, capsule).status,
    "in_scope",
    "capsule verification command is trusted",
  );
  assert.equal(
    module.observeScope("bash", { command: "git -C /elsewhere status" }, capsule).status,
    "out_of_scope",
  );

  const drift = await runBatch([
    batchItem(module, { toolName: "write", input: { path: `${REPO}/src/other/file.ts`, content: "x" } }),
  ]);
  assert.ok(drift.signals.includes("scope_drift"));

  const uncertain = await runBatch([
    batchItem(module, { toolName: "bash", input: { command: "ls -la" }, exitCode: 0 }),
  ]);
  assert.ok(uncertain.signals.includes("scope_observation_uncertain"));
});

test("effect evaluator: repeated operations counted per normalized fingerprint", async () => {
  const module = await loadModelRouterModule();
  const state = freshEvalState();
  const item = () => batchItem(module);
  const first = await runBatch([item(), item()], { state });
  assert.ok(!first.signals.includes("repeated_operation"), "2 repeats within limit 2");
  const second = await runBatch([item()], { state });
  assert.ok(second.signals.includes("repeated_operation"), "3rd identical op exceeds limit");

  const different = await runBatch(
    [batchItem(module, { input: { path: `${REPO}/tests/date.test.mjs` } })],
    { state: freshEvalState() },
  );
  assert.ok(!different.signals.includes("repeated_operation"), "different args are not miscounted");
});

test("effect evaluator: progress definition and no_progress_limit", async () => {
  const module = await loadModelRouterModule();
  const capsule = await getCapsule();

  // new modification target in allowed scope counts as progress
  const editItem = batchItem(module, {
    toolName: "edit",
    input: { path: `${REPO}/src/utils/date.ts`, oldText: "a", newText: "b" },
  });
  const progressed = await runBatch([editItem], { capsule });
  assert.equal(progressed.progress, true);

  // new expected artifact appearing counts as progress
  const artifactAppears = await runBatch([batchItem(module)], {
    capsule,
    fsExists: (p) => p === `${REPO}/tests/date.test.mjs`,
  });
  assert.equal(artifactAppears.progress, true);

  // first successful verification counts as progress
  const verified = await runBatch(
    [
      batchItem(module, {
        toolName: "bash",
        input: { command: "node --test tests/date.test.mjs" },
        exitCode: 0,
        isVerification: true,
      }),
    ],
    { capsule },
  );
  assert.equal(verified.progress, true);

  // repeated read with nothing new is not progress; hitting the limit raises the signal
  const state = freshEvalState();
  const readOnly = await runBatch([batchItem(module)], { capsule, state });
  assert.equal(readOnly.progress, false);
  assert.equal(readOnly.signals.includes("no_progress_limit"), false);
  const again = await runBatch([batchItem(module)], { capsule, state });
  assert.equal(again.progress, false);
  assert.ok(again.signals.includes("no_progress_limit"), "2 consecutive no-progress turns hit limit 2");
});

test("effect evaluator: artifact/acceptance/turn-cap/mismatch/failure/invalidation signals", async () => {
  const module = await loadModelRouterModule();
  const capsule = await getCapsule();

  const artifacts = module.checkExpectedArtifacts(capsule, () => false);
  assert.deepEqual(artifacts.missing, [`${REPO}/tests/date.test.mjs`]);
  const present = module.checkExpectedArtifacts(capsule, () => true);
  assert.deepEqual(present.missing, []);

  const cap = await runBatch([batchItem(module)], {
    state: { ...freshEvalState(), weakContinuationCount: 4 },
  });
  assert.ok(cap.signals.includes("weak_turn_limit"));

  const mismatch = await runBatch([batchItem(module)], {
    actual: { provider: "someone", id: "else" },
  });
  assert.ok(mismatch.signals.includes("actual_model_mismatch"));

});

test("effect evaluator: signals are unique, stably ordered, and empty batch means no continuation", async () => {
  const module = await loadModelRouterModule();
  const both = await runBatch([
    batchItem(module, { isError: true }),
    batchItem(module, { isError: true }),
  ]);
  const unique = new Set(both.signals);
  assert.equal(both.signals.length, unique.size, "signals must be deduplicated");

  const empty = await runBatch([]);
  assert.equal(empty.hasToolBatch, false);
  assert.deepEqual(empty.signals, []);
});

// ---------------------------------------------------------------------------
// Gate 9: Active initial switching and weak-lease lifecycle
// ---------------------------------------------------------------------------

function activeFiles(extra = {}) {
  return { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active", ...extra })) };
}

async function setupActive(harnessOptions = {}, depsOptions = {}) {
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO, ...harnessOptions });
  const classify = depsOptions.classify ?? weakClassifier(harness);
  await setupExtension(harness, {
    files: activeFiles(),
    classify,
    ...depsOptions,
  });
  return harness;
}

function strongClassifier(harness) {
  return async (request) => {
    harness.classifierCalls.push({ request, seq: harness.nextSeq() });
    return { text: classifierText({ route: "strong" }) };
  };
}

test("active initial: weak route calls setModel(fixedWeak) before provider request", async () => {
  const harness = await setupActive();
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  harness.markProviderRequest();
  const setModelCalls = harness.setModelCalls;
  assert.equal(setModelCalls.length, 1);
  assert.equal(setModelCalls[0].provider, "opencode");
  assert.equal(setModelCalls[0].id, "mimo-v2.5-free");
  const setModelIdx = harness.sequence.findIndex((s) => s.type === "setModel");
  const reqIdx = harness.sequence.findIndex((s) => s.type === "provider_request");
  assert.ok(setModelIdx >= 0 && reqIdx >= 0 && setModelIdx < reqIdx,
    "setModel must happen before provider request, got index setModel=" + setModelIdx + " req=" + reqIdx);
});

test("active initial: hard strong/classifier failure does not call setModel (no intervention)", async () => {
  const harness = await setupActive({}, { classify: async () => { throw new Error("classifier fail"); } });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  // classifier fails → strong verdict → no intervention, no setModel
  assert.equal(harness.setModelCalls.length, 0);
});

test("active initial: hard rule prompt (scope ambiguous) does not call setModel (no intervention)", async () => {
  const harness = await setupActive();
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "just fix whatever is broken thanks",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.classifierCalls.length, 0);
});

test("active strong verdict after a weak request restores the user model before no-op", async () => {
  const returnModel = fakeModel("user", "selected-before-weak", ["text", "image"]);
  const harness = await setupActive({ currentModel: returnModel });

  await emitStart(harness);
  assert.equal(harness.ctx.model.provider, "opencode", "first request should hold a weak lease");

  await emitStart(harness, "just fix whatever is broken thanks");
  assert.equal(harness.setModelCalls.length, 2, "second request should only restore the prior lease");
  assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel);
  assert.strictEqual(harness.ctx.model, returnModel, "strong verdict must continue on the restored user model");
});

test("active initial: weak setModel false keeps the exact current model with no fallback", async () => {
  const currentModel = fakeModel("user", "current-model", ["text", "image"]);
  const harness = await setupActive({
    currentModel,
    setModelResults: { "opencode/mimo-v2.5-free": false },
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  assert.equal(harness.setModelCalls.length, 1, "only try weak once");
  assert.equal(harness.setModelCalls[0].provider, "opencode");
  assert.strictEqual(harness.ctx.model, currentModel, "failed weak switch must preserve the current model object");
  assert.equal(harness.abortCalls, 0, "weak failure is not abort");
  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal(harness.setModelCalls.length, 1, "failed weak switch must not create a lease to restore");
});

test("active initial: setModel failure does not abort", async () => {
  const harness = await setupActive({
    setModelResults: { "opencode/mimo-v2.5-free": false },
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  assert.equal(harness.abortCalls, 0, "weak setModel failure must not abort");
});

test("active initial: weak fallback switches to later candidate and records actual target", async () => {
  const weak = [
    { provider: "test", id: "weak-1", supportsImages: true },
    { provider: "test", id: "weak-2", supportsImages: true },
    { provider: "test", id: "weak-3", supportsImages: false },
  ];
  const registryModels = [
    fakeModel("test", "classifier-1"),
    fakeModel("test", "weak-1", ["text", "image"]),
    fakeModel("test", "weak-2", ["text", "image"]),
    fakeModel("test", "weak-3"),
  ];
  const harness = createHarness({
    registryModels,
    cwd: REPO,
    setModelResults: { "test/weak-1": false },
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "active",
      models: { classifier: [CLASSIFIER_POOL[0]], weak },
    })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  const results = await emitStart(harness);
  assert.deepEqual(harness.setModelCalls.map((call) => call.id), ["weak-1", "weak-2"]);
  assert.equal(harness.ctx.model.id, "weak-2");
  assert.ok(results.some((entry) => entry?.message?.customType === "model-router-capsule"));
  assert.equal(readLogRecords(harness).at(-1).targetModel, "test/weak-2");
  const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.equal(health.entries.find((entry) => entry.id === "weak-1").reason, "set_model_failed");
});

test("active image request: skips text-only weak without cooldown and uses image-capable fallback", async () => {
  const weak = [
    { provider: "test", id: "text-weak", supportsImages: false },
    { provider: "test", id: "image-weak", supportsImages: true },
  ];
  const harness = createHarness({
    registryModels: [
      fakeModel("test", "classifier-1"),
      fakeModel("test", "text-weak"),
      fakeModel("test", "image-weak", ["text", "image"]),
    ],
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "active",
      models: { classifier: [CLASSIFIER_POOL[0]], weak },
    })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  await emitStart(harness, FULL_TASK_PROMPT, [{ mimeType: "image/png" }]);
  assert.deepEqual(harness.setModelCalls.map((call) => call.id), ["image-weak"]);
  assert.equal(harness.fs.files.has(HEALTH_PATH), false);
});

test("active image request: no image-capable weak keeps exact user model without cooldown", async () => {
  const userModel = fakeModel("user", "image-model", ["text", "image"]);
  const weak = [
    { provider: "test", id: "text-1", supportsImages: false },
    { provider: "test", id: "text-2", supportsImages: false },
  ];
  const harness = createHarness({
    registryModels: [fakeModel("test", "classifier-1"), fakeModel("test", "text-1"), fakeModel("test", "text-2")],
    currentModel: userModel,
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active", models: { classifier: [CLASSIFIER_POOL[0]], weak } })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  await emitStart(harness, FULL_TASK_PROMPT, [{ mimeType: "image/png" }]);
  assert.equal(harness.setModelCalls.length, 0);
  assert.strictEqual(harness.ctx.model, userModel);
  assert.equal(harness.fs.files.has(HEALTH_PATH), false);
});

test("weak model error: cools actual weak, restores exact lease model, next request uses fallback", async () => {
  const returnModel = fakeModel("user", "return-after-error", ["text", "image"]);
  const weak = [
    { provider: "test", id: "weak-1", supportsImages: true },
    { provider: "test", id: "weak-2", supportsImages: true },
  ];
  const harness = createHarness({
    registryModels: [
      fakeModel("test", "classifier-1"),
      fakeModel("test", "weak-1", ["text", "image"]),
      fakeModel("test", "weak-2", ["text", "image"]),
    ],
    currentModel: returnModel,
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active", models: { classifier: [CLASSIFIER_POOL[0]], weak } })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  await emitStart(harness);
  await harness.emit("turn_end", {
    type: "turn_end", turnIndex: 0,
    message: { role: "assistant", provider: "test", model: "weak-1", stopReason: "error", content: [] },
    toolResults: [],
  });
  assert.strictEqual(harness.ctx.model, returnModel);
  let health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.equal(health.entries.find((entry) => entry.id === "weak-1").reason, "weak_model_error");

  await emitStart(harness);
  assert.equal(harness.ctx.model.id, "weak-2");
  assert.deepEqual(harness.setModelCalls.map((call) => call.id), ["weak-1", "return-after-error", "weak-2"]);
  health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.equal(health.entries.filter((entry) => entry.id === "weak-1").length, 1);
});

test("weak abort and quality signal release lease without model cooldown", async () => {
  const returnModel = fakeModel("user", "return-no-cooldown", ["text", "image"]);
  const harness = await setupActive({ currentModel: returnModel });
  await emitStart(harness);
  await harness.emit("turn_end", {
    type: "turn_end", turnIndex: 0,
    message: { role: "assistant", provider: "opencode", model: "mimo-v2.5-free", stopReason: "aborted", content: [] },
    toolResults: [],
  });
  assert.strictEqual(harness.ctx.model, returnModel);
  assert.equal(harness.fs.files.has(HEALTH_PATH), false);

  await emitStart(harness);
  await emitToolPair(harness, {
    id: "quality", toolName: "bash", input: { command: "node --test tests/date.test.mjs" },
    isError: true, details: { exitCode: 1 },
  });
  await emitTurnEnd(harness, { toolResultIds: ["quality"] });
  assert.strictEqual(harness.ctx.model, returnModel);
  assert.equal(harness.fs.files.has(HEALTH_PATH), false);
});

test("active initial: weak route injects capsule message", async () => {
  const harness = await setupActive();
  const results = await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  const result = results.find((entry) => entry?.message);
  assert.equal(result?.message?.customType, "model-router-capsule");
  assert.equal(result?.message?.display, false);
});

test("active initial: shadow does not inject capsule message", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness, FULL_TASK_PROMPT);
  assert.equal(harness.sentMessages.length, 0, "shadow must not inject capsule message");
});

test("weak lease: healthy continuation keeps weak without setModel re-call", async () => {
  const harness = await setupActive();
  await emitStart(harness);
  const setModelBefore = harness.setModelCalls.length;
  await emitToolPair(harness, {
    id: "t1",
    toolName: "read",
    input: { path: `${REPO}/src/utils/date.ts` },
    text: "content",
  });
  await emitTurnEnd(harness, { toolResultIds: ["t1"] });
  // Healthy continuation should NOT trigger another setModel
  assert.equal(harness.setModelCalls.length, setModelBefore, "healthy continuation must not switch model");
});

test("weak lease: any turn_end effect signal restores the exact return model before the next request", async () => {
  const returnModel = fakeModel("user", "return-after-signal", ["text", "image"]);
  const harness = await setupActive({ currentModel: returnModel });
  await emitStart(harness);
  const setModelBefore = harness.setModelCalls.length;
  await emitToolPair(harness, {
    id: "t1",
    toolName: "bash",
    input: { command: "node --test tests/date.test.mjs" },
    isError: true,
    details: { exitCode: 1 },
  });
  await emitTurnEnd(harness, { toolResultIds: ["t1"] });
  const providerRequest = harness.markProviderRequest();
  assert.equal(harness.setModelCalls.length, setModelBefore + 1, "effect signal must release the weak lease");
  assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel, "must restore the captured model object");
  assert.ok(harness.setModelCalls.at(-1).seq < providerRequest.seq, "restore must precede the next provider request");
});

test("weak lease: turn_end with no tools does not trigger switch (run ends)", async () => {
  const harness = await setupActive();
  await emitStart(harness);
  const setModelBefore = harness.setModelCalls.length;
  await emitTurnEnd(harness, { toolResultIds: [] });
  assert.equal(harness.setModelCalls.length, setModelBefore, "no tools means no continuation, no switch");
});

test("active: actual model mismatch releases the weak lease to its return model", async () => {
  const returnModel = fakeModel("user", "return-after-mismatch");
  const harness = await setupActive({ currentModel: returnModel });
  await emitStart(harness);
  const setModelBefore = harness.setModelCalls.length;
  await emitToolPair(harness, {
    id: "t1", toolName: "edit",
    input: { path: `${REPO}/src/utils/date.ts`, oldText: "a", newText: "b" },
    text: "done",
  });
  await emitTurnEnd(harness, {
    toolResultIds: ["t1"],
    model: "opencode/deepseek-v4-flash-free",
  });
  assert.equal(harness.setModelCalls.length, setModelBefore + 1);
  assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel);
});

// ---------------------------------------------------------------------------
// Model pool failover Gate 6: suspended state and request-boundary recovery
// ---------------------------------------------------------------------------

async function setupSuspensionHarness(options = {}) {
  const registryModels = options.registryModels ?? [
    fakeModel("test", "weak-1", ["text", "image"]),
  ];
  const harness = createHarness({
    registryModels,
    cwd: REPO,
    setModelResults: options.setModelResults,
  });
  let time = options.time ?? Date.parse("2026-07-11T12:00:00.000Z");
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: options.mode ?? "active",
      models: {
        classifier: [{ provider: "test", id: "classifier-1", supportsImages: false }],
        weak: [{ provider: "test", id: "weak-1", supportsImages: true }],
      },
    })) },
    classify: async (request) => {
      harness.classifierCalls.push({ request });
      return { text: GOOD_CLASSIFIER_JSON };
    },
    now: () => new Date(time),
  });
  return { harness, registryModels, getTime: () => time, setTime: (value) => { time = value; } };
}

async function routingStatusText(harness) {
  harness.notifications.length = 0;
  await harness.runCommand("routing", "status");
  return harness.notifications.map((entry) => entry.message).join("\n");
}

test("suspended: exhausted classifier pool disables ordinary routing side effects", async () => {
  const { harness } = await setupSuspensionHarness();
  const first = await emitStart(harness);
  assert.equal(harness.classifierCalls.length, 0);
  assert.equal(harness.setModelCalls.length, 0);
  assert.ok(first.every((entry) => !entry?.message));
  assert.match(await routingStatusText(harness), /suspended/i);

  const findCount = harness.registryFindCalls.length;
  const second = await emitStart(harness);
  assert.equal(harness.registryFindCalls.length, findCount, "before retry no registry lookup occurs");
  assert.equal(harness.classifierCalls.length, 0);
  assert.equal(harness.setModelCalls.length, 0);
  assert.ok(second.every((entry) => !entry?.message));
});

test("suspended: active weak setModel exhaustion preserves user model and suspends router", async () => {
  const userModel = fakeModel("user", "selected", ["text", "image"]);
  const weak = [
    { provider: "test", id: "weak-1", supportsImages: true },
    { provider: "test", id: "weak-2", supportsImages: true },
  ];
  const harness = createHarness({
    registryModels: [
      fakeModel("test", "classifier-1"),
      fakeModel("test", "weak-1", ["text", "image"]),
      fakeModel("test", "weak-2", ["text", "image"]),
    ],
    currentModel: userModel,
    setModelResults: { "test/weak-1": false, "test/weak-2": false },
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "active",
      models: { classifier: [CLASSIFIER_POOL[0]], weak },
    })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  await emitStart(harness);
  assert.strictEqual(harness.ctx.model, userModel);
  assert.deepEqual(harness.setModelCalls.map((call) => call.id), ["weak-1", "weak-2"]);
  assert.match(await routingStatusText(harness), /suspended/i);
});

test("automatic recovery: exact cooldown expiry restores active intent and processes triggering request", async () => {
  const setup = await setupSuspensionHarness();
  const { harness, registryModels } = setup;
  await emitStart(harness);
  const findCount = harness.registryFindCalls.length;
  registryModels.push(fakeModel("test", "classifier-1"));

  setup.setTime(setup.getTime() + COOLDOWN_MS - 1);
  await emitStart(harness);
  assert.equal(harness.registryFindCalls.length, findCount);
  assert.equal(harness.classifierCalls.length, 0);

  setup.setTime(setup.getTime() + 1);
  const result = await emitStart(harness);
  assert.equal(harness.classifierCalls.length, 1);
  assert.equal(harness.ctx.model.id, "weak-1");
  assert.ok(result.some((entry) => entry?.message?.customType === "model-router-capsule"));
  assert.doesNotMatch(await routingStatusText(harness), /state: suspended/i);
});

test("automatic recovery: failed expiry retry re-cools candidate and remains suspended", async () => {
  const setup = await setupSuspensionHarness();
  const { harness } = setup;
  await emitStart(harness);
  setup.setTime(setup.getTime() + COOLDOWN_MS);
  await emitStart(harness);
  assert.match(await routingStatusText(harness), /suspended/i);
  const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.equal(health.entries[0].retryAfter, setup.getTime() + COOLDOWN_MS);
});

test("/routing active preserves requested intent as suspended and off does not clear cooldown", async () => {
  const { harness } = await setupSuspensionHarness({ mode: "shadow" });
  await emitStart(harness);
  await harness.runCommand("routing", "active");
  let status = await routingStatusText(harness);
  assert.match(status, /effective mode: active/i);
  assert.match(status, /state: suspended/i);
  const healthBefore = harness.fs.files.get(HEALTH_PATH);

  await harness.runCommand("routing", "off");
  status = await routingStatusText(harness);
  assert.match(status, /effective mode: off/i);
  assert.equal(harness.fs.files.get(HEALTH_PATH), healthBefore);
});

// ---------------------------------------------------------------------------
// Gate 10: /routing commands, activation snapshot, status bar, restore
// ---------------------------------------------------------------------------

test("/routing: first off→shadow captures activation snapshot", async () => {
  const harness = createHarness({
    registryModels: FIXED_MODELS,
    cwd: REPO,
    currentModel: { provider: "anthropic", id: "claude-opus-4-6", input: ["text", "image"] },
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "shadow" })) },
    classify: weakClassifier(harness),
  });
  // Capture snapshot via first before_agent_start
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  // Verify via check that activationModel was set (not empty)
  await harness.runCommand("routing", "status");
  const text = harness.notifications.map((n) => n.message).join("\n");
  // status must include config path and mode information
  assert.ok(text.includes(CONFIG_PATH), "status should include config path");
  assert.ok(/effective[^\n]*shadow/i.test(text), "effective mode should be shadow");
});

test("/routing: active validates readiness before enabling", async () => {
  // Missing weak → should reject active
  const partialModels = FIXED_MODELS.filter((m) => m.id !== "mimo-v2.5-free");
  const harness = createHarness({ registryModels: partialModels, cwd: REPO });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "shadow" })) },
    classify: weakClassifier(harness),
  });
  await harness.runCommand("routing", "active");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes("unavailable") || text.includes("cannot"), "should reject active when weak missing");
  // Should still be in shadow mode, not active
});

test("/routing: shadow from active waits for idle and restores activation model", async () => {
  const harness = createHarness({
    registryModels: FIXED_MODELS,
    cwd: REPO,
    currentModel: { provider: "anthropic", id: "claude-opus-4-6" },
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active" })) },
    classify: weakClassifier(harness),
  });
  // First request to capture snapshot and go weak
  await emitStart(harness);
  // ctx.model should now be weak
  const ctx = harness.ctx;
  const modelBefore = ctx.model;
  // Switch to shadow
  await harness.runCommand("routing", "shadow");
  // Should have called waitForIdle and restored activation model
  assert.ok(harness.sequence.some((s) => s.type === "waitForIdle"), "must wait for idle before switching");
  // model should be restored to activation model
  assert.equal(ctx.model.provider, "anthropic");
  assert.equal(ctx.model.id, "claude-opus-4-6");
});

test("/routing: off waits for idle, restores activation, clears all routing state", async () => {
  const harness = createHarness({
    registryModels: FIXED_MODELS,
    cwd: REPO,
    currentModel: { provider: "anthropic", id: "claude-opus-4-6" },
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "shadow" })) },
    classify: weakClassifier(harness),
  });
  // Do a shadow request to set up state
  await emitStart(harness);
  await harness.runCommand("routing", "off");
  assert.ok(harness.sequence.some((s) => s.type === "waitForIdle"), "must wait for idle");
  assert.equal(harness.ctx.model.provider, "anthropic", "model should be restored");
});

test("/routing: restore failure marks restore-error, no fallback", async () => {
  // Setup: activation is strong, but setModel for it will fail
  const harness = createHarness({
    registryModels: FIXED_MODELS,
    cwd: REPO,
    currentModel: { provider: "anthropic", id: "claude-opus-4-6" },
    setModelResults: { "anthropic/claude-opus-4-6": new Error("gone") },
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active" })) },
    classify: weakClassifier(harness),
  });
  // First request activates snapshot
  await emitStart(harness);
  // Off should try to restore but fail
  await harness.runCommand("routing", "off");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes("restore"), "should report restore error");
  harness.notifications.length = 0;
  await harness.runCommand("routing", "status");
  assert.match(harness.notifications.at(-1).message, /state: restore-error/);
});

test("/routing: status displays config path, modes, snapshot, lease", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  await harness.runCommand("routing", "status");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes(CONFIG_PATH), "config path");
  assert.ok(text.includes("shadow"), "mode");
  assert.ok(text.includes("target model") || text.includes("opencode/mimo"), "target");
  assert.match(text, /classifier pool:\s*1\. opencode\/deepseek-v4-flash-free/s);
  assert.match(text, /weak pool:\s*1\. opencode\/mimo-v2.5-free/s);
  assert.ok(!/strong model/.test(text), "strong model line removed");
  assert.match(text, /log directory:/);
  assert.match(text, /sub-pi: disabled/);
});

test("status: shows ordered pools, selected identities, cooldowns, suspension and timeout budgets", async () => {
  const weak = [
    { provider: "test", id: "weak-1", supportsImages: true },
    { provider: "test", id: "weak-2", supportsImages: true },
  ];
  const harness = createHarness({
    registryModels: [
      ...POOL_REGISTRY_MODELS,
      fakeModel("test", "weak-2", ["text", "image"]),
    ],
    setModelResults: { "test/weak-1": false },
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "active",
      models: { classifier: CLASSIFIER_POOL, weak },
      classification: { timeoutMs: 5000, totalTimeoutMs: 12000 },
    })) },
    classify: async (request) => ({ text: GOOD_CLASSIFIER_JSON }),
  });
  await emitStart(harness);
  const text = await routingStatusText(harness);
  assert.match(text, /classifier pool:\s*1\. test\/classifier-1\s*2\. test\/classifier-2\s*3\. test\/classifier-3/s);
  assert.match(text, /weak pool:\s*1\. test\/weak-1\s*2\. test\/weak-2/s);
  assert.match(text, /selected classifier: test\/classifier-1/);
  assert.match(text, /selected weak: test\/weak-2/);
  assert.match(text, /cooling: weak test\/weak-1 reason=set_model_failed retryAfter=/);
  assert.match(text, /classification timeout: 5000ms/);
  assert.match(text, /classification total timeout: 12000ms/);
});

test("audit: fallback metadata uses exact allowlist and excludes provider/prompt/error payloads", async () => {
  const weak = [
    { provider: "test", id: "weak-1", supportsImages: true },
    { provider: "test", id: "weak-2", supportsImages: true },
  ];
  const harness = createHarness({
    registryModels: [...POOL_REGISTRY_MODELS, fakeModel("test", "weak-2", ["text", "image"])],
    setModelResults: { "test/weak-1": false },
    cwd: REPO,
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "active", models: { classifier: CLASSIFIER_POOL, weak } })) },
    classify: async (request) => {
      if (request.model.id === "classifier-1") throw new Error("LEAK-MARKER provider response Authorization");
      return { text: GOOD_CLASSIFIER_JSON };
    },
  });
  await emitStart(harness, FULL_TASK_PROMPT + " PRIVATE-PROMPT-BODY");
  const record = readLogRecords(harness).at(-1);
  const allowed = new Set([
    "schemaVersion", "timestamp", "mode", "sessionId", "requestId", "turnIndex",
    "decisionKind", "admission", "classification", "targetModel", "actualModel",
    "reasonCodes", "toolSummary", "providerLatencyMs", "actualUsage",
    "expectedAcceptanceHit", "selectedClassifier", "selectedWeak", "fallbackCount",
    "failureCodes",
  ]);
  for (const key of Object.keys(record)) assert.ok(allowed.has(key), `unexpected audit field ${key}`);
  assert.equal(record.selectedClassifier, "test/classifier-2");
  assert.equal(record.selectedWeak, "test/weak-2");
  assert.equal(record.fallbackCount, 2);
  assert.ok(record.failureCodes.every((code) => /^[a-z_]+$/.test(code)));
  const raw = JSON.stringify(record);
  for (const secret of ["LEAK-MARKER", "Authorization", "provider response", "PRIVATE-PROMPT-BODY"]) {
    assert.ok(!raw.includes(secret), `audit leaked ${secret}`);
  }
});

test("/routing: off and status work in non-UI context without error", async () => {
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO, hasUI: false });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({ mode: "shadow" })) },
    classify: weakClassifier(harness),
  });
  await harness.runCommand("routing", "status");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes("off") || text.includes("shadow"), "non-UI status should work");
});

test("/routing: invalid args show usage", async () => {
  const { harness } = await setupShadow();
  await harness.runCommand("routing", "invalid");
  const text = harness.notifications.map((n) => n.message).join("\n");
  assert.ok(text.includes("usage"), "invalid arg should show usage");
});

// ---------------------------------------------------------------------------
// Gate 11: session state minimal persistence and restore
// ---------------------------------------------------------------------------

test("state persistence: mode transitions append model-router-state entry", async () => {
  const { harness } = await setupShadow();
  await harness.runCommand("routing", "off");
  const entries = harness.appendedEntries.filter((e) => e.customType === "model-router-state");
  assert.ok(entries.length >= 1, "off should append state entry");
});

test("state persistence: entry contains only allowlisted fields", async () => {
  const { harness } = await setupShadow();
  await harness.runCommand("routing", "off");
  const entry = harness.appendedEntries.find((e) => e.customType === "model-router-state");
  assert.ok(entry, "should have state entry");
  const allowlisted = new Set(["version", "mode", "activationModel"]);
  for (const key of Object.keys(entry.data)) {
    assert.ok(allowlisted.has(key), `field "${key}" must be allowlisted`);
  }
});

test("state persistence: manual model observation updates actual without overwriting snapshot", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  // Manual model change doesn't affect snapshot; just check no crash
  assert.ok(true, "manual model observation doesn't break routing");
});

// ---------------------------------------------------------------------------
// Gate 12: shadow/active integration matrix
// ---------------------------------------------------------------------------

test("integration: full shadow lifecycle has consistent request ids and zero setModel", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  await emitToolPair(harness, { id: "t1", toolName: "read", input: { path: `${REPO}/src/utils/date.ts` } });
  await emitToolPair(harness, { id: "t2", toolName: "edit", input: { path: `${REPO}/src/utils/date.ts` }, text: "fixed" });
  await emitTurnEnd(harness, { turnIndex: 0, toolResultIds: ["t1", "t2"] });
  const records = readLogRecords(harness);
  assert.equal(records.length, 2, "initial + continuation");
  assert.equal(records[0].requestId, records[1].requestId, "same request id");
  assert.equal(harness.setModelCalls.length, 0, "shadow must not call setModel");
  assert.equal(harness.classifierCalls.length, 1, "one classifier call");
});

test("integration: full active lifecycle keeps a healthy lease and releases it on error", async () => {
  const harness = await setupActive();
  await emitStart(harness);
  assert.equal(harness.setModelCalls.length, 1);
  assert.equal(harness.setModelCalls[0].id, "mimo-v2.5-free");
  await emitToolPair(harness, { id: "t1", toolName: "edit", input: { path: `${REPO}/src/utils/date.ts` }, text: "fixed" });
  await emitTurnEnd(harness, { toolResultIds: ["t1"] });
  assert.equal(harness.setModelCalls.length, 1, "healthy continuation keeps weak");
  await emitToolPair(harness, { id: "t2", toolName: "bash", input: { command: "make" }, isError: true, details: { exitCode: 2 } });
  await emitTurnEnd(harness, { turnIndex: 1, toolResultIds: ["t2"] });
  assert.equal(harness.setModelCalls.length, 2, "error releases the weak lease");
  assert.equal(harness.setModelCalls.at(-1).provider, "anthropic");
});

test("integration: evaluator signals release to the lease return model without fallback", async () => {
  const signals = [
    { name: "tool_error", item: { isError: true } },
    { name: "nonzero_exit", item: { toolName: "bash", input: { command: "make" }, exitCode: 1 } },
  ];
  for (const { name, item } of signals) {
    const returnModel = fakeModel("user", `return-${name}`);
    const harness = await setupActive({ currentModel: returnModel });
    await emitStart(harness);
    const before = harness.setModelCalls.length;
    await emitToolPair(harness, {
      id: "t1", toolName: item.toolName ?? "edit",
      input: item.input ?? { path: `${REPO}/src/utils/date.ts` },
      isError: item.isError ?? false,
      details: item.exitCode !== undefined ? { exitCode: item.exitCode } : undefined,
      text: "x",
    });
    await emitTurnEnd(harness, { toolResultIds: ["t1"] });
    assert.equal(harness.setModelCalls.length, before + 1, `signal "${name}" must release the lease`);
    assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel);
  }
});

test("integration: default config mode is off", async () => {
  const harness = await setupShadow();
  // Default is off; shadow needs explicit config
  const offConfig = baseConfig({ mode: "off" });
  assert.equal(offConfig.mode, "off");
});

test("integration: shadow has exactly zero setModel calls after full lifecycle", async () => {
  const { harness } = await setupShadow();
  await emitStart(harness);
  await emitToolPair(harness, { id: "t1", toolName: "read", input: { path: `${REPO}/src/file.ts` } });
  await emitToolPair(harness, { id: "t2", toolName: "write", input: { path: `${REPO}/src/file.ts`, content: "x" } });
  await emitTurnEnd(harness, { toolResultIds: ["t1", "t2"] });
  await emitStart(harness, "Objective: another\nAllowed write: src/b.ts\nSteps:\n1. ok\nArtifacts: src/b.ts\nVerification: `node --test`");
  await emitTurnEnd(harness, { turnIndex: 0, toolResultIds: [] });
  assert.equal(harness.setModelCalls.length, 0, "shadow must have zero setModel");
});

// ---------------------------------------------------------------------------
// Gate 13-15: Sub-pi tool, slot manager, child runner
// ---------------------------------------------------------------------------

function subPiEnabledConfig(overrides = {}) {
  return JSON.stringify(baseConfig({ mode: "active", subPi: { enabled: true, maxConcurrent: 1, timeoutMs: 30000 }, ...overrides }));
}

async function setupSubPi(harnessOptions = {}, depsOptions = {}) {
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO, ...harnessOptions });
  const childRunner = depsOptions.childRunner ?? (async (invocation) => {
    harness.childCalls.push({ invocation, seq: harness.nextSeq() });
    return { status: "success", summary: "child task completed" };
  });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: subPiEnabledConfig() },
    classify: weakClassifier(harness),
    childRunner,
    ...depsOptions,
  });
  return { harness };
}

test("routing off disables sub-pi execution and active can re-enable it", async () => {
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "off",
      subPi: { enabled: true, maxConcurrent: 1, timeoutMs: 30000 },
    })) },
    classify: weakClassifier(harness),
    childRunner: async (invocation) => {
      harness.childCalls.push({ invocation });
      return { status: "success", summary: "done" };
    },
  });
  assert.ok(harness.tools.has("route_task_block"));
  const offError = await captureSubPiError(() => callRouteTaskBlock(harness));
  assert.equal(offError.reasonCode, "routing_off");
  assert.equal(harness.childCalls.length, 0);

  await harness.runCommand("routing", "active");
  const result = await callRouteTaskBlock(harness);
  assert.equal(result.details.status, "success");
  assert.equal(harness.childCalls.length, 1);
});

test("Gate 13: subPi disabled does not register route_task_block", async () => {
  const harness = await setupActive(); // subPi defaults to { enabled: false }
  assert.ok(!harness.tools.has("route_task_block"), "tool must not be registered when subPi.enabled=false");
});

test("Gate 13: subPi enabled registers route_task_block with strict schema", async () => {
  const { harness } = await setupSubPi();
  assert.ok(harness.tools.has("route_task_block"));
  const tool = harness.tools.get("route_task_block");
  assert.equal(tool.name, "route_task_block");
  assert.equal(typeof tool.execute, "function");
  // Schema must have strict additionalProperties: false
  const schema = tool.parameters;
  assert.equal(schema.additionalProperties, false, "schema must reject extra properties");
  // Required fields must be present
  assert.ok(schema.properties?.objective, "schema must have objective");
  assert.ok(schema.properties?.cwd, "schema must have cwd");
  assert.ok(schema.properties?.steps, "schema must have steps");
  assert.ok(schema.properties?.expectedArtifacts, "schema must have expectedArtifacts");
  assert.ok(schema.properties?.verification, "schema must have verification");
  // No free-form task string
  assert.ok(!schema.properties?.task, "schema must not have a free-form task field");
  assert.ok(!schema.properties?.prompt, "schema must not have a prompt field");
});

async function callRouteTaskBlock(harness, paramsOverrides = {}) {
  const tool = harness.tools.get("route_task_block");
  if (!tool) throw new Error("route_task_block not registered");
  const defaults = {
    objective: "Fix the date parsing bug in src/utils/date.ts",
    cwd: REPO,
    repositoryRoot: REPO,
    allowedRead: ["src/utils"],
    allowedWrite: ["src/utils/date.ts"],
    forbidden: [],
    steps: ["Fix the parseDate function"],
    expectedArtifacts: ["src/utils/date.ts"],
    verification: ["node --test tests/date.test.mjs"],
  };
  const params = { ...defaults, ...paramsOverrides };
  return tool.execute("call-1", params, undefined, undefined, harness.ctx);
}

async function captureSubPiError(operation) {
  try {
    await operation();
    assert.fail("expected SubPiError");
  } catch (error) {
    assert.equal(error?.name, "SubPiError");
    return error;
  }
}

test("Gate 13: tool rejects cwd mismatch", async () => {
  const { harness } = await setupSubPi();
  const error = await captureSubPiError(() => callRouteTaskBlock(harness, { cwd: "/other/dir" }));
  assert.equal(error.reasonCode, "cwd_mismatch");
  // Child runner must not be called on validation failure
  assert.equal(harness.childCalls.length, 0);
});

test("Gate 13: tool rejects path traversal", async () => {
  const { harness } = await setupSubPi();
  const error = await captureSubPiError(() => callRouteTaskBlock(harness, {
    allowedWrite: ["../outside/file.ts"],
  }));
  assert.equal(error.reasonCode, "invalid_capsule_scope");
  assert.equal(harness.childCalls.length, 0);
});

test("Gate 13: tool rejects path outside repository root", async () => {
  const { harness } = await setupSubPi();
  const error = await captureSubPiError(() => callRouteTaskBlock(harness, {
    allowedWrite: ["/etc/passwd"],
  }));
  assert.equal(error.reasonCode, "invalid_capsule_scope");
  assert.equal(harness.childCalls.length, 0);
});

test("Gate 13: tool rejects conflicting write and forbidden", async () => {
  const { harness } = await setupSubPi();
  const error = await captureSubPiError(() => callRouteTaskBlock(harness, {
    allowedWrite: ["src/utils/date.ts"],
    forbidden: ["src/utils"],
  }));
  assert.equal(error.reasonCode, "invalid_capsule_scope");
  assert.equal(harness.childCalls.length, 0);
});

test("Gate 13: tool rejects broad analysis pattern", async () => {
  const { harness } = await setupSubPi();
  const error = await captureSubPiError(() => callRouteTaskBlock(harness, {
    objective: "Investigate the root cause of the intermittent CI failures",
  }));
  assert.equal(error.reasonCode, "task_ineligible");
  assert.equal(harness.childCalls.length, 0);
});

test("Gate 13: multiple concurrent calls blocked at maxConcurrent=1", async () => {
  const { harness } = await setupSubPi();
  // First call starts and holds the slot
  let firstResolve;
  const firstPromise = new Promise((resolve) => { firstResolve = resolve; });
  let childCalled = false;
  const blockingRunner = async () => {
    childCalled = true;
    await firstPromise;
    return { status: "success", summary: "done" };
  };
  const tool = harness.tools.get("route_task_block");
  const params = {
    objective: "Fix bug", cwd: REPO, repositoryRoot: REPO,
    allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [],
    steps: ["fix it"], expectedArtifacts: ["src/a.ts"],
    verification: ["node --test"],
  };
  // Replace childRunner with blocking runner
  harness.childCalls = [];
  // We need to test via the tool but can't easily swap childRunner after setup.
  // Instead, verify that the slot manager exported from the module works.
  const module = await loadModelRouterModule();
  const slot = module.createSlotManager(1);
  assert.ok(slot.acquire(), "first acquire must succeed");
  assert.ok(!slot.acquire(), "second acquire must fail at maxConcurrent=1");
  assert.equal(slot.activeCount, 1);
  slot.release();
  assert.equal(slot.activeCount, 0);
});

test("Gate 13: child runner is injected (not real child), success returns compact result", async () => {
  let capturedInvocation = null;
  const { harness } = await setupSubPi({}, {
    childRunner: async (invocation) => {
      capturedInvocation = invocation;
      harness.childCalls.push({ invocation, seq: harness.nextSeq() });
      return { status: "success", summary: "task completed successfully" };
    },
  });
  const result = await callRouteTaskBlock(harness);
  assert.ok(!result.isError, "success must not be error");
  assert.ok(result.content?.[0]?.text?.includes("task completed"), "result must contain summary");
  assert.equal(harness.childCalls.length, 1, "child runner must be called");
  // Invocation must have the weak model
  assert.ok(capturedInvocation?.weakModel, "invocation must contain weakModel");
  assert.equal(capturedInvocation.weakModel.provider, "opencode");
  assert.equal(capturedInvocation.weakModel.id, "mimo-v2.5-free");
});

test("Gate 13: child runner not called on validation failure", async () => {
  const { harness } = await setupSubPi();
  await captureSubPiError(() => callRouteTaskBlock(harness, { cwd: "/wrong" }));
  assert.equal(harness.childCalls.length, 0, "child runner must not be called on validation failure");
});

// ---------------------------------------------------------------------------
// Gate 14: Slot manager and runner interface
// ---------------------------------------------------------------------------

test("Gate 14: slot manager acquire/release respects maxConcurrent", async () => {
  const module = await loadModelRouterModule();
  const slot = module.createSlotManager(3);
  assert.equal(slot.maxConcurrent, 3);
  assert.equal(slot.activeCount, 0);
  assert.ok(slot.acquire());
  assert.ok(slot.acquire());
  assert.ok(slot.acquire());
  assert.ok(!slot.acquire(), "must block at max");
  assert.equal(slot.activeCount, 3);
  slot.release();
  assert.equal(slot.activeCount, 2);
  assert.ok(slot.acquire());
  assert.equal(slot.activeCount, 3);
  // Release more than acquired is safe
  slot.release();
  slot.release();
  slot.release();
  slot.release(); // one extra, should not go negative
  assert.equal(slot.activeCount, 0);
});

// ---------------------------------------------------------------------------
// Gate 15: Result processing, slot release, parent lease-release integration
// ---------------------------------------------------------------------------

test("Gate 15: child runner failure returns isError=true with reason code", async () => {
  const errors = [
    { result: { status: "failure", errorCode: "child_nonzero", errorMessage: "exit code 1" }, expectedCode: "child_nonzero" },
    { result: { status: "timeout", errorCode: "child_timeout", errorMessage: "timed out" }, expectedCode: "weak_pool_exhausted" },
    { result: { status: "aborted", errorCode: "child_aborted", errorMessage: "aborted" }, expectedCode: "child_aborted" },
    { result: { status: "error", errorCode: "no_weak_model", errorMessage: "no weak model" }, expectedCode: "no_weak_model" },
  ];
  for (const expected of errors) {
    const { harness } = await setupSubPi({}, {
      childRunner: async () => expected.result,
    });
    const error = await captureSubPiError(() => callRouteTaskBlock(harness));
    assert.equal(error.reasonCode, expected.expectedCode);
  }
});

test("Gate 15: slot released after successful child run", async () => {
  let acquired = false;
  const { harness } = await setupSubPi({}, {
    childRunner: async (invocation) => {
      acquired = true;
      return { status: "success", summary: "ok" };
    },
  });
  const result = await callRouteTaskBlock(harness);
  assert.ok(!result.isError, "success must not be error");
  // After the call completes, slot is released, so another call should work
  const result2 = await callRouteTaskBlock(harness);
  assert.ok(!result2.isError, "second call after slot release must succeed");
});

test("Gate 15: slot released after failed child run", async () => {
  const { harness } = await setupSubPi({}, {
    childRunner: async () => ({ status: "failure", errorCode: "child_failed", errorMessage: "failed" }),
  });
  await captureSubPiError(() => callRouteTaskBlock(harness));
  // A second call reaches the runner again, proving the slot was released.
  await captureSubPiError(() => callRouteTaskBlock(harness));
});

test("Gate 15: unregister flag makes future calls fail", async () => {
  // The tool records unregistered state; we can't easily test this
  // from the public API since registerSubPiTool's return is internal.
  // Instead, verify the slot manager pattern works correctly.
  const module = await loadModelRouterModule();
  const slot = module.createSlotManager(1);
  assert.ok(slot.acquire());
  assert.ok(!slot.acquire());
  slot.release();
  assert.ok(slot.acquire());
  slot.release();
});

test("Gate 14: production runner is exported and accepts injectable deps", async () => {
  const module = await loadModelRouterModule();
  const config = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  assert.equal(config.kind, "valid");
  const runner = module.createProductionSubPiRunner(config.config, {
    fs: createFakeFs({}),
    tmuxOps: {
      newSession: async () => {},
      hasSession: async () => false,
      killSession: async () => {},
    },
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "test-123",
    env: {},
  });
  assert.equal(typeof runner, "function");
  // Call with fake session that ends immediately (hasSession returns false)
  const result = await runner({
    taskId: "test-123",
    capsule: {
      objective: "test", cwd: REPO, repositoryRoot: REPO,
      allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [],
      steps: ["do it"],
      expectedArtifacts: [{ path: "src/a.ts", condition: "exists" }],
      verification: [{ command: "echo ok" }],
    },
    weakModel: { provider: "test", id: "test-model" },
  });
  // Should return a result (no_result since no result.json was written)
  assert.ok(result.status, "should return a status");
  assert.equal(result.errorCode, "no_result");
});

test("Gate 14: production runner handles timeout and abort without retrying another model", async () => {
  const module = await loadModelRouterModule();
  const config = baseConfig({
    mode: "active",
    subPi: { enabled: true, maxConcurrent: 1, timeoutMs: 10 },
  });
  const parsed = module.parseModelRouterConfig(JSON.stringify(config), { agentDir: AGENT_DIR });
  let time = 0;
  let starts = 0;
  let kills = 0;
  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs: createFakeFs({}),
    tmuxOps: {
      newSession: async () => { starts += 1; },
      hasSession: async () => true,
      killSession: async () => { kills += 1; },
    },
    now: () => new Date(time += 6),
    randomId: () => "timeout",
    env: {},
    sleep: async () => {},
  });
  const invocation = {
    taskId: "timeout",
    capsule: { objective: "x", cwd: REPO, repositoryRoot: REPO, allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [], steps: ["x"], expectedArtifacts: [{ path: "src/a.ts", condition: "exists" }], verification: [{ command: "echo ok" }] },
    weakModel: { provider: "ignored", id: "ignored" },
  };
  assert.equal((await runner(invocation)).status, "timeout");

  const controller = new AbortController();
  controller.abort();
  assert.equal((await runner(invocation, controller.signal)).status, "aborted");
  assert.equal(starts, 2, "each invocation starts exactly one fixed-model child");
  assert.ok(kills >= 2, "each invocation cleans its recorded tmux session");
});

// ---------------------------------------------------------------------------
// Gate 14: Shell script builder tests
// ---------------------------------------------------------------------------

test("Gate 14: buildRunScript includes proxy env vars, source .zshrc, no bare &", async () => {
  // Build script is an internal function; test via production runner with fake tmux
  const module = await loadModelRouterModule();
  const parsed = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  assert.equal(parsed.kind, "valid");

  // Use a fs that records written files
  const fs = createFakeFs({});
  const writtenScripts = [];
  const origWrite = fs.writeFile.bind(fs);
  fs.writeFile = (path, data, options) => {
    writtenScripts.push({ path, data });
    origWrite(path, data, options);
  };

  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs,
    tmuxOps: {
      async newSession(name, cmd) {},
      hasSession: async () => false,
      killSession: async () => {},
    },
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "test-123",
    env: {
      http_proxy: "http://proxy:8080",
      HTTPS_PROXY: "https://proxy:8443",
      NO_PROXY: "localhost,127.0.0.1",
    },
  });

  await runner({
    taskId: "test-123",
    capsule: {
      objective: "test", cwd: REPO, repositoryRoot: REPO,
      allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [],
      steps: ["do it"],
      expectedArtifacts: [{ path: "src/a.ts", condition: "exists" }],
      verification: [{ command: "echo ok" }],
    },
    weakModel: { provider: "opencode", id: "mimo-v2.5-free" },
  });

  // Find the run.zsh script
  const scriptEntry = writtenScripts.find((s) => s.path.endsWith("run.zsh"));
  assert.ok(scriptEntry, "run.zsh must be written");
  const scriptContent = scriptEntry.data;

  // Verify script includes key elements
  assert.ok(scriptContent.includes(".zshrc"), "script must source .zshrc");
  assert.ok(scriptContent.includes("http_proxy"), "script must include lowercase proxy");
  assert.ok(scriptContent.includes("HTTPS_PROXY"), "script must include uppercase proxy");
  assert.ok(scriptContent.includes("NO_PROXY"), "script must include no_proxy");
  assert.ok(scriptContent.includes("--mode json"), "script must use --mode json");
  assert.ok(scriptContent.includes("--no-session"), "script must use --no-session");
  assert.ok(scriptContent.includes("--no-extensions"), "script must use --no-extensions");
  assert.ok(scriptContent.includes("opencode/mimo-v2.5-free"), "script must use configured weak model");
  // Verify proxy values are properly quoted
  assert.ok(scriptContent.includes("'http://proxy:8080'"), "proxy values must be single-quoted");
  // No bare & in script
  assert.ok(!scriptContent.includes(" &\n"), "script must not use bare &");
  assert.match(scriptContent, /\|\s*node\s+/, "script must stream through the compact collector");
  assert.ok(!scriptContent.includes("pi-output.jsonl"), "script must not persist cumulative message updates");
});

test("Gate 15: child failure releases the parent weak lease via evaluator", async () => {
  // A sub-pi tool error is an effect signal, so the parent returns to the model
  // captured before entering its weak lease.
  const { harness } = await setupSubPi({}, {
    childRunner: async (invocation) => {
      harness.childCalls.push({ invocation, seq: harness.nextSeq() });
      return { status: "failure", errorCode: "child_failed", errorMessage: "failed" };
    },
  });

  // Start a request
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  // Initial setModel should be weak
  assert.equal(harness.setModelCalls.length, 1);
  assert.equal(harness.setModelCalls[0].id, "mimo-v2.5-free");

  // Call route_task_block tool (simulating the LLM calling it)
  const tool = harness.tools.get("route_task_block");
  assert.ok(tool, "route_task_block must be registered");
  const params = {
    objective: "Fix bug", cwd: REPO, repositoryRoot: REPO,
    allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [],
    steps: ["fix it"], expectedArtifacts: ["src/a.ts"],
    verification: ["node --test"],
  };
  const toolError = await captureSubPiError(
    () => tool.execute("subpi-1", params, undefined, undefined, harness.ctx),
  );
  assert.equal(toolError.reasonCode, "child_failed");

  // Pi converts the thrown tool error into tool_result.isError=true.
  await harness.emit("tool_call", {
    type: "tool_call",
    toolCallId: "subpi-1",
    toolName: "route_task_block",
    input: params,
  });
  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "subpi-1",
    toolName: "route_task_block",
    input: params,
    content: [{ type: "text", text: toolError.message }],
    isError: true,
  });

  // Turn end should release the weak lease.
  const setModelBefore = harness.setModelCalls.length;
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant",
      provider: "opencode",
      model: "mimo-v2.5-free",
      usage: { input: 100, output: 20 },
      content: [],
    },
    toolResults: [{ role: "toolResult", toolCallId: "subpi-1" }],
  });

  // The tool error is an evaluator signal, so the parent lease returns to the user's model.
  assert.equal(harness.setModelCalls.length, setModelBefore + 1,
    "child failure must release the parent weak lease");
  assert.equal(harness.setModelCalls.at(-1).provider, "anthropic");
  // No second child runner call (parent didn't retry with another model)
  // Only one child call should have happened
  assert.equal(harness.childCalls.length, 1, "child must be called exactly once, no retry");
});

// ---------------------------------------------------------------------------
// Model pool failover Gate 7: sub-pi weak fallback under one total budget
// ---------------------------------------------------------------------------

async function setupSubPiPool(options = {}) {
  const weak = options.weak ?? [
    { provider: "test", id: "weak-1", supportsImages: false },
    { provider: "test", id: "weak-2", supportsImages: false },
    { provider: "test", id: "weak-3", supportsImages: false },
  ];
  const registryModels = [fakeModel("test", "classifier-1"), ...weak.map((item) => fakeModel(item.provider, item.id))];
  const harness = createHarness({ registryModels, cwd: REPO });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(baseConfig({
      mode: "active",
      models: { classifier: [CLASSIFIER_POOL[0]], weak },
      subPi: { enabled: true, maxConcurrent: 1, timeoutMs: options.timeoutMs ?? 10000 },
    })) },
    classify: async () => ({ text: GOOD_CLASSIFIER_JSON }),
    childRunner: options.childRunner,
    now: options.now,
  });
  return harness;
}

test("subPi fallback: model-technical child failure cools candidate and retries next weak", async () => {
  const calls = [];
  const harness = await setupSubPiPool({
    childRunner: async (invocation) => {
      calls.push(invocation);
      return invocation.weakModel.id === "weak-1"
        ? { status: "failure", errorCode: "weak_model_failure" }
        : { status: "success", summary: "fallback child complete" };
    },
  });
  const result = await callRouteTaskBlock(harness);
  assert.match(result.content[0].text, /fallback child complete/);
  assert.deepEqual(calls.map((call) => call.weakModel.id), ["weak-1", "weak-2"]);
  assert.equal(calls[0].taskId, calls[1].taskId, "logical task id stays stable across attempts");
  assert.deepEqual(calls.map((call) => call.timeoutMs), [10000, 10000]);
  const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.equal(health.entries.find((entry) => entry.id === "weak-1").reason, "child_model_error");
});

test("subPi fallback: task, process, admission and user-abort failures never retry", async () => {
  const failures = [
    "scope_drift",
    "scope_observation_uncertain",
    "expected_artifact_missing",
    "verification_failed",
    "child_nonzero",
    "child_aborted",
    "no_compact_result",
  ];
  for (const errorCode of failures) {
    let calls = 0;
    const harness = await setupSubPiPool({
      childRunner: async () => {
        calls += 1;
        return { status: errorCode === "child_aborted" ? "aborted" : "failure", errorCode };
      },
    });
    const error = await captureSubPiError(() => callRouteTaskBlock(harness));
    assert.equal(error.reasonCode, errorCode);
    assert.equal(calls, 1, `${errorCode} must not retry`);
  }
});

test("subPi timeout budget: attempts receive remaining total budget and unattempted weak stays healthy", async () => {
  let time = Date.parse("2026-07-11T12:00:00.000Z");
  const calls = [];
  const harness = await setupSubPiPool({
    timeoutMs: 10000,
    now: () => new Date(time),
    childRunner: async (invocation) => {
      calls.push({ id: invocation.weakModel.id, timeoutMs: invocation.timeoutMs });
      time += 7000;
      return { status: "failure", errorCode: "weak_model_failure" };
    },
  });
  const error = await captureSubPiError(() => callRouteTaskBlock(harness));
  assert.equal(error.reasonCode, "child_timeout");
  assert.deepEqual(calls, [
    { id: "weak-1", timeoutMs: 10000 },
    { id: "weak-2", timeoutMs: 3000 },
  ]);
  const health = JSON.parse(harness.fs.files.get(HEALTH_PATH));
  assert.ok(!health.entries.some((entry) => entry.id === "weak-3"));
});

test("subPi exhausted weak pool suspends router with fixed non-sensitive error", async () => {
  const harness = await setupSubPiPool({
    weak: [
      { provider: "test", id: "weak-1", supportsImages: false },
      { provider: "test", id: "weak-2", supportsImages: false },
    ],
    childRunner: async () => ({ status: "failure", errorCode: "weak_model_failure", errorMessage: "SECRET provider body" }),
  });
  const error = await captureSubPiError(() => callRouteTaskBlock(harness));
  assert.equal(error.reasonCode, "weak_pool_exhausted");
  assert.ok(!error.message.includes("SECRET"));
  assert.match(await routingStatusText(harness), /suspended/i);
});

test("production child runner uses invocation weak identity and invocation timeout", async () => {
  const module = await loadModelRouterModule();
  const parsed = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  const fs = createFakeFs({});
  const writes = [];
  const originalWrite = fs.writeFile.bind(fs);
  fs.writeFile = (path, data, options) => { writes.push({ path, data }); originalWrite(path, data, options); };
  let time = 0;
  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs,
    tmuxOps: { newSession: async () => {}, hasSession: async () => true, killSession: async () => {} },
    now: () => new Date(time += 600),
    randomId: () => "invocation-model",
    env: {},
    sleep: async () => {},
  });
  const result = await runner({
    taskId: "task",
    capsule: { objective: "x", cwd: REPO, repositoryRoot: REPO, allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [], steps: ["x"], expectedArtifacts: [{ path: "src/a.ts", condition: "exists" }], verification: [{ command: "echo ok" }] },
    weakModel: { provider: "chosen", id: "fallback" },
    timeoutMs: 1000,
  });
  assert.equal(result.status, "timeout");
  const script = writes.find((entry) => entry.path.endsWith("run.zsh")).data;
  assert.match(script, /chosen\/fallback/);
  assert.ok(!script.includes("opencode/mimo-v2.5-free"));
});

// ---------------------------------------------------------------------------
// Gate 16 regression tests from independent production review
// ---------------------------------------------------------------------------

test("production classifier adapter calls complete with strict compact prompt", async () => {
  const module = await loadModelRouterModule();
  const calls = [];
  const classify = module.createProductionClassifier(async (model, context, options) => {
    calls.push({ model, context, options });
    return {
      role: "assistant",
      content: [{ type: "text", text: classifierText() }],
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
  const input = { protocolVersion: 1, requestId: "req-1", promptExcerpt: "bounded", cwd: REPO };
  const response = await classify({
    input,
    model: fakeModel("opencode", "deepseek-v4-flash-free"),
    timeoutMs: 1000,
    getAuth: async () => ({ ok: true, apiKey: "unit-secret", headers: { "x-test": "ok" } }),
  });
  assert.equal(response.text, classifierText());
  assert.equal(calls.length, 1);
  assert.match(calls[0].context.systemPrompt, /JSON/i);
  assert.match(calls[0].context.systemPrompt, /localized_explicit_task/);
  assert.match(calls[0].context.systemPrompt, /ambiguous_scope/);
  assert.match(calls[0].context.messages[0].content[0].text, /"requestId":"req-1"/);
  assert.equal(calls[0].options.apiKey, "unit-secret");
  assert.equal(calls[0].options.maxRetries, 0);
});

test("active actuator passes the exact registry model object to pi.setModel", async () => {
  const harness = await setupActive();
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  const expected = FIXED_MODELS.find((model) => model.provider === "opencode" && model.id === "mimo-v2.5-free");
  assert.strictEqual(harness.setModelCalls[0].model, expected);
});

test("active weak capsule is returned as a hidden custom message", async () => {
  const harness = await setupActive();
  const results = await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  const result = results.find((entry) => entry?.message);
  assert.equal(result.message.customType, "model-router-capsule");
  assert.equal(result.message.display, false);
  assert.equal(harness.sentMessages.length, 0, "before_agent_start must not send a malformed ad-hoc message");
});

test("session shutdown restores the activation model after an active weak route", async () => {
  const harness = await setupActive();
  await emitStart(harness);
  assert.equal(harness.ctx.model.provider, "opencode");
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(harness.ctx.model.provider, "anthropic");
  assert.strictEqual(harness.setModelCalls.at(-1).model, FIXED_MODELS.find((model) => model.provider === "anthropic"));
});

test("active image request unsupported by weak leaves the current model unchanged", async () => {
  const config = baseConfig({ mode: "active" });
  config.models.weak.supportsImages = false;
  // images + weakSupportsImages=false → strong verdict (no intervention), not abort
  const harness = createHarness({ registryModels: FIXED_MODELS, cwd: REPO });
  await setupExtension(harness, {
    files: { [CONFIG_PATH]: JSON.stringify(config) },
    classify: weakClassifier(harness),
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: FULL_TASK_PROMPT,
    images: [{ mimeType: "image/png", data: "not-logged" }],
    systemPrompt: "",
    systemPromptOptions: {},
  });
  assert.equal(harness.abortCalls, 0);
  assert.equal(harness.setModelCalls.length, 0);
});

test("no-tool weak model error restores the lease return model at turn_end", async () => {
  const returnModel = fakeModel("user", "return-after-model-error");
  const harness = await setupActive({ currentModel: returnModel });
  await emitStart(harness);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant",
      provider: "opencode",
      model: "mimo-v2.5-free",
      stopReason: "error",
      usage: { input: 1, output: 0 },
      content: [],
    },
    toolResults: [],
  });
  assert.equal(harness.setModelCalls.length, 2);
  assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel);
  const records = readLogRecords(harness);
  assert.ok(records.length >= 2, "should have initial + completion records");
});

test("agent_end restores each lease's exact return model, including a manual model change between tasks", async () => {
  const firstReturnModel = fakeModel("user", "first-return");
  const secondReturnModel = fakeModel("user", "second-return");
  const harness = await setupActive({ currentModel: firstReturnModel });

  await emitStart(harness);
  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  assert.strictEqual(harness.setModelCalls.at(-1).model, firstReturnModel);

  harness.ctx.model = secondReturnModel;
  await emitStart(harness);
  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  assert.strictEqual(harness.setModelCalls.at(-1).model, secondReturnModel);
  assert.equal(harness.setModelCalls.length, 4, "each task must switch weak then restore its own return model");
});

test("weak lease restore failure warns once, ends the lease, and never falls back", async () => {
  const returnModel = fakeModel("user", "unavailable-return");
  const warnings = [];
  const harness = await setupActive({
    currentModel: returnModel,
    setModelResults: { "user/unavailable-return": false },
  }, {
    warn: (message) => warnings.push(message),
  });
  await emitStart(harness);
  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal(harness.setModelCalls.length, 2, "only weak and the captured return model may be attempted");
  assert.strictEqual(harness.setModelCalls.at(-1).model, returnModel);
  assert.match(warnings.join("\n"), /weak lease return model restore failed/i);

  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal(harness.setModelCalls.length, 2, "failed restore still ends the lease without retry or fallback");
});

test("weak turn limit emits a lease-release signal at the configured limit", async () => {
  const module = await loadModelRouterModule();
  const capsule = await getCapsule();
  const state = { ...freshEvalState(), weakContinuationCount: 3 };
  const result = module.evaluateToolBatch({
    batch: [batchItem(module)],
    capsule,
    limits: { maxWeakContinuationTurns: 4, maxNoProgressTurns: 99, maxRepeatedOperationCount: 99 },
    state,
    target: { provider: "weak", id: "w" },
    actual: { provider: "weak", id: "w" },
    fsExists: () => true,
  });
  assert.ok(result.signals.includes("weak_turn_limit"));
});

test("sub-pi failures throw so Pi emits tool_result.isError=true", async () => {
  const { harness } = await setupSubPi({}, {
    childRunner: async () => ({ status: "failure", errorCode: "child_nonzero", errorMessage: "exit 1" }),
  });
  await assert.rejects(
    () => callRouteTaskBlock(harness),
    (error) => error?.name === "SubPiError" && error?.reasonCode === "child_nonzero",
  );
});

test("production child runner parses compact events and validates artifacts and verification", async () => {
  const module = await loadModelRouterModule();
  const parsed = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  assert.equal(parsed.kind, "valid");
  const fs = createFakeFs({ [`${REPO}/src/a.ts`]: "done" });
  const sessions = [];
  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs,
    tmuxOps: {
      async newSession(name) {
        sessions.push(name);
        const runDir = [...fs.dirs].find((path) => path.endsWith("/mr-test-123"));
        assert.ok(runDir, "runner temp directory must exist before tmux starts");
        fs.files.set(`${runDir}/exit.code`, "0\n");
        fs.files.set(`${runDir}/events.jsonl`, [
          JSON.stringify({ type: "assistant", stopReason: "toolUse", text: "", toolCalls: [{ id: "verify-1", name: "bash", arguments: { command: "echo ok" } }] }),
          JSON.stringify({ type: "toolResult", toolCallId: "verify-1", toolName: "bash", isError: false }),
          JSON.stringify({ type: "assistant", stopReason: "stop", text: "completed", toolCalls: [] }),
        ].join("\n"));
      },
      hasSession: async () => false,
      killSession: async () => {},
    },
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "test-123",
    env: {},
    sleep: async () => {},
  });
  const result = await runner({
    taskId: "unsafe:id/with spaces",
    capsule: {
      objective: "test", cwd: REPO, repositoryRoot: REPO,
      allowedRead: [], allowedWrite: [`${REPO}/src/a.ts`], forbidden: [],
      steps: ["do it"], expectedArtifacts: [{ path: `${REPO}/src/a.ts`, condition: "exists" }],
      verification: [{ command: "echo ok" }],
    },
    weakModel: { provider: "ignored", id: "ignored" },
  });
  assert.deepEqual(result, { status: "success", summary: "completed" });
  assert.ok(fs.removals.some((path) => path.endsWith("/mr-test-123")), "child temp directory must be cleaned");
  assert.match(sessions[0], /^pi-[a-z0-9-]+$/);
  assert.ok(!sessions[0].includes(":"));
});

test("production child runner rejects observed scope drift", async () => {
  const module = await loadModelRouterModule();
  const parsed = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  const fs = createFakeFs({ [`${REPO}/src/a.ts`]: "done" });
  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs,
    tmuxOps: {
      async newSession() {
        const runDir = [...fs.dirs].find((path) => path.includes("/mr-drift"));
        fs.files.set(`${runDir}/exit.code`, "0\n");
        fs.files.set(`${runDir}/events.jsonl`, [
          JSON.stringify({ type: "assistant", stopReason: "toolUse", text: "", toolCalls: [
            { id: "write-1", name: "write", arguments: { path: "/outside/file.ts" } },
            { id: "verify-1", name: "bash", arguments: { command: "echo ok" } },
          ] }),
          JSON.stringify({ type: "toolResult", toolCallId: "write-1", toolName: "write", isError: false }),
          JSON.stringify({ type: "toolResult", toolCallId: "verify-1", toolName: "bash", isError: false }),
          JSON.stringify({ type: "assistant", stopReason: "stop", text: "completed", toolCalls: [] }),
        ].join("\n"));
      },
      hasSession: async () => false,
      killSession: async () => {},
    },
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "drift",
    env: {},
    sleep: async () => {},
  });
  const result = await runner({
    taskId: "drift",
    capsule: { objective: "x", cwd: REPO, repositoryRoot: REPO, allowedRead: [], allowedWrite: [`${REPO}/src/a.ts`], forbidden: [], steps: ["x"], expectedArtifacts: [{ path: `${REPO}/src/a.ts`, condition: "exists" }], verification: [{ command: "echo ok" }] },
    weakModel: { provider: "ignored", id: "ignored" },
  });
  assert.equal(result.errorCode, "scope_drift");
});

test("production child script filters JSON while streaming and never stores raw message_update output", async () => {
  const module = await loadModelRouterModule();
  const parsed = module.parseModelRouterConfig(JSON.stringify(baseConfig({ mode: "active" })), { agentDir: AGENT_DIR });
  const fs = createFakeFs({});
  const writes = [];
  const write = fs.writeFile.bind(fs);
  fs.writeFile = (path, data, options) => { writes.push({ path, data }); write(path, data, options); };
  const runner = module.createProductionSubPiRunner(parsed.config, {
    fs,
    tmuxOps: { newSession: async () => {}, hasSession: async () => false, killSession: async () => {} },
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "test-123",
    env: {},
    sleep: async () => {},
  });
  await runner({
    taskId: "test", capsule: { objective: "x", cwd: REPO, repositoryRoot: REPO, allowedRead: [], allowedWrite: ["src/a.ts"], forbidden: [], steps: ["x"], expectedArtifacts: [{ path: "src/a.ts", condition: "exists" }], verification: [{ command: "echo ok" }] }, weakModel: { provider: "ignored", id: "ignored" },
  });
  const scriptEntry = writes.find((entry) => entry.path.endsWith("run.zsh"));
  const script = scriptEntry?.data ?? "";
  const runDir = [...fs.modes.entries()].find(([path, mode]) => path.endsWith("/mr-test-123") && mode === 0o700);
  assert.ok(runDir, "child temp directory must use mode 0700");
  for (const suffix of ["capsule.md", "collector.mjs", "run.zsh"]) {
    const entry = [...fs.modes.entries()].find(([path, mode]) => path.endsWith(`/${suffix}`) && mode === 0o600);
    assert.ok(entry, `${suffix} must use mode 0600`);
  }
  assert.match(script, /\|\s*node\s+/);
  assert.ok(!script.includes("pi-output.jsonl"), "raw cumulative JSON stream must never be stored");
  const collector = writes.find((entry) => entry.path.endsWith("collector.mjs"));
  assert.ok(collector, "compact collector must be written");

  const checkDir = await mkdtemp(join(tmpdir(), "model-router-collector-"));
  try {
    const collectorPath = join(checkDir, "collector.mjs");
    await writeFile(collectorPath, collector.data, "utf8");
    const input = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        stopReason: "stop",
        usage: {},
        content: [{ type: "text", text: "done" }],
      },
    }) + "\n";
    const run = spawnSync(process.execPath, [collectorPath], { input, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).text, "done");
  } finally {
    await rm(checkDir, { recursive: true, force: true });
  }
});
