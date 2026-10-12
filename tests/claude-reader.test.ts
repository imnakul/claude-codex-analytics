import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeAnalyticsSnapshot } from "../src/lib/claude-reader";
import { initialAnalytics } from "../src/lib/analytics-reader";
import { estimateThreadCost, estimateTurnCost, DEFAULT_MODEL_RATES } from "../src/lib/pricing";
import { threadTurnAnalyticsSchema } from "../src/lib/analytics-types";
import { spawnSync } from "node:child_process";
import { GET } from "../src/app/api/analytics/route";

let root: string;
let originalHome: string | undefined;
let originalLogs: string | undefined;
const at = (second: number): string => new Date(Date.UTC(2026, 9, 12, 0, 0, second)).toISOString();
function write(path: string, records: unknown[]): void {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
}
function user(second = 0, text = "Build an example", sessionId = "session-a") {
  return { type: "user", uuid: `user-${second}`, sessionId, cwd: "/example/project", timestamp: at(second), message: { content: text } };
}
function assistant(second: number, id: string, content: unknown[], options: Record<string, unknown> = {}) {
  return { type: "assistant", uuid: `block-${second}`, sessionId: "session-a", timestamp: at(second),
    message: { id, model: "claude-sonnet-4-6", content, usage: { input_tokens: 100, output_tokens: 20,
      cache_read_input_tokens: 50, cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 } }, ...options } };
}
beforeEach(() => {
  originalHome = process.env.CLAUDE_CONFIG_DIR;
  originalLogs = process.env.CLAUDE_LOG_DIR;
  root = mkdtempSync(join(tmpdir(), "claude-analytics-test-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  delete process.env.CLAUDE_LOG_DIR;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalHome;
  if (originalLogs === undefined) delete process.env.CLAUDE_LOG_DIR; else process.env.CLAUDE_LOG_DIR = originalLogs;
  rmSync(root, { recursive: true, force: true });
});

test("counts streaming message usage once, reconciles tools, and retains no outputs or arguments", () => {
  const path = "projects/project/session-a.jsonl";
  write(path, [user(), user(), assistant(1, "msg-a", [{ type: "tool_use", id: "tool-a", name: "Bash", input: { command: "ARGUMENT_SECRET" } }]),
    assistant(2, "msg-a", [{ type: "text", text: "ASSISTANT_SECRET" }]),
    { type: "user", sessionId: "session-a", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "tool-a", content: "RESULT_SECRET", is_error: true }] } },
    assistant(4, "msg-b", [{ type: "text", text: "Done" }], { stop_reason: "end_turn" }),
    { type: "system", subtype: "turn_duration", timestamp: at(5), durationMs: 4500 },
  ]);
  const before = readFileSync(join(root, path), "utf8");
  const snapshot = getClaudeAnalyticsSnapshot();
  const thread = snapshot.threads[0];
  assert.equal(thread.prompts, 1);
  assert.equal(thread.turns, 1);
  assert.equal(thread.inputTokens, 360);
  assert.equal(thread.outputTokens, 40);
  assert.equal(thread.totalTokens, 400);
  assert.equal(thread.cacheWriteTokens, 60);
  assert.equal(thread.cacheWriteLongTokens, 20);
  assert.equal(thread.cachedInputTokens, 100);
  assert.equal(thread.toolCalls, 1);
  assert.equal(thread.shellCommands, 1);
  assert.equal(thread.activeDurationMs, 4500);
  assert.equal(thread.durationSource, "reported");
  assert.equal(thread.timeToFirstTokenMs, null);
  assert.deepEqual(thread.turnDetails[0].toolCallDetails[0], {
    id: "tool-a", name: "Bash", startedAt: at(1), durationMs: 2000, status: "failed", source: "transcript",
  });
  assert.equal(thread.turnDetails[0].requestUsage.length, 2);
  assert.ok(!JSON.stringify(snapshot).includes("_SECRET"));
  assert.equal(readFileSync(join(root, path), "utf8"), before);
  const cost = estimateThreadCost(thread, {});
  assert.ok(cost);
  assert.ok(Math.abs(cost.total - 0.0015) < 1e-12);
});

