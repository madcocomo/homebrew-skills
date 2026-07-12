#!/usr/bin/env node
/** Export model-router audit decisions enriched from Pi session history. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const HOME = process.env.HOME;
const AGENT_DIR = join(HOME, ".pi/agent");
const LOG_DIR = join(AGENT_DIR, "model-router-logs");
const SESSION_DIR = join(AGENT_DIR, "sessions");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function listFilesRecursively(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function auditFiles() {
  if (args.includes("--all")) {
    return existsSync(LOG_DIR)
      ? readdirSync(LOG_DIR).filter((name) => name.endsWith(".jsonl")).sort().map((name) => join(LOG_DIR, name))
      : [];
  }
  const date = option("--date") ?? new Date().toISOString().slice(0, 10);
  const path = join(LOG_DIR, `${date}.jsonl`);
  if (!existsSync(path)) throw new Error(`日志文件不存在: ${path}`);
  return [path];
}

function indexSessionFiles(sessionIds) {
  const index = new Map();
  for (const path of listFilesRecursively(SESSION_DIR)) {
    if (!path.endsWith(".jsonl")) continue;
    for (const sessionId of sessionIds) {
      if (basename(path).endsWith(`_${sessionId}.jsonl`)) index.set(sessionId, path);
    }
  }
  return index;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

function parseSession(path) {
  return readJsonl(path).flatMap((entry, index) => {
    const message = entry.message;
    if (!message?.role) return [];
    const timestamp = entry.timestamp ?? message.timestamp;
    const ts = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(ts)) return [];
    return [{ index, ts, message }];
  });
}

function nearest(messages, role, target, predicate = () => true) {
  const matches = messages.filter((item) => item.message.role === role && predicate(item));
  if (matches.length === 0) return undefined;
  return matches.reduce((best, item) =>
    Math.abs(item.ts - target) < Math.abs(best.ts - target) ? item : best
  );
}

function toolCallsOf(assistant) {
  const content = assistant?.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "toolCall").map((block) => ({
    id: block.id ?? null,
    name: block.name ?? "",
    arguments: block.arguments ?? {},
  }));
}

function toolResultsAfter(messages, assistant, auditTs) {
  if (!assistant) return [];
  const nextAssistant = messages.find((item) =>
    item.index > assistant.index && item.message.role === "assistant"
  );
  return messages.filter((item) =>
    item.message.role === "toolResult" && item.index > assistant.index &&
    (!nextAssistant || item.index < nextAssistant.index) && item.ts <= auditTs + 100
  ).map((item) => ({
    toolCallId: item.message.toolCallId ?? null,
    toolName: item.message.toolName ?? "",
    isError: item.message.isError === true,
    content: textContent(item.message.content),
  }));
}

function requestPrompts(records, sessions) {
  const prompts = new Map();
  for (const record of records.filter((item) => item.decisionKind === "initial")) {
    const messages = sessions.get(record.sessionId) ?? [];
    const user = nearest(messages, "user", Date.parse(record.timestamp));
    if (user) prompts.set(`${record.sessionId}:${record.requestId}`, textContent(user.message.content));
  }
  return prompts;
}

function enrichRecord(record, sessionPath, messages, prompts) {
  const base = baseRow(record);
  if (!sessionPath) return { ...base, ...emptyContext("session_not_found") };
  const auditTs = Date.parse(record.timestamp);
  const key = `${record.sessionId}:${record.requestId}`;
  const originalPrompt = prompts.get(key) ?? "";
  if (record.decisionKind === "initial") {
    const user = nearest(messages, "user", auditTs);
    if (!user) return { ...base, ...emptyContext("turn_not_found"), sessionFile: sessionPath };
    return { ...base, matchStatus: "matched", classificationBasis: "initial_user_request",
      sessionFile: sessionPath, matchDeltaMs: Math.abs(user.ts - auditTs),
      originalPrompt: textContent(user.message.content), assistantText: "", toolCalls: [], toolResults: [] };
  }
  const assistant = nearest(messages, "assistant", auditTs, (item) => item.ts <= auditTs + 100);
  if (!assistant) return { ...base, ...emptyContext("turn_not_found"), sessionFile: sessionPath, originalPrompt };
  const toolResults = toolResultsAfter(messages, assistant, auditTs);
  const lastTs = toolResults.length ? auditTs : assistant.ts;
  return { ...base, matchStatus: "matched",
    classificationBasis: record.decisionKind === "completion" ? "completion_no_new_classification" : "continuation_tool_batch",
    sessionFile: sessionPath, matchDeltaMs: Math.abs(lastTs - auditTs), originalPrompt,
    assistantText: textContent(assistant.message.content), toolCalls: toolCallsOf(assistant), toolResults };
}

function emptyContext(matchStatus) {
  return { matchStatus, classificationBasis: "unknown", sessionFile: "", matchDeltaMs: "",
    originalPrompt: "", assistantText: "", toolCalls: [], toolResults: [] };
}

function baseRow(record) {
  return {
    timestamp: record.timestamp, schemaVersion: record.schemaVersion, sessionId: record.sessionId,
    requestId: record.requestId, turnIndex: record.turnIndex, decisionKind: record.decisionKind,
    admissionVerdict: record.admission?.verdict ?? null,
    admissionReasonCodes: record.admission?.reasonCodes ?? [],
    route: record.route ?? null,
    decisionReasonCodes: record.reasonCodes ?? [],
    classification: record.classification ?? null,
    actualModel: record.actualModel, targetModel: record.targetModel,
  };
}

function printTsv(rows) {
  const headers = ["timestamp", "schemaVersion", "decisionKind", "admissionVerdict", "admissionReasonCodes",
    "route", "decisionReasonCodes", "classification", "requestId", "sessionId", "actualModel", "targetModel",
    "matchStatus", "classificationBasis", "matchDeltaMs", "sessionFile", "originalPrompt", "assistantText",
    "toolCalls", "toolResults"];
  console.log(headers.join("\t"));
  for (const row of rows) console.log(headers.map((key) => tsvCell(row[key])).join("\t"));
}

function tsvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
}

const records = auditFiles().flatMap(readJsonl);
const sessionPaths = indexSessionFiles(new Set(records.map((record) => record.sessionId).filter(Boolean)));
const sessions = new Map([...sessionPaths].map(([id, path]) => [id, parseSession(path)]));
const prompts = requestPrompts(records, sessions);
const rows = records.map((record) => enrichRecord(record, sessionPaths.get(record.sessionId), sessions.get(record.sessionId) ?? [], prompts));

if ((option("--format") ?? "tsv") === "json") console.log(JSON.stringify(rows, null, 2));
else printTsv(rows);

const matched = rows.filter((row) => row.matchStatus === "matched").length;
console.error(`\n导出完成: ${rows.length} 条记录, ${matched} 条关联到 session 请求上下文`);
