import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_CUSTOM_TYPE = "superpowers-bootstrap";

const BOOTSTRAP_PREFIX = [
  "<EXTREMELY_IMPORTANT>",
  "你已启用 superpowers。",
  "",
  "下面是 using-superpowers 的启动引导内容。它已经由 Pi extension 预加载；不要再专门读取 using-superpowers。",
  "对其它 skills，请沿用 Pi 的原生方式：先根据 available skills 判断是否适用，再用 read 打开对应的 SKILL.md。",
  "",
].join("\n");

const BOOTSTRAP_SUFFIX = "</EXTREMELY_IMPORTANT>";

type FrontmatterResult = {
  frontmatter: Record<string, string>;
  content: string;
};

let cachedBootstrap:
  | {
      extensionDir: string;
      content: string | null;
    }
  | undefined;

export function extractAndStripFrontmatter(content: string): FrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: content.trim() };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }

  return {
    frontmatter,
    content: match[2].trim(),
  };
}

export function findUsingSuperpowersSkillPath(
  extensionDir: string,
  pathExists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates = [
    join(extensionDir, "..", "using-superpowers", "SKILL.md"),
    join(extensionDir, "..", "skills", "using-superpowers", "SKILL.md"),
  ];

  return candidates.find((path) => pathExists(path));
}

export function buildBootstrapContent(skillBody: string): string {
  const body = skillBody.trim();
  return `${BOOTSTRAP_PREFIX}${body ? `\n${body}\n` : "\n"}${BOOTSTRAP_SUFFIX}`;
}

export function hasBootstrapMessage(entries: unknown[]): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as {
      type?: string;
      customType?: string;
      message?: { role?: string; customType?: string };
    };

    if (value.type === "custom_message" && value.customType === BOOTSTRAP_CUSTOM_TYPE) {
      return true;
    }

    return value.type === "message"
      && value.message?.role === "custom"
      && value.message.customType === BOOTSTRAP_CUSTOM_TYPE;
  });
}

function loadBootstrapContent(extensionDir: string): string | null {
  if (cachedBootstrap?.extensionDir === extensionDir) return cachedBootstrap.content;

  const skillPath = findUsingSuperpowersSkillPath(extensionDir);
  if (!skillPath) {
    cachedBootstrap = { extensionDir, content: null };
    return null;
  }

  const raw = readFileSync(skillPath, "utf8");
  const { content } = extractAndStripFrontmatter(raw);
  const bootstrap = buildBootstrapContent(content);
  cachedBootstrap = { extensionDir, content: bootstrap };
  return bootstrap;
}

export default function superpowersBootstrapExtension(pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));

  pi.on("before_agent_start", async (_event, ctx) => {
    if (hasBootstrapMessage(ctx.sessionManager.getEntries())) return;

    const content = loadBootstrapContent(extensionDir);
    if (!content) return;

    return {
      message: {
        customType: BOOTSTRAP_CUSTOM_TYPE,
        content,
        display: false,
      },
    };
  });
}