test("enriches transcript tools with hooks without duplicates and adds hook-only failures", () => {
  process.env.CLAUDE_LOG_DIR = join(root, "logs");
  write("projects/project/session-a.jsonl", [user(), assistant(1, "msg-a", [{ type: "tool_use", id: "tool-a", name: "Bash" }])]);
  write("logs/tools.jsonl", [
    { session_id: "session-a", timestamp: at(1), hook_event_name: "PreToolUse", tool_use_id: "tool-a", tool_name: "Bash" },
    { session_id: "session-a", timestamp: at(2), hook_event_name: "PostToolUse", tool_use_id: "tool-a", tool_name: "Bash", tool_response: "RESULT_SECRET" },
    { session_id: "session-a", timestamp: at(3), hook_event_name: "PreToolUse", tool_use_id: "tool-b", tool_name: "WebFetch", tool_input: "ARGUMENT_SECRET" },
    { session_id: "session-a", timestamp: at(5), hook_event_name: "PostToolUseFailure", tool_use_id: "tool-b", tool_name: "WebFetch" },
  ]);
  const snapshot = getClaudeAnalyticsSnapshot();
  const thread = snapshot.threads[0];
  assert.equal(thread.toolCalls, 2);
  assert.equal(thread.webCalls, 1);
  assert.equal(thread.turnDetails[0].toolCallDetails[1].durationMs, 2000);
  assert.equal(thread.turnDetails[0].toolCallDetails[1].status, "failed");
  assert.ok(!JSON.stringify(snapshot).includes("_SECRET"));
});

test("keeps workers separate and routes their hook tools to the worker", () => {
  process.env.CLAUDE_LOG_DIR = join(root, "logs");
  write("projects/project/session-a.jsonl", [user(), assistant(1, "parent-msg", [], { stop_reason: "end_turn" })]);
  write("projects/project/session-a/subagents/agent-worker.jsonl", [
    { ...user(), isSidechain: true }, assistant(1, "worker-msg", [{ type: "tool_use", id: "worker-tool", name: "Read" }]),
  ]);
  write("logs/tools.jsonl", [{ session_id: "session-a", timestamp: at(3), tool_use_id: "worker-tool", tool_name: "Read", hook_event_name: "PostToolUse" }]);
  const snapshot = getClaudeAnalyticsSnapshot();
  const parent = snapshot.threads.find(thread => !thread.internal)!;
  const worker = snapshot.threads.find(thread => thread.internal)!;
  assert.equal(snapshot.threads.length, 2);
  assert.equal(parent.toolCalls, 0);
  assert.equal(worker.toolCalls, 1);
  assert.equal(worker.parentSessionId, "session-a");
  assert.equal(worker.turnDetails[0].toolCallDetails[0].status, "completed");
});

test("retains history-only, index-only, and hook-only sessions with unknown usage", () => {
  process.env.CLAUDE_LOG_DIR = join(root, "logs");
  write("history.jsonl", [{ sessionId: "history", project: "C:\\example\\project", timestamp: Date.parse(at(0)), display: "Saved prompt" }]);
  mkdirSync(join(root, "projects/project"), { recursive: true });
  writeFileSync(join(root, "projects/project/sessions-index.json"), JSON.stringify({ entries: [
    { sessionId: "index", firstPrompt: "Index prompt", projectPath: "/example/project", created: at(0), modified: at(2) },
  ] }));
  write("logs/tools.jsonl", [{ session_id: "hooks", timestamp: at(3), hook_event_name: "PostToolUseFailure", tool_use_id: "orphan", tool_name: "Bash" }]);
  const snapshot = getClaudeAnalyticsSnapshot();
  assert.equal(snapshot.threads.length, 3);
  for (const thread of snapshot.threads) {
    assert.equal(thread.hasDetailedUsage, false);
    assert.equal(estimateThreadCost(thread, {}), null);
  }
  assert.equal(snapshot.threads.find(thread => thread.id === "history")?.projectName, "project");
  const hookThread = snapshot.threads.find(thread => thread.id === "hooks")!;
  assert.equal(hookThread.toolCalls, 1);
  assert.equal(hookThread.turnDetails[0].toolCallDetails[0].durationMs, null);
});

