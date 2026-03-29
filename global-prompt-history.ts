import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { homedir } from "node:os";

type PromptHistoryEntry = {
  timestamp: number;
  text: string;
  cwd: string;
  sessionFile?: string;
};

const HISTORY_FILE = `${homedir()}/.pi/agent/prompt-history.jsonl`;
const MAX_ITEMS = 200;
const MAX_VISIBLE = 12;

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function normalizePrompt(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function shouldPersistPrompt(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("/")) return false;
  if (text.startsWith("!")) return false;
  return true;
}

function parseHistoryLine(line: string): PromptHistoryEntry | null {
  try {
    const item = JSON.parse(line) as PromptHistoryEntry;
    if (!item || typeof item.text !== "string" || typeof item.cwd !== "string") return null;
    if (typeof item.timestamp !== "number") return null;
    return item;
  } catch {
    return null;
  }
}

function loadHistory(limit: number = MAX_ITEMS): PromptHistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const lines = readFileSync(HISTORY_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const items = lines
    .map(parseHistoryLine)
    .filter((item): item is PromptHistoryEntry => item !== null);
  return items.slice(-limit).reverse();
}

function appendHistory(entry: PromptHistoryEntry): void {
  ensureParentDir(HISTORY_FILE);
  appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

function previewText(text: string, max: number = 88): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 1))}…`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function toSelectItems(entries: PromptHistoryEntry[]): SelectItem[] {
  return entries.map((entry, index) => ({
    value: String(index),
    label: previewText(entry.text),
    description: `${formatTimestamp(entry.timestamp)}  ${basename(entry.cwd) || entry.cwd}`,
  }));
}

function filterHistory(entries: PromptHistoryEntry[], query: string): PromptHistoryEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return entries;
  return entries.filter((entry) => {
    return entry.text.toLowerCase().includes(trimmed) || entry.cwd.toLowerCase().includes(trimmed);
  });
}

async function pickHistoryEntry(
  ctx: ExtensionCommandContext,
  entries: PromptHistoryEntry[],
): Promise<PromptHistoryEntry | null> {
  const items = toSelectItems(entries);
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Prompt History")), 1, 0));
    container.addChild(new Text(theme.fg("muted", "最近的跨会话输入记录"), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • Enter 回填到编辑器 • Esc 取消"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result === null) return null;
  const index = Number(result);
  return Number.isInteger(index) ? entries[index] ?? null : null;
}

function getLastPrompt(query?: string): PromptHistoryEntry | null {
  const entries = filterHistory(loadHistory(), query ?? "");
  return entries[0] ?? null;
}

async function handleHistoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/history 仅支持交互模式", "warning");
    return;
  }

  const entries = filterHistory(loadHistory(), args);
  if (entries.length === 0) {
    const suffix = args.trim() ? `（过滤词: ${args.trim()}）` : "";
    ctx.ui.notify(`没有找到历史输入${suffix}`, "warning");
    return;
  }

  const picked = await pickHistoryEntry(ctx, entries);
  if (!picked) {
    ctx.ui.notify("已取消", "info");
    return;
  }

  ctx.ui.setEditorText(picked.text);
  ctx.ui.notify("已回填历史输入到编辑器", "info");
}

async function handleRetryLastCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const query = args.trim();
  const latest = getLastPrompt(query);
  if (!latest) {
    const suffix = query ? `（过滤词: ${query}）` : "";
    ctx.ui.notify(`没有可重试的历史输入${suffix}`, "warning");
    return;
  }

  const result = await ctx.newSession({
    parentSession: ctx.sessionManager.getSessionFile(),
  });
  if (result.cancelled) {
    ctx.ui.notify("新会话创建已取消", "info");
    return;
  }

  ctx.ui.setEditorText(latest.text);
  ctx.ui.notify("已新建会话，并回填最后一条输入", "info");
}

export default function promptHistoryExtension(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };

    const text = normalizePrompt(event.text);
    if (!shouldPersistPrompt(text)) return { action: "continue" };

    try {
      appendHistory({
        timestamp: Date.now(),
        text,
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`记录 prompt history 失败: ${message}`, "warning");
    }

    return { action: "continue" };
  });

  pi.registerCommand("history", {
    description: "选择跨会话历史输入，并回填到编辑器",
    handler: async (args, ctx) => {
      await handleHistoryCommand(args, ctx);
    },
  });

  pi.registerCommand("retry-last", {
    description: "新建会话，并回填最后一条历史输入",
    handler: async (args, ctx) => {
      await handleRetryLastCommand(args, ctx);
    },
  });
}
