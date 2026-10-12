import "server-only";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  analyticsSnapshotSchema,
  threadAnalyticsSchema,
  threadTurnAnalyticsSchema,
  type AnalyticsSnapshot,
  type ThreadAnalytics,
  type ThreadTurnAnalytics,
  type requestUsageSchema,
  type toolCallSchema,
} from "@/lib/analytics-types";
import type { z } from "zod";

type RecordValue = Record<string, unknown>;
type ToolCall = z.infer<typeof toolCallSchema>;
type RequestUsage = z.infer<typeof requestUsageSchema>;
interface SavedSession {
  id: string;
  project: string;
  title: string;
  startedAt: string;
  updatedAt: string;
}
interface TurnState {
  turn: ThreadTurnAnalytics;
  lastAt: string;
  reportedDuration: boolean;
  requests: Map<string, RequestUsage>;
}

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : 0;
}
function timestamp(value: unknown): string | null {
  const parsed = typeof value === "number" ? value : Date.parse(string(value));
  const date = new Date(parsed);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
function blocks(content: unknown): RecordValue[] {
  return Array.isArray(content) ? content.map(object) : [];
}
function prompt(content: unknown): string {
  return typeof content === "string" ? content : blocks(content)
    .filter(block => block.type === "text").map(block => string(block.text)).join(/* turbopackIgnore: true */ "\n");
}

// Deliberately do not follow directory symlinks or inspect settings/credentials.
function filesUnder(root: string, warnings: string[], suffix = ".jsonl"): string[] {
  if (!existsSync(/* turbopackIgnore: true */ root)) return [];
  try {
    return readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true })
      .flatMap(entry => {
        const path = join(/* turbopackIgnore: true */ root, entry.name);
        return entry.isDirectory() ? filesUnder(path, warnings, suffix)
          : entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
      });
  } catch {
    warnings.push(`Could not read Claude directory ${basename(root)}.`);
    return [];
  }
}
function readLines(path: string, warnings: string[]): RecordValue[] {
  try {
    const lines = readFileSync(/* turbopackIgnore: true */ path, "utf8").split(/\r?\n/);
    const records: RecordValue[] = [];
    let invalid = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const raw: unknown = JSON.parse(line);
        if (Object.keys(object(raw)).length) records.push(object(raw));
        else invalid += 1;
      } catch { invalid += 1; }
    }
    if (invalid) warnings.push(`${basename(path)}: skipped ${invalid} malformed records (possibly an incomplete write).`);
    return records;
  } catch {
    warnings.push(`Could not read Claude file ${basename(path)}.`);
    return [];
  }
}
function newTurn(id: string, message: string, at: string): TurnState {
  return {
    turn: threadTurnAnalyticsSchema.parse({
      id, message: message.slice(0, 12_000) || "User message unavailable",
      startedAt: at, model: "Unknown model", reasoningEffort: "unspecified",
      durationMs: 0, timeToFirstTokenMs: null, totalTokens: 0,
      inputTokens: 0, peakInputTokens: 0, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, toolCalls: 0,
      shellCommands: 0, webCalls: 0, completed: false,
    }),
    lastAt: at, reportedDuration: false, requests: new Map(),
  };
}
function requestUsage(message: RecordValue): RequestUsage | null {
  const usage = object(message.usage);
  if (!["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .some(key => typeof usage[key] === "number")) return null;
  const creation = object(usage.cache_creation);
  const longWrites = count(creation.ephemeral_1h_input_tokens);
  const writes = Math.max(count(usage.cache_creation_input_tokens),
    count(creation.ephemeral_5m_input_tokens) + longWrites);
  const cached = count(usage.cache_read_input_tokens);
  const input = count(usage.input_tokens) + cached + writes;
  return {
    model: string(message.model) || "Unknown model",
    inputTokens: input, peakInputTokens: input, cachedInputTokens: cached,
    cacheWriteTokens: writes, cacheWriteLongTokens: longWrites,
    outputTokens: count(usage.output_tokens),
  };
}
function mergeUsage(previous: RequestUsage | undefined, next: RequestUsage): RequestUsage {
  if (!previous) return next;
  return {
    model: next.model === "Unknown model" ? previous.model : next.model,
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    peakInputTokens: Math.max(previous.peakInputTokens, next.peakInputTokens),
    cachedInputTokens: Math.max(previous.cachedInputTokens, next.cachedInputTokens),
    cacheWriteTokens: Math.max(previous.cacheWriteTokens, next.cacheWriteTokens),
    cacheWriteLongTokens: Math.max(previous.cacheWriteLongTokens, next.cacheWriteLongTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
  };
}
function toolKind(name: string): "shell" | "web" | "other" {
  if (/^(Bash|BashOutput|Terminal|shell)$/i.test(name)) return "shell";
  if (/^(WebFetch|WebSearch)$/i.test(name)) return "web";
  return "other";
}

function parseTranscript(
  path: string, records: RecordValue[], hooks: RecordValue[], saved: SavedSession | undefined,
  warnings: string[],
): ThreadAnalytics | null {
  const validRecords = records.filter(record => timestamp(record.timestamp));
  if (!validRecords.length) return null;
  validRecords.sort((a, b) => Date.parse(timestamp(a.timestamp)!) - Date.parse(timestamp(b.timestamp)!));
  const firstAt = timestamp(validRecords[0].timestamp)!;
  const lastAt = timestamp(validRecords.at(-1)!.timestamp)!;
  const parentId = validRecords.map(record => string(record.sessionId)).find(Boolean)
    || basename(path, ".jsonl");
  const isWorker = basename(dirname(path)) === "subagents"
    || validRecords.some(record => record.isSidechain === true);
  const id = isWorker ? `${parentId}:${basename(path, ".jsonl")}` : parentId;
  const project = validRecords.map(record => string(record.cwd)).find(Boolean) || saved?.project || "Unknown project";
  const turns: TurnState[] = [];
  let active: TurnState | undefined;
  const tools = new Map<string, { call: ToolCall; turn: TurnState }>();
  const requestOwners = new Map<string, TurnState>();
  const userIds = new Set<string>();
  let title = saved?.title || "";

  const ensureTurn = (at: string): TurnState => {
    if (!active) { active = newTurn(`${id}:unassigned`, "User message unavailable", at); turns.push(active); }
    return active;
  };
  for (const record of validRecords) {
    const at = timestamp(record.timestamp)!;
    const message = object(record.message);
    const content = blocks(message.content);
    if (record.type === "user") {
      // Tool results arrive as user messages but are not user prompts.
      for (const block of content.filter(block => block.type === "tool_result")) {
        const tool = tools.get(string(block.tool_use_id));
        if (!tool) continue;
        tool.call.status = block.is_error === true ? "failed" : "completed";
        tool.call.durationMs = elapsed(tool.call.startedAt, at);
        tool.turn.lastAt = at;
      }
      const text = prompt(message.content).trim();
      const userId = string(record.uuid) || `${at}:${text}`;
      if (text && record.isMeta !== true && !userIds.has(userId)) {
        userIds.add(userId);
        active = newTurn(userId, text, at);
        turns.push(active);
        if (!title) title = text;
      }
    } else if (record.type === "assistant") {
      // Claude can persist several content blocks for one API message. Count its
      // usage once, retaining the final/largest counters from streaming updates.
      const requestId = string(message.id) || string(record.requestId) || string(record.uuid) || at;
      const turn = requestOwners.get(requestId) || ensureTurn(at);
      requestOwners.set(requestId, turn);
      turn.lastAt = at;
      const model = string(message.model);
      if (model && model !== "<synthetic>") turn.turn.model = model;
      const usage = requestUsage(message);
      if (usage) turn.requests.set(requestId, mergeUsage(turn.requests.get(requestId), usage));
      const effort = string(object(message.thinking).type) || string(record.reasoningEffort);
      if (effort) turn.turn.reasoningEffort = effort;
      for (const block of content.filter(block => block.type === "tool_use")) {
        const toolId = string(block.id);
        if (!toolId || tools.has(toolId)) continue;
        const call: ToolCall = { id: toolId, name: string(block.name) || "Unknown tool",
          startedAt: at, durationMs: null, status: "recorded", source: "transcript" };
        tools.set(toolId, { call, turn });
        turn.turn.toolCallDetails.push(call);
      }
      if (["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(string(message.stop_reason))) {
        turn.turn.completed = true;
      }
    } else if (record.type === "system" && record.subtype === "turn_duration" && active) {
      if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
        active.turn.durationMs = count(record.durationMs);
        active.reportedDuration = true;
        active.turn.completed = true;
      }
    } else if (record.type === "summary" && !title) {
      title = string(record.summary);
    }
  }

  // Structured hook logs add failed calls and timings and are reconciled by ID.
  // Tool arguments/results remain on disk and are never included in the API.
  for (const hook of hooks) {
    const at = timestamp(hook.timestamp);
    const toolId = string(hook.tool_use_id);
    const name = string(hook.tool_name);
    const event = string(hook.hook_event_name);
    if (!at || !toolId || !["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) continue;
    let tool = tools.get(toolId);
    if (!tool) {
      const turn = turns.findLast(turn => Date.parse(turn.turn.startedAt) <= Date.parse(at)) || turns[0] || ensureTurn(at);
      const call: ToolCall = { id: toolId, name: name || "Unknown tool", startedAt: at,
        durationMs: null, status: "recorded", source: "hook" };
      tool = { call, turn }; tools.set(toolId, tool); turn.turn.toolCallDetails.push(call);
    }
    if (event === "PreToolUse") {
      const finishedAt = tool.call.durationMs === null ? null : Date.parse(tool.call.startedAt) + tool.call.durationMs;
      tool.call.startedAt = at;
      if (finishedAt !== null) tool.call.durationMs = Math.max(0, finishedAt - Date.parse(at));
    } else {
      tool.call.status = event === "PostToolUseFailure" || tool.call.status === "failed" ? "failed" : "completed";
      // A post-only hook cannot establish a start time for a hook-only call.
      if (tool.call.startedAt !== at || tool.call.source === "transcript") {
        tool.call.durationMs = elapsed(tool.call.startedAt, at);
      }
    }
    tool.turn.lastAt = new Date(Math.max(Date.parse(tool.turn.lastAt), Date.parse(at))).toISOString();
  }

  for (const state of turns) {
    const turn = state.turn;
    turn.requestUsage = [...state.requests.values()];
    for (const usage of turn.requestUsage) {
      turn.inputTokens += usage.inputTokens;
      turn.cachedInputTokens += usage.cachedInputTokens;
      turn.cacheWriteTokens += usage.cacheWriteTokens;
      turn.cacheWriteLongTokens += usage.cacheWriteLongTokens;
      turn.outputTokens += usage.outputTokens;
      turn.peakInputTokens = Math.max(turn.peakInputTokens, usage.peakInputTokens);
    }
    turn.totalTokens = turn.inputTokens + turn.outputTokens;
    turn.toolCalls = turn.toolCallDetails.length;
    turn.shellCommands = turn.toolCallDetails.filter(call => toolKind(call.name) === "shell").length;
    turn.webCalls = turn.toolCallDetails.filter(call => toolKind(call.name) === "web").length;
    if (!state.reportedDuration) turn.durationMs = elapsed(turn.startedAt, state.lastAt);
  }
  const details = turns.map(state => state.turn);
  const sum = (field: "durationMs" | "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "cacheWriteLongTokens" | "outputTokens" | "totalTokens" | "toolCalls" | "shellCommands" | "webCalls"): number =>
    details.reduce((total, turn) => total + turn[field], 0);
  const reported = turns.filter(state => state.reportedDuration).length;
  const missingUsage = turns.filter(state => state.turn.model !== "Unknown model" && !state.requests.size).length;
  if (missingUsage) warnings.push(`${id}: ${missingUsage} turns have no saved token usage; totals are partial.`);
  const updatedAt = new Date(Math.max(Date.parse(lastAt), ...turns.map(turn => Date.parse(turn.lastAt)))).toISOString();
  return threadAnalyticsSchema.parse({
    id, title: title.replace(/\s+/g, " ").slice(0, 180) || "Untitled Claude session",
    projectName: project.split(/[\\/]/).filter(Boolean).at(-1) || "Unknown project", projectPath: project,
    model: details.findLast(turn => turn.model !== "Unknown model")?.model || "Unknown model",
    reasoningEffort: details.at(-1)?.reasoningEffort || "unspecified", source: "Claude Code",
    startedAt: firstAt, updatedAt, activeDurationMs: sum("durationMs"), wallDurationMs: elapsed(firstAt, updatedAt),
    timeToFirstTokenMs: null, turns: details.length, prompts: userIds.size, turnDetails: details,
    toolCalls: sum("toolCalls"), shellCommands: sum("shellCommands"), webCalls: sum("webCalls"),
    totalTokens: sum("totalTokens"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
    peakInputTokens: Math.max(0, ...details.map(turn => turn.peakInputTokens)),
    cachedInputTokens: sum("cachedInputTokens"), cacheWriteTokens: sum("cacheWriteTokens"),
    cacheWriteLongTokens: sum("cacheWriteLongTokens"), reasoningOutputTokens: 0, contextWindow: null,
    archived: false, internal: isWorker, parentSessionId: isWorker ? parentId : null,
    hasDetailedUsage: turns.some(turn => turn.requests.size > 0),
    isPossiblyActive: details.at(-1)?.completed === false && Date.now() - Date.parse(updatedAt) < 120_000,
    durationSource: reported === turns.length && turns.length ? "reported" : reported ? "mixed" : "estimated",
  });
}

/** Read-only Claude Code ingestion. No Claude executable or network is used. */
export function getClaudeAnalyticsSnapshot(): AnalyticsSnapshot {
  const claudeHome = resolve(/* turbopackIgnore: true */ process.env.CLAUDE_CONFIG_DIR || join(/* turbopackIgnore: true */ homedir(), ".claude"));
  const projectsPath = join(/* turbopackIgnore: true */ claudeHome, "projects");
  const warnings: string[] = [
    "Claude totals cover saved local records only. Deleted sessions and unsaved tool calls cannot be recovered. TTFT, context limits, and separate reasoning tokens are unavailable.",
    "Claude runtime uses reported turn durations when present; otherwise it estimates prompt-to-last-response time, which may include waits. Tool arguments and outputs are kept off the analytics API.",
  ];
  const saved = new Map<string, SavedSession>();
  const historyPath = join(/* turbopackIgnore: true */ claudeHome, "history.jsonl");
  if (existsSync(/* turbopackIgnore: true */ historyPath)) {
    for (const entry of readLines(historyPath, warnings)) {
      const id = string(entry.sessionId);
      const at = timestamp(entry.timestamp);
      if (!id || !at) continue;
      const previous = saved.get(id);
      saved.set(id, {
        id, project: string(entry.project) || previous?.project || "Unknown project",
        title: previous?.title || string(entry.display),
        startedAt: previous && previous.startedAt < at ? previous.startedAt : at,
        updatedAt: previous && previous.updatedAt > at ? previous.updatedAt : at,
      });
    }
  }
  for (const indexPath of filesUnder(projectsPath, warnings, "sessions-index.json")) {
    try {
      const index = object(JSON.parse(readFileSync(/* turbopackIgnore: true */ indexPath, "utf8")));
      for (const entry of Array.isArray(index.entries) ? index.entries.map(object) : []) {
        const id = string(entry.sessionId);
        const startedAt = timestamp(entry.created);
        const updatedAt = timestamp(entry.modified) || startedAt;
        if (id && startedAt && updatedAt && !saved.has(id)) saved.set(id, {
          id, startedAt, updatedAt, project: string(entry.projectPath) || string(index.originalPath) || "Unknown project",
          title: string(entry.firstPrompt) || string(entry.summary),
        });
      }
    } catch { warnings.push("Could not read a Claude sessions index; continuing with transcripts and history."); }
  }
  const hooks = new Map<string, RecordValue[]>();
  const defaultLogDir = join(/* turbopackIgnore: true */ claudeHome, "analytics-tools");
  const logDir = process.env.CLAUDE_LOG_DIR || (existsSync(/* turbopackIgnore: true */ defaultLogDir) ? defaultLogDir : undefined);
  if (logDir) {
    if (!existsSync(/* turbopackIgnore: true */ logDir)) warnings.push("CLAUDE_LOG_DIR does not exist; no optional hook logs were read.");
    let unsupported = 0;
    for (const path of filesUnder(resolve(/* turbopackIgnore: true */ logDir), warnings)) {
      for (const entry of readLines(path, warnings)) {
        const id = string(entry.session_id);
        if (!id || !string(entry.tool_use_id) || !timestamp(entry.timestamp) ||
          !["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(string(entry.hook_event_name))) {
          unsupported += 1; continue;
        }
        const entries = hooks.get(id) || []; entries.push(entry); hooks.set(id, entries);
      }
    }
    if (unsupported) warnings.push(`Skipped ${unsupported} optional log records without the supported timestamped tool-hook format. Plain-text debug logs are not parsed.`);
  }
  const threads: ThreadAnalytics[] = [];
  const transcriptGroups = new Map<string, { path: string; records: RecordValue[] }>();
  for (const path of filesUnder(projectsPath, warnings)) {
    const records = readLines(path, warnings);
    const parentId = records.map(record => string(record.sessionId)).find(Boolean) || basename(path, ".jsonl");
    const worker = basename(dirname(path)) === "subagents" || records.some(record => record.isSidechain === true);
    const key = worker ? `${parentId}:${basename(path, ".jsonl")}` : parentId;
    const group = transcriptGroups.get(key) || { path, records: [] };
    group.records.push(...records); transcriptGroups.set(key, group);
  }
  const toolOwners = new Map<string, string>();
  for (const [key, group] of transcriptGroups) {
    for (const record of group.records) {
      const sessionId = string(record.sessionId);
      for (const block of blocks(object(record.message).content)) {
        if (block.type === "tool_use" && string(block.id)) toolOwners.set(`${sessionId}:${string(block.id)}`, key);
      }
    }
  }
  const routedHooks = new Map<string, RecordValue[]>();
  for (const [id, entries] of hooks) {
    for (const entry of entries) {
      const agentId = string(entry.agent_id);
      const key = toolOwners.get(`${id}:${string(entry.tool_use_id)}`)
        || (agentId ? `${id}:agent-${agentId.replace(/^agent-/, "")}` : id);
      const routed = routedHooks.get(key) || []; routed.push(entry); routedHooks.set(key, routed);
    }
  }
  hooks.clear();
  for (const [key, entries] of routedHooks) {
    entries.sort((a, b) => Date.parse(timestamp(a.timestamp)!) - Date.parse(timestamp(b.timestamp)!));
    hooks.set(key, entries);
  }
  for (const [key, group] of transcriptGroups) {
    const sessionHooks = (hooks.get(key) || []).sort((a, b) => Date.parse(timestamp(a.timestamp)!) - Date.parse(timestamp(b.timestamp)!));
    const thread = parseTranscript(group.path, group.records, sessionHooks, saved.get(key), warnings);
    if (thread) threads.push(thread);
  }
  // History-only sessions are visible but never assigned invented usage.
  for (const session of saved.values()) {
    if (threads.some(thread => thread.id === session.id)) continue;
    const hookRecords = hooks.get(session.id) || [];
    const records: RecordValue[] = [{ type: "user", sessionId: session.id, cwd: session.project,
      timestamp: session.startedAt, message: { content: session.title } },
      { type: "metadata", timestamp: session.updatedAt }];
    const thread = parseTranscript("history.jsonl", records, hookRecords, session, warnings);
    if (thread) { thread.source = "Claude history (transcript unavailable)"; threads.push(thread); }
  }
  // Logs can be the only retained record of a session.
  for (const [id, entries] of hooks) {
    if (threads.some(thread => thread.id === id)) continue;
    entries.sort((a, b) => Date.parse(timestamp(a.timestamp)!) - Date.parse(timestamp(b.timestamp)!));
    const thread = parseTranscript("hooks.jsonl", [{ type: "metadata", sessionId: id,
      cwd: string(entries[0].cwd), timestamp: entries[0].timestamp }], entries, undefined, warnings);
    if (thread) {
      thread.id = id;
      const workerMarker = id.indexOf(":agent-");
      if (workerMarker !== -1) { thread.internal = true; thread.parentSessionId = id.slice(0, workerMarker); }
      thread.source = "Claude hooks (transcript unavailable)"; threads.push(thread);
    }
  }
  if (!threads.length) warnings.push(`No saved Claude sessions found. Run Claude Code locally or set CLAUDE_CONFIG_DIR to your Claude data directory.`);
  if (threads.some(thread => !thread.hasDetailedUsage)) warnings.push("Some sessions have history or tool logs without token usage. Their tokens and cost are unknown.");
  return analyticsSnapshotSchema.parse({
    provider: "claude", dataHome: claudeHome, codexHome: "", databasePath: projectsPath,
    generatedAt: new Date().toISOString(), threads: threads.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), warnings,
  });
}