test("handles missing directories, malformed lines, sparse usage, and fresh data on refresh", () => {
  assert.equal(getClaudeAnalyticsSnapshot().threads.length, 0);
  write("projects/project/session-a.jsonl", [user(), assistant(1, "msg-a", [], { usage: { output_tokens: 9 }, stop_reason: "end_turn" })]);
  const path = join(root, "projects/project/session-a.jsonl");
  writeFileSync(path, readFileSync(path, "utf8") + '{"unfinished":');
  const snapshot = getClaudeAnalyticsSnapshot();
  assert.equal(snapshot.threads[0].totalTokens, 9);
  assert.ok(snapshot.warnings.some(warning => warning.includes("malformed")));
  write("projects/project/session-a.jsonl", [user(), assistant(1, "msg-a", [], { usage: { output_tokens: 11 }, stop_reason: "end_turn" })]);
  assert.equal(getClaudeAnalyticsSnapshot().threads[0].totalTokens, 11);
});

test("prices each request's model, cache tier, and long-context threshold separately", () => {
  write("projects/project/session-a.jsonl", [user(),
    assistant(1, "small", [], { model: "claude-haiku-5-5", usage: { input_tokens: 90_000, output_tokens: 100 } }),
    assistant(2, "large", [], { model: "claude-haiku-5-5", usage: { input_tokens: 100_001, output_tokens: 100 }, stop_reason: "end_turn" }),
    user(3, "Second task"),
    assistant(4, "unknown", [], { model: "unknown-claude-model", usage: { input_tokens: 10, output_tokens: 2 }, stop_reason: "end_turn" }),
  ]);
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  assert.equal(thread.turns, 2);
  const firstCost = estimateTurnCost(thread.turnDetails[0], {});
  assert.ok(firstCost);
  assert.ok(Math.abs(firstCost.total - 0.0593005) < 1e-12);
  assert.equal(estimateThreadCost(thread, {}), null);
});

test("preserves Codex cache-read pricing and ignores absent cache writes", () => {
  const turn = threadTurnAnalyticsSchema.parse({ id: "codex", message: "Example", startedAt: at(0),
    model: "gpt-5.4", reasoningEffort: "high", durationMs: 100, timeToFirstTokenMs: null,
    totalTokens: 1100, inputTokens: 1000, peakInputTokens: 1000, cachedInputTokens: 400,
    outputTokens: 100, reasoningOutputTokens: 20, toolCalls: 0, shellCommands: 0, webCalls: 0, completed: true });
  const cost = estimateTurnCost(turn, DEFAULT_MODEL_RATES)!;
  assert.ok(Math.abs(cost.total - 0.0031) < 1e-12);
  assert.equal(cost.cacheWriteCost, 0);
});

