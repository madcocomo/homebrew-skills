import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const SCRIPT = new URL("../tools/export-decisions.mjs", import.meta.url).pathname;

function writeJsonl(path, entries) {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function message(timestamp, role, content, extra = {}) {
  return { type: "message", timestamp, message: { role, content, ...extra } };
}

test("exporter joins audit decisions with structured session request context", () => {
  const home = mkdtempSync(join(tmpdir(), "router-export-"));
  const agentDir = join(home, ".pi", "agent");
  const logDir = join(agentDir, "model-router-logs");
  const sessionDir = join(agentDir, "sessions", "--fixture-project--");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const sessionId = "11111111-1111-4111-8111-111111111111";
  const requestId = "22222222-2222-4222-8222-222222222222";
  writeJsonl(join(logDir, "2026-07-12.jsonl"), [
    { timestamp: "2026-07-12T10:00:00.100Z", schemaVersion: 2, sessionId, requestId, turnIndex: 0, decisionKind: "initial", admission: { verdict: "eligible", reasonCodes: ["bounded_scope"] }, classification: { status: "ok", route: "weak", confidence: 0.91, riskFlags: [], reasonCode: "localized_explicit_task" }, route: "weak", reasonCodes: ["classifier_weak"] },
    { timestamp: "2026-07-12T10:00:02.030Z", schemaVersion: 2, sessionId, requestId, turnIndex: 0, decisionKind: "continuation", admission: { verdict: "eligible", reasonCodes: [] }, classification: { status: "ok" }, route: "weak", toolSummary: { count: 1 } },
    { timestamp: "2026-07-12T10:00:04.010Z", schemaVersion: 2, sessionId, requestId, turnIndex: 1, decisionKind: "completion", admission: { verdict: "eligible", reasonCodes: [] }, classification: { status: "ok" }, route: "weak", toolSummary: { count: 0 } },
  ]);

  writeJsonl(join(sessionDir, `2026-07-12T10-00-00-000Z_${sessionId}.jsonl`), [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-07-12T10:00:00.000Z", cwd: "/fixture" },
    message("2026-07-12T10:00:00.120Z", "user", [{ type: "text", text: "检查并修复解析器" }]),
    message("2026-07-12T10:00:02.000Z", "assistant", [
      { type: "text", text: "我先读取目标文件。" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/fixture/parser.ts" } },
    ]),
    message("2026-07-12T10:00:02.020Z", "toolResult", [{ type: "text", text: "export function parse() {}" }], {
      toolCallId: "call-1", toolName: "read", isError: false,
    }),
    message("2026-07-12T10:00:04.000Z", "assistant", [{ type: "text", text: "修复已完成。" }]),
  ]);

  const stdout = execFileSync(process.execPath, [SCRIPT, "--all", "--format", "json"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  const rows = JSON.parse(stdout);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].matchStatus, "matched");
  assert.equal(rows[0].classificationBasis, "initial_user_request");
  assert.equal(rows[0].originalPrompt, "检查并修复解析器");
  assert.deepEqual(rows[0].admissionReasonCodes, ["bounded_scope"]);
  assert.deepEqual(rows[0].decisionReasonCodes, ["classifier_weak"]);
  assert.deepEqual(rows[0].classification, {
    status: "ok", route: "weak", confidence: 0.91, riskFlags: [], reasonCode: "localized_explicit_task",
  });

  assert.equal(rows[1].classificationBasis, "continuation_tool_batch");
  assert.equal(rows[1].originalPrompt, "检查并修复解析器");
  assert.equal(rows[1].assistantText, "我先读取目标文件。");
  assert.deepEqual(rows[1].toolCalls, [
    { id: "call-1", name: "read", arguments: { path: "/fixture/parser.ts" } },
  ]);
  assert.deepEqual(rows[1].toolResults, [
    { toolCallId: "call-1", toolName: "read", isError: false, content: "export function parse() {}" },
  ]);

  assert.equal(rows[2].classificationBasis, "completion_no_new_classification");
  assert.equal(rows[2].assistantText, "修复已完成。");
  assert.deepEqual(rows[2].toolCalls, []);
  assert.deepEqual(rows[2].toolResults, []);
});

test("exporter reports a missing session instead of inventing context", () => {
  const home = mkdtempSync(join(tmpdir(), "router-export-missing-"));
  const logDir = join(home, ".pi", "agent", "model-router-logs");
  mkdirSync(logDir, { recursive: true });
  writeJsonl(join(logDir, "2026-07-12.jsonl"), [{
    timestamp: "2026-07-12T10:00:00.100Z",
    schemaVersion: 2,
    sessionId: "missing-session",
    requestId: "missing-request",
    turnIndex: 0,
    decisionKind: "initial",
    admission: { verdict: "user", reasonCodes: ["scope_ambiguous"] },
    classification: { status: "skipped" },
    route: "user",
  }]);

  const rows = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--all", "--format", "json"], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  }));
  assert.equal(rows[0].matchStatus, "session_not_found");
  assert.equal(rows[0].originalPrompt, "");
});
