import "server-only";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  analyticsSnapshotSchema,
  type AnalyticsSnapshot,
  type ThreadAnalytics,
  type ThreadTurnAnalytics,
} from "@/lib/analytics-types";

const sqliteThreadRowSchema = z.object({
  id: z.string(),
  rollout_path: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  source: z.string(),
  cwd: z.string(),
  title: z.string(),
  tokens_used: z.number(),
  archived: z.number(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  created_at_ms: z.number().nullable(),
  updated_at_ms: z.number().nullable(),
  thread_source: z.string().nullable(),
});

const sessionLineSchema = z
  .object({
    timestamp: z.string().optional(),
    type: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const tokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
});

const tokenInfoSchema = z.object({
  model_context_window: z.number().int().positive().optional(),
  last_token_usage: tokenUsageSchema.optional(),
  total_token_usage: tokenUsageSchema.optional(),
});

const taskCompleteSchema = z.object({
  turn_id: z.string().optional(),
  duration_ms: z.number().nonnegative(),
  time_to_first_token_ms: z.number().nonnegative().optional(),
});

const taskStartedSchema = z.object({
  turn_id: z.string(),
  started_at: z.union([z.number(), z.string()]).optional(),
});

const turnContextSchema = z.object({
  turn_id: z.string(),
  model: z.string(),
  effort: z.string().optional(),
});

const userMessageSchema = z.object({
  message: z.string(),
});

const projectAssignmentSchema = z
  .object({
    projectId: z.string().optional(),
    path: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

const globalStateSchema = z
  .object({
    "thread-project-assignments": z
      .record(z.string(), projectAssignmentSchema)
      .optional(),
    "projectless-thread-ids": z.array(z.string()).optional(),
  })
  .passthrough();

interface SessionMetrics {
  activeDurationMs: number;
  cachedInputTokens: number;
  contextWindow: number | null;
  firstTimestamp: string | null;
  hasDetailedUsage: boolean;
  inputTokens: number;
  isPossiblyActive: boolean;
  lastTimestamp: string | null;
  outputTokens: number;
  peakInputTokens: number;
  prompts: number;
  reasoningOutputTokens: number;
  shellCommands: number;
  timeToFirstTokenMs: number | null;
  toolCalls: number;
  totalTokens: number;
  turnDetails: ThreadTurnAnalytics[];
  turns: number;
  webCalls: number;
}

interface ActiveTurn {
  accumulatedUsage: z.infer<typeof tokenUsageSchema>;
  id: string;
  lastUsage: z.infer<typeof tokenUsageSchema> | null;
  message: string;
  model: string;
  peakInputTokens: number;
  reasoningEffort: string;
  shellCommands: number;
  startedAt: string;
  toolCalls: number;
  webCalls: number;
}

interface CachedSessionMetrics {
  metrics: SessionMetrics;
  modifiedAtMs: number;
  size: number;
}

interface ProjectMetadata {
  projectlessIds: ReadonlySet<string>;
  threadPaths: ReadonlyMap<string, string>;
}

const sessionMetricsCache = new Map<string, CachedSessionMetrics>();

function normalizeWindowsPath(path: string): string {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function parseConfiguredSqliteHome(codexHome: string): string | null {
  const configPath = join(/* turbopackIgnore: true */ codexHome, "config.toml");
  if (!existsSync(/* turbopackIgnore: true */ configPath)) {
    return null;
  }

  const match = readFileSync(
    /* turbopackIgnore: true */ configPath,
    "utf8",
  ).match(
    /^\s*sqlite_home\s*=\s*["']([^"']+)["']/m,
  );
  if (!match?.[1]) {
    return null;
  }

  return isAbsolute(match[1])
    ? match[1]
    : resolve(/* turbopackIgnore: true */ match[1]);
}

function locateCodexState(): { codexHome: string; databasePath: string } {
  const codexHome = resolve(/* turbopackIgnore: true */ process.env.CODEX_HOME ?? join(/* turbopackIgnore: true */ homedir(), ".codex"));
  const configuredSqliteHome =
    parseConfiguredSqliteHome(codexHome) ?? process.env.CODEX_SQLITE_HOME;
  const roots = [configuredSqliteHome, codexHome, join(/* turbopackIgnore: true */ codexHome, "sqlite")]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(/* turbopackIgnore: true */ value));

  const databaseCandidates = Array.from(new Set(roots)).flatMap((root) => {
    if (!existsSync(/* turbopackIgnore: true */ root)) {
      return [];
    }

    return readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name),
      )
      .map((entry) =>
        join(/* turbopackIgnore: true */ root, entry.name),
      );
  });

  const databasePath = databaseCandidates
    .map((path) => ({
      path,
      modifiedAtMs: statSync(/* turbopackIgnore: true */ path).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]?.path;

  if (!databasePath) {
    throw new Error(`No Codex state database was found under ${codexHome}.`);
  }

  return { codexHome, databasePath };
}

function readProjectMetadata(codexHome: string): ProjectMetadata {
  const globalStatePath = join(/* turbopackIgnore: true */ codexHome, ".codex-global-state.json");
  if (!existsSync(/* turbopackIgnore: true */ globalStatePath)) {
    return { projectlessIds: new Set(), threadPaths: new Map() };
  }

  try {
    const raw: unknown = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ globalStatePath, "utf8"),
    );
    const state = globalStateSchema.parse(raw);
    const threadPaths = new Map<string, string>();
    for (const [threadId, assignment] of Object.entries(
      state["thread-project-assignments"] ?? {},
    )) {
      const path = assignment.projectId ?? assignment.path ?? assignment.cwd;
      if (path) {
        threadPaths.set(threadId, normalizeWindowsPath(path));
      }
    }

    return {
      projectlessIds: new Set(state["projectless-thread-ids"] ?? []),
      threadPaths,
    };
  } catch {
    return { projectlessIds: new Set(), threadPaths: new Map() };
  }
}

function emptyUsage(): z.infer<typeof tokenUsageSchema> {
  return {
    cached_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function accumulateUsageDelta(
  accumulated: z.infer<typeof tokenUsageSchema>,
  previous: z.infer<typeof tokenUsageSchema> | null,
  current: z.infer<typeof tokenUsageSchema>,
): z.infer<typeof tokenUsageSchema> {
  const delta = (currentValue: number, previousValue: number): number =>
    currentValue >= previousValue
      ? currentValue - previousValue
      : currentValue;
  const baseline = previous ?? emptyUsage();
  return {
    cached_input_tokens:
      accumulated.cached_input_tokens +
      delta(current.cached_input_tokens, baseline.cached_input_tokens),
    input_tokens:
      accumulated.input_tokens +
      delta(current.input_tokens, baseline.input_tokens),
    output_tokens:
      accumulated.output_tokens +
      delta(current.output_tokens, baseline.output_tokens),
    reasoning_output_tokens:
      accumulated.reasoning_output_tokens +
      delta(
        current.reasoning_output_tokens,
        baseline.reasoning_output_tokens,
      ),
    total_tokens:
      accumulated.total_tokens +
      delta(current.total_tokens, baseline.total_tokens),
  };
}

function completeTurn(
  turn: ActiveTurn,
  completed: boolean,
  durationMs: number,
  timeToFirstTokenMs: number | null,
): ThreadTurnAnalytics {
  return {
    cacheWriteTokens: 0,
    cacheWriteLongTokens: 0,
    requestUsage: [],
    toolCallDetails: [],
    cachedInputTokens: turn.accumulatedUsage.cached_input_tokens,
    completed,
    durationMs,
    id: turn.id,
    inputTokens: turn.accumulatedUsage.input_tokens,
    message:
      extractCodexRequest(turn.message).slice(0, 12_000) ||
      "User message unavailable",
    model: turn.model,
    outputTokens: turn.accumulatedUsage.output_tokens,
    peakInputTokens: turn.peakInputTokens,
    reasoningEffort: turn.reasoningEffort,
    reasoningOutputTokens: turn.accumulatedUsage.reasoning_output_tokens,
    shellCommands: turn.shellCommands,
    startedAt: turn.startedAt,
    timeToFirstTokenMs,
    toolCalls: turn.toolCalls,
    totalTokens: turn.accumulatedUsage.total_tokens,
    webCalls: turn.webCalls,
  };
}

function parseSessionMetrics(rolloutPath: string): SessionMetrics | null {
  const normalizedPath = normalizeWindowsPath(rolloutPath);
  if (!existsSync(/* turbopackIgnore: true */ normalizedPath)) {
    return null;
  }

  const fileState = statSync(/* turbopackIgnore: true */ normalizedPath);
  const cached = sessionMetricsCache.get(normalizedPath);
  if (
    cached &&
    cached.modifiedAtMs === fileState.mtimeMs &&
    cached.size === fileState.size
  ) {
    return cached.metrics;
  }

  let activeDurationMs = 0;
  let completedTurns = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let prompts = 0;
  let reasoningOutputTokens = 0;
  let shellCommands = 0;
  let startedTurns = 0;
  let timeToFirstTokenTotal = 0;
  let timeToFirstTokenSamples = 0;
  let toolCalls = 0;
  let webCalls = 0;
  let contextWindow: number | null = null;
  let peakInputTokens = 0;
  let latestUsage: z.infer<typeof tokenUsageSchema> | null = null;
  let activeTurn: ActiveTurn | null = null;
  const turnDetails: ThreadTurnAnalytics[] = [];

  for (const line of readFileSync(
    /* turbopackIgnore: true */ normalizedPath,
    "utf8",
  ).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const raw: unknown = JSON.parse(line);
      const event = sessionLineSchema.parse(raw);
      if (event.timestamp) {
        firstTimestamp ??= event.timestamp;
        lastTimestamp = event.timestamp;
      }

      const payload = event.payload;
      if (!payload) {
        continue;
      }
      const eventType =
        typeof payload.type === "string" ? payload.type : event.type;

      if (eventType === "task_started") {
        const started = taskStartedSchema.safeParse(payload);
        if (started.success) {
          if (activeTurn) {
            turnDetails.push(completeTurn(activeTurn, false, 0, null));
          }
          startedTurns += 1;
          activeTurn = {
            accumulatedUsage: emptyUsage(),
            id: started.data.turn_id,
            lastUsage: latestUsage,
            message: "",
            model: "Unknown model",
            peakInputTokens: 0,
            reasoningEffort: "unspecified",
            shellCommands: 0,
            startedAt:
              typeof started.data.started_at === "number"
                ? toIsoString(started.data.started_at * 1_000)
                : started.data.started_at ??
                  event.timestamp ??
                  new Date(0).toISOString(),
            toolCalls: 0,
            webCalls: 0,
          };
        }
      } else if (eventType === "turn_context") {
        const context = turnContextSchema.safeParse(payload);
        if (context.success && activeTurn?.id === context.data.turn_id) {
          activeTurn.model = context.data.model;
          activeTurn.reasoningEffort = context.data.effort ?? "unspecified";
        }
      } else if (eventType === "task_complete") {
        const complete = taskCompleteSchema.safeParse(payload);
        if (complete.success) {
          completedTurns += 1;
          activeDurationMs += complete.data.duration_ms;
          if (complete.data.time_to_first_token_ms !== undefined) {
            timeToFirstTokenTotal += complete.data.time_to_first_token_ms;
            timeToFirstTokenSamples += 1;
          }
          if (
            activeTurn &&
            (!complete.data.turn_id || complete.data.turn_id === activeTurn.id)
          ) {
            turnDetails.push(
              completeTurn(
                activeTurn,
                true,
                complete.data.duration_ms,
                complete.data.time_to_first_token_ms ?? null,
              ),
            );
            activeTurn = null;
          }
        }
      } else if (eventType === "user_message") {
        const message = userMessageSchema.safeParse(payload);
        if (message.success) {
          prompts += 1;
          if (activeTurn) {
            activeTurn.message = message.data.message;
          }
        }
      } else if (eventType === "token_count") {
        const info = tokenInfoSchema.safeParse(payload.info);
        if (info.success) {
          contextWindow = info.data.model_context_window ?? contextWindow;
          const totalUsage = info.data.total_token_usage;
          if (activeTurn && totalUsage) {
            activeTurn.accumulatedUsage = accumulateUsageDelta(
              activeTurn.accumulatedUsage,
              activeTurn.lastUsage,
              totalUsage,
            );
            activeTurn.lastUsage = totalUsage;
            activeTurn.peakInputTokens = Math.max(
              activeTurn.peakInputTokens,
              info.data.last_token_usage?.input_tokens ?? 0,
            );
          }
          latestUsage = totalUsage ?? latestUsage;
          peakInputTokens = Math.max(
            peakInputTokens,
            info.data.last_token_usage?.input_tokens ?? 0,
          );
        }
      } else if (
        eventType === "custom_tool_call" ||
        eventType === "function_call"
      ) {
        toolCalls += 1;
        const input = payload.input ?? payload.arguments;
        const serializedInput =
          typeof input === "string" ? input : JSON.stringify(input ?? "");
        const turnShellCommands = (
          serializedInput.match(/tools\.shell_command\s*\(/g) ?? []
        ).length;
        const turnWebCalls = (
          serializedInput.match(/tools\.web__run\s*\(/g) ?? []
        ).length;
        shellCommands += turnShellCommands;
        webCalls += turnWebCalls;
        if (activeTurn) {
          activeTurn.toolCalls += 1;
          activeTurn.shellCommands += turnShellCommands;
          activeTurn.webCalls += turnWebCalls;
        }
      }
    } catch {
      // A malformed or future event should not make the complete dashboard fail.
    }
  }

  if (activeTurn) {
    turnDetails.push(completeTurn(activeTurn, false, 0, null));
  }

  if (latestUsage) {
    reasoningOutputTokens = latestUsage.reasoning_output_tokens;
  }

  const metrics: SessionMetrics = {
    activeDurationMs,
    cachedInputTokens: latestUsage?.cached_input_tokens ?? 0,
    contextWindow,
    firstTimestamp,
    hasDetailedUsage: latestUsage !== null,
    inputTokens: latestUsage?.input_tokens ?? 0,
    isPossiblyActive: startedTurns > completedTurns,
    lastTimestamp,
    outputTokens: latestUsage?.output_tokens ?? 0,
    peakInputTokens,
    prompts,
    reasoningOutputTokens,
    shellCommands,
    timeToFirstTokenMs:
      timeToFirstTokenSamples > 0
        ? Math.round(timeToFirstTokenTotal / timeToFirstTokenSamples)
        : null,
    toolCalls,
    totalTokens: latestUsage?.total_tokens ?? 0,
    turnDetails,
    turns: completedTurns,
    webCalls,
  };

  sessionMetricsCache.set(normalizedPath, {
    metrics,
    modifiedAtMs: fileState.mtimeMs,
    size: fileState.size,
  });

  return metrics;
}

function toIsoString(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function safeDuration(startedAt: string, finishedAt: string): number {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

/**
 * Uses the actual request text when Codex prefixes a prompt with attachment
 * metadata. The sidebar's short label is not persisted in the local ledger,
 * so the request heading is the most reliable human-readable title.
 */
function extractCodexRequest(rawText: string): string {
  const normalized = rawText.replace(/\r\n?/g, "\n").trim();
  const requestMarker = /(?:^|\n)\s*#{0,6}\s*My request for Codex\s*:\s*/i;
  const markerMatch = requestMarker.exec(normalized);
  return markerMatch
    ? normalized.slice(markerMatch.index + markerMatch[0].length)
    : normalized;
}

function deriveThreadTitle(rawTitle: string): string {
  const requestText = extractCodexRequest(rawTitle);
  return requestText.replace(/\s+/g, " ").trim().slice(0, 180) || "Untitled thread";
}

function resolveProject(
  row: z.infer<typeof sqliteThreadRowSchema>,
  metadata: ProjectMetadata,
): { name: string; path: string } {
  if (metadata.projectlessIds.has(row.id)) {
    return { name: "Projectless", path: "Projectless tasks" };
  }

  const path =
    metadata.threadPaths.get(row.id) ?? normalizeWindowsPath(row.cwd) ?? "Unknown";
  return { name: basename(path) || "Unknown project", path };
}

function mapThread(
  row: z.infer<typeof sqliteThreadRowSchema>,
  metadata: ProjectMetadata,
): ThreadAnalytics {
  const session = parseSessionMetrics(row.rollout_path);
  const startedAt =
    session?.firstTimestamp ??
    toIsoString(row.created_at_ms ?? row.created_at * 1_000);
  const updatedAt =
    session?.lastTimestamp ??
    toIsoString(row.updated_at_ms ?? row.updated_at * 1_000);
  const project = resolveProject(row, metadata);
  const internal =
    row.model === "codex-auto-review" || row.thread_source === "subagent";
  const title = internal
    ? "Internal Codex worker"
    : deriveThreadTitle(row.title);
  const totalTokens = session?.totalTokens || Math.max(0, row.tokens_used);
  const fallbackModel = row.model ?? "Unknown model";

  return {
    activeDurationMs: session?.activeDurationMs ?? 0,
    cacheWriteTokens: 0,
    cacheWriteLongTokens: 0,
    durationSource: "reported",
    parentSessionId: null,
    archived: row.archived === 1,
    cachedInputTokens: session?.cachedInputTokens ?? 0,
    contextWindow: session?.contextWindow ?? null,
    hasDetailedUsage: session?.hasDetailedUsage ?? false,
    id: row.id,
    inputTokens: session?.inputTokens ?? 0,
    internal,
    isPossiblyActive: session?.isPossiblyActive ?? false,
    model: fallbackModel,
    outputTokens: session?.outputTokens ?? 0,
    peakInputTokens: session?.peakInputTokens ?? 0,
    projectName: project.name,
    projectPath: project.path,
    prompts: session?.prompts ?? 0,
    reasoningEffort: row.reasoning_effort ?? "unspecified",
    reasoningOutputTokens: session?.reasoningOutputTokens ?? 0,
    shellCommands: session?.shellCommands ?? 0,
    source: row.source,
    startedAt,
    timeToFirstTokenMs: session?.timeToFirstTokenMs ?? null,
    title,
    toolCalls: session?.toolCalls ?? 0,
    totalTokens,
    turnDetails: (session?.turnDetails ?? []).map((turn) => ({
      ...turn,
      model: turn.model === "Unknown model" ? fallbackModel : turn.model,
    })),
    turns: session?.turns ?? 0,
    updatedAt,
    wallDurationMs: safeDuration(startedAt, updatedAt),
    webCalls: session?.webCalls ?? 0,
  };
}

/** Reads Codex state without mutating the database or session transcripts. */
export function getAnalyticsSnapshot(): AnalyticsSnapshot {
  const { codexHome, databasePath } = locateCodexState();
  const metadata = readProjectMetadata(codexHome);
  const warnings: string[] = [];
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 2_000,
  });

  try {
    const rows = database
      .prepare(
        `SELECT id, rollout_path, created_at, updated_at, source, cwd, title,
          tokens_used, archived, model, reasoning_effort, created_at_ms,
          updated_at_ms, thread_source
        FROM threads
        ORDER BY recency_at_ms DESC, updated_at DESC`,
      )
      .all()
      .map((row) => sqliteThreadRowSchema.parse(row));

    const threads = rows.map((row) => {
      try {
        return mapThread(row, metadata);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        warnings.push(`Could not read session ${row.id}: ${message}`);
        return mapThread({ ...row, rollout_path: "" }, metadata);
      }
    });

    return analyticsSnapshotSchema.parse({
      provider: "codex",
      dataHome: codexHome,
      codexHome,
      databasePath,
      generatedAt: new Date().toISOString(),
      threads,
      warnings,
    });
  } finally {
    database.close();
  }
}