test("validates providers and keeps the dashboard reachable without Codex state", async () => {
  const response = GET(new Request("http://localhost/api/analytics?provider=claude"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, "claude");
  assert.equal(GET(new Request("http://localhost/api/analytics?provider=../../etc")).status, 400);
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "missing-codex");
  try {
    const snapshot = initialAnalytics("codex");
    assert.equal(snapshot.provider, "codex");
    assert.equal(snapshot.threads.length, 0);
    assert.ok(snapshot.warnings.length);
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
});


test("dated model IDs inherit edited base-model rates", () => {
  write("projects/project/session-a.jsonl", [user(), assistant(1, "msg", [], {
    model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: "end_turn",
  })]);
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  const rates = { "claude-sonnet-4-5": { short: { input: 10, output: 20, cachedInput: 1, cacheWrite: 12.5 }, long: null } };
  assert.equal(estimateThreadCost(thread, rates)?.total, 0.012);
  rates["claude-sonnet-4-5-20250929" as keyof typeof rates] = { short: { input: 1, output: 1, cachedInput: 1, cacheWrite: 1 }, long: null };
  assert.equal(estimateThreadCost(thread, rates)?.total, 0.0011);
});

test("the optional hook collector writes supported metadata without tool content", context => {
  const python = ["python3", "python", "py"].find(command => {
    const version = spawnSync(command, ["--version"], { encoding: "utf8" });
    return version.status === 0 && /Python 3\./.test(`${version.stdout}${version.stderr}`);
  });
  if (!python) { context.skip("The optional hook collector requires Python 3."); return; }
  const result = spawnSync(python, ["scripts/log-claude-tool.py"], {
    input: JSON.stringify({ session_id: "collector-session", tool_use_id: "collector-tool", tool_name: "Bash",
      hook_event_name: "PreToolUse", tool_input: { command: "ARGUMENT_SECRET" }, tool_response: "RESULT_SECRET", error: "ERROR_SECRET" }),
    env: process.env, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const log = readFileSync(join(root, "analytics-tools/tools.jsonl"), "utf8");
  assert.ok(!log.includes("_SECRET"));
  assert.ok(Number.isFinite(Date.parse(JSON.parse(log).timestamp)));
  const snapshot = getClaudeAnalyticsSnapshot();
  assert.equal(snapshot.threads[0].toolCalls, 1);
  assert.equal(snapshot.threads[0].id, "collector-session");
});

test("counts image-only prompts and keeps tool-result annotations out of the prompt ledger", () => {
  write("projects/project/session-a.jsonl", [
    { ...user(), message: { content: [{ type: "image", source: { type: "base64", data: "IMAGE_SECRET" } }] } },
    assistant(1, "image-1", [{ type: "tool_use", id: "image-tool", name: "Read" }]),
    { type: "user", uuid: "tool-result", timestamp: at(2), message: { content: [
      { type: "tool_result", tool_use_id: "image-tool", content: "RESULT_SECRET" },
      { type: "text", text: "RESULT_ANNOTATION_SECRET" },
    ] } },
    { ...user(3), message: { content: [{ type: "image", source: { type: "base64", data: "IMAGE_SECRET" } }] } },
    assistant(4, "image-2", [], { stop_reason: "end_turn" }),
  ]);
  const snapshot = getClaudeAnalyticsSnapshot();
  const thread = snapshot.threads[0];
  assert.equal(thread.prompts, 2);
  assert.equal(thread.turns, 2);
  assert.equal(thread.turnDetails[0].message, "Image attachment");
  assert.equal(thread.turnDetails[0].toolCalls, 1);
  assert.ok(!JSON.stringify(snapshot).includes("_SECRET"));
});

test("retains every unique prompt from history when the transcript is unavailable", () => {
  const entries = [0, 2, 4].map(second => ({ sessionId: "history", project: "/example/project",
    timestamp: Date.parse(at(second)), display: `Prompt ${second}` }));
  write("history.jsonl", [...entries, entries[0]]);
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  assert.equal(thread.prompts, 3);
  assert.equal(thread.turns, 3);
  assert.deepEqual(thread.turnDetails.map(turn => turn.message), ["Prompt 0", "Prompt 2", "Prompt 4"]);
  assert.equal(thread.activeDurationMs, 0);
  assert.equal(thread.hasDetailedUsage, false);
  assert.equal(thread.usageCoverage, "unknown");
});

test("marks a turn with missing request usage as partial and leaves its full cost unknown", () => {
  write("projects/project/session-a.jsonl", [user(), assistant(1, "known", []),
    assistant(2, "missing", [], { usage: undefined, stop_reason: "end_turn" }),
  ]);
  const snapshot = getClaudeAnalyticsSnapshot();
  const thread = snapshot.threads[0];
  assert.equal(thread.totalTokens, 200);
  assert.equal(thread.usageCoverage, "partial");
  assert.equal(thread.turnDetails[0].usageCoverage, "partial");
  assert.equal(estimateTurnCost(thread.turnDetails[0], {}), null);
  assert.equal(estimateThreadCost(thread, {}), null);
  assert.ok(snapshot.warnings.some(warning => warning.includes("partial")));
});

test("merges separately recorded streaming counters into complete request usage", () => {
  write("projects/project/session-a.jsonl", [user(),
    assistant(1, "streaming", [], { usage: { input_tokens: 100 } }),
    assistant(2, "streaming", [], { usage: { output_tokens: 20 }, stop_reason: "end_turn" }),
  ]);
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  assert.equal(thread.totalTokens, 120);
  assert.equal(thread.usageCoverage, "complete");
  assert.equal(thread.turnDetails[0].requestUsage[0].hasCompleteUsage, true);
  assert.ok(estimateThreadCost(thread, {}));
});

test("keeps repeated post-only hook records at unknown duration", () => {
  process.env.CLAUDE_LOG_DIR = join(root, "logs");
  write("logs/tools.jsonl", [2, 3].map(second => ({ session_id: "post-only", timestamp: at(second),
    hook_event_name: "PostToolUse", tool_use_id: "tool", tool_name: "Read" })));
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  assert.equal(thread.toolCalls, 1);
  assert.equal(thread.turnDetails[0].toolCallDetails[0].durationMs, null);
  assert.equal(thread.activeDurationMs, 0);
});


test("isolates an invalid session instead of losing other available sessions", () => {
  write("projects/project/valid.jsonl", [user(), assistant(1, "valid", [], { stop_reason: "end_turn" })]);
  write("projects/project/invalid.jsonl", [user(0, "Invalid example", "invalid"),
    { ...assistant(1, "invalid", [], { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 100 } }), sessionId: "invalid" },
  ]);
  const snapshot = getClaudeAnalyticsSnapshot();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].id, "session-a");
  assert.ok(snapshot.warnings.some(warning => warning.includes("invalid.jsonl")));
});

