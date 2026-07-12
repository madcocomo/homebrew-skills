import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = join(repoRoot, "extensions", "superpowers-bootstrap.ts");
const sampleSkill = `---
name: using-superpowers
description: Bootstrap guidance for pi.
disable-model-invocation: true
---

# Using Superpowers

Always check relevant skills before acting.
`;

function resolvePiPackageRoot() {
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const bases = [npmRoot];

  let current = dirname(process.execPath);
  while (true) {
    bases.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates = [];
  for (const base of bases) {
    candidates.push(
      join(base, "@earendil-works", "pi-coding-agent"),
      join(base, "@mariozechner", "pi-coding-agent"),
      join(base, ".npm", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
      join(base, ".npm", "lib", "node_modules", "@mariozechner", "pi-coding-agent"),
      join(base, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
      join(base, "lib", "node_modules", "@mariozechner", "pi-coding-agent"),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Could not locate pi-coding-agent in global npm directories");
}

async function loadBootstrapModule(layout = "repo") {
  const piPackageRoot = resolvePiPackageRoot();
  const jitiEntry = join(piPackageRoot, "node_modules", "jiti", "lib", "jiti.mjs");
  const tempDir = await mkdtemp(join(tmpdir(), "superpowers-bootstrap-test-"));
  const extensionDir = join(tempDir, "extensions");
  const copiedSource = join(extensionDir, "superpowers-bootstrap.ts");

  await mkdir(join(tempDir, "node_modules", "@earendil-works"), { recursive: true });
  await symlink(piPackageRoot, join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent"));
  await mkdir(extensionDir, { recursive: true });
  await copyFile(sourcePath, copiedSource);

  if (layout === "repo") {
    await mkdir(join(tempDir, "using-superpowers"), { recursive: true });
    await writeFile(join(tempDir, "using-superpowers", "SKILL.md"), sampleSkill, "utf8");
  } else if (layout === "global") {
    await mkdir(join(tempDir, "skills", "using-superpowers"), { recursive: true });
    await writeFile(join(tempDir, "skills", "using-superpowers", "SKILL.md"), sampleSkill, "utf8");
  }

  const { default: createJiti } = await import(pathToFileURL(jitiEntry).href);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
  });

  const module = await jiti.import(copiedSource);
  return { module, tempDir, extensionDir };
}

function createHarness(sessionEntries = []) {
  const handlers = new Map();
  return {
    pi: {
      on(name, handler) {
        handlers.set(name, handler);
      },
    },
    ctx: {
      sessionManager: {
        getEntries() {
          return sessionEntries;
        },
      },
    },
    handlers,
  };
}

test("extractAndStripFrontmatter removes YAML header and keeps body", async () => {
  const { module, tempDir } = await loadBootstrapModule();

  try {
    const result = module.extractAndStripFrontmatter(sampleSkill);
    assert.equal(result.frontmatter.name, "using-superpowers");
    assert.match(result.content, /^# Using Superpowers/m);
    assert.doesNotMatch(result.content, /^---/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("findUsingSuperpowersSkillPath supports repo and global layouts", async () => {
  const repoLayout = await loadBootstrapModule("repo");
  const globalLayout = await loadBootstrapModule("global");

  try {
    assert.equal(
      repoLayout.module.findUsingSuperpowersSkillPath(repoLayout.extensionDir),
      join(dirname(repoLayout.extensionDir), "using-superpowers", "SKILL.md"),
    );
    assert.equal(
      globalLayout.module.findUsingSuperpowersSkillPath(globalLayout.extensionDir),
      join(dirname(globalLayout.extensionDir), "skills", "using-superpowers", "SKILL.md"),
    );
  } finally {
    await rm(repoLayout.tempDir, { recursive: true, force: true });
    await rm(globalLayout.tempDir, { recursive: true, force: true });
  }
});

test("before_agent_start injects hidden bootstrap message from the using-superpowers skill", async () => {
  const { module, tempDir } = await loadBootstrapModule("repo");

  try {
    const harness = createHarness();
    module.default(harness.pi);
    const result = await harness.handlers.get("before_agent_start")({}, harness.ctx);

    assert.equal(result.message.customType, module.BOOTSTRAP_CUSTOM_TYPE);
    assert.equal(result.message.display, false);
    assert.match(result.message.content, /你已启用 superpowers/);
    assert.match(result.message.content, /Always check relevant skills before acting/);
    assert.doesNotMatch(result.message.content, /^name: using-superpowers/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("before_agent_start does not inject a duplicate bootstrap message", async () => {
  const { module, tempDir } = await loadBootstrapModule("repo");

  try {
    const harness = createHarness([
      { type: "custom_message", customType: module.BOOTSTRAP_CUSTOM_TYPE, content: "existing" },
    ]);
    module.default(harness.pi);
    const result = await harness.handlers.get("before_agent_start")({}, harness.ctx);

    assert.equal(result, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