test("ignores synthetic replies when assessing complete API usage", () => {
  write("projects/project/session-a.jsonl", [user(), assistant(1, "real", [], { stop_reason: "end_turn" }),
    assistant(2, "synthetic", [{ type: "text", text: "LOCAL_ERROR_SECRET" }], { model: "<synthetic>", usage: undefined }),
  ]);
  const snapshot = getClaudeAnalyticsSnapshot();
  assert.equal(snapshot.threads[0].usageCoverage, "complete");
  assert.equal(snapshot.threads[0].turnDetails[0].requestUsage.length, 1);
  assert.ok(estimateThreadCost(snapshot.threads[0], {}));
  assert.ok(!JSON.stringify(snapshot).includes("_SECRET"));
});


test("merges input and cache counters from separate updates without losing cache writes", () => {
  write("projects/project/session-a.jsonl", [user(),
    assistant(1, "split-cache", [], { usage: { input_tokens: 100, cache_read_input_tokens: 50 } }),
    assistant(2, "split-cache", [], { usage: { cache_creation_input_tokens: 30, output_tokens: 20 }, stop_reason: "end_turn" }),
  ]);
  const thread = getClaudeAnalyticsSnapshot().threads[0];
  assert.equal(thread.inputTokens, 180);
  assert.equal(thread.totalTokens, 200);
  assert.equal(thread.peakInputTokens, 180);
  assert.equal(thread.usageCoverage, "complete");
});
