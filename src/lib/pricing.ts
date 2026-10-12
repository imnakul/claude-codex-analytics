import type {
  ModelRate,
  ThreadAnalytics,
  ThreadTurnAnalytics,
} from "@/lib/analytics-types";

export const LONG_CONTEXT_THRESHOLD = 272_000;

export const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  "gpt-5.6-sol": {
    short: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
    long: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
  },
  "gpt-5.6-terra": {
    short: { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15 },
    long: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 },
  },
  "gpt-5.6-luna": {
    short: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 },
    long: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 },
  },
  "gpt-5.5": {
    short: { input: 5, cachedInput: 0.5, cacheWrite: null, output: 30 },
    long: { input: 10, cachedInput: 1, cacheWrite: null, output: 45 },
  },
  "gpt-5.5-pro": {
    short: { input: 30, cachedInput: null, cacheWrite: null, output: 180 },
    long: { input: 60, cachedInput: null, cacheWrite: null, output: 270 },
  },
  "gpt-5.4": {
    short: { input: 2.5, cachedInput: 0.25, cacheWrite: null, output: 15 },
    long: { input: 5, cachedInput: 0.5, cacheWrite: null, output: 22.5 },
  },
  "gpt-5.4-mini": {
    short: { input: 0.75, cachedInput: 0.075, cacheWrite: null, output: 4.5 },
    long: null,
  },
  "gpt-5.4-nano": {
    short: { input: 0.2, cachedInput: 0.02, cacheWrite: null, output: 1.25 },
    long: null,
  },
  "gpt-5.4-pro": {
    short: { input: 30, cachedInput: null, cacheWrite: null, output: 180 },
    long: { input: 60, cachedInput: null, cacheWrite: null, output: 270 },
  },
};

// Published first-party API list rates, checked 2026-10-12:
// https://platform.claude.com/docs/en/about-claude/pricing
function claudeRate(input: number, output: number, cachedInput: number): ModelRate {
  return { short: { input, output, cachedInput, cacheWrite: input * 1.25,
    cacheWriteLong: input * 2 }, long: null };
}
export const CLAUDE_MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  "claude-opus-5-5": claudeRate(4, 20, 0.2),
  "claude-sonnet-5-5": claudeRate(2, 10, 0.1),
  "claude-haiku-5-5": { ...claudeRate(0.1, 0.5, 0.01),
    long: claudeRate(0.5, 2.5, 0.05).short, longContextThreshold: 100_000 },
  "claude-fable-5-1": claudeRate(10, 50, 0.25),
  "claude-mythos-5-1": claudeRate(10, 50, 0.25),
  "claude-fable-5": claudeRate(10, 50, 1),
  "claude-mythos-5": claudeRate(10, 50, 1),
  "claude-opus-5": claudeRate(5, 25, 0.5),
  "claude-sonnet-5": claudeRate(2, 10, 0.2),
  "claude-opus-4-8": claudeRate(5, 25, 0.5),
  "claude-opus-4-7": claudeRate(5, 25, 0.5),
  "claude-opus-4-6": claudeRate(5, 25, 0.5),
  "claude-opus-4-5": claudeRate(5, 25, 0.5),
  "claude-opus-4-1": claudeRate(15, 75, 1.5),
  "claude-opus-4": claudeRate(15, 75, 1.5),
  "claude-sonnet-4-6": claudeRate(3, 15, 0.3),
  "claude-sonnet-4-5": claudeRate(3, 15, 0.3),
  "claude-sonnet-4": claudeRate(3, 15, 0.3),
  "claude-haiku-4-5": claudeRate(1, 5, 0.1),
  "claude-3-5-haiku": claudeRate(0.8, 4, 0.08),
};

export function defaultRateForModel(model: string): ModelRate | undefined {
  const canonical = model.replace(/-\d{8}$/, "");
  return DEFAULT_MODEL_RATES[model] ?? CLAUDE_MODEL_RATES[canonical];
}

export function resolveModelRate(model: string, rates: Readonly<Record<string, ModelRate>>): ModelRate | undefined {
  return rates[model] ?? rates[model.replace(/-\d{8}$/, "")] ?? defaultRateForModel(model);
}

export interface CostEstimate {
  cacheWriteCost: number;
  cacheReadCost: number;
  inputCost: number;
  outputCost: number;
  total: number;
  usesLongContextRate: boolean;
}

interface UsageForCost {
  hasCompleteUsage?: boolean;
  cacheWriteTokens?: number;
  cacheWriteLongTokens?: number;
  cachedInputTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  peakInputTokens: number;
}

export function estimateUsageCost(
  usage: UsageForCost,
  rates: Readonly<Record<string, ModelRate>>,
): CostEstimate | null {
  if (usage.hasCompleteUsage === false) return null;
  const rate = resolveModelRate(usage.model, rates);
  if (!rate) {
    return null;
  }

  const usesLongContextRate =
    usage.peakInputTokens > (rate.longContextThreshold ?? LONG_CONTEXT_THRESHOLD) && rate.long !== null;
  const activeRate = usesLongContextRate ? rate.long : rate.short;
  if (!activeRate) {
    return null;
  }

  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - (usage.cacheWriteTokens ?? 0),
  );
  const inputCost = (uncachedInput / 1_000_000) * activeRate.input;
  const cacheReadCost =
    (usage.cachedInputTokens / 1_000_000) *
    (activeRate.cachedInput ?? activeRate.input);
  const longWrites = usage.cacheWriteLongTokens ?? 0;
  const shortWrites = Math.max(0, (usage.cacheWriteTokens ?? 0) - longWrites);
  const cacheWriteCost = (shortWrites * (activeRate.cacheWrite ?? activeRate.input)
    + longWrites * (activeRate.cacheWriteLong ?? activeRate.cacheWrite ?? activeRate.input)) / 1_000_000;
  const outputCost = (usage.outputTokens / 1_000_000) * activeRate.output;

  return {
    cacheReadCost,
    cacheWriteCost,
    inputCost,
    outputCost,
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
    usesLongContextRate,
  };
}

export function estimateTurnCost(
  turn: ThreadTurnAnalytics,
  rates: Readonly<Record<string, ModelRate>>,
): CostEstimate | null {
  if (turn.usageCoverage === "partial" || turn.usageCoverage === "unknown") return null;
  if (turn.requestUsage.length) {
    const costs = turn.requestUsage.map(usage => estimateUsageCost(usage, rates));
    return sumCosts(costs);
  }
  if (!turn.totalTokens) return null;
  return estimateUsageCost(turn, rates);
}

function sumCosts(costs: Array<CostEstimate | null>): CostEstimate | null {
  if (costs.some(cost => cost === null)) return null;
  return costs.reduce<CostEstimate>((total, cost) => ({
    cacheReadCost: total.cacheReadCost + cost!.cacheReadCost,
    cacheWriteCost: total.cacheWriteCost + cost!.cacheWriteCost,
    inputCost: total.inputCost + cost!.inputCost,
    outputCost: total.outputCost + cost!.outputCost,
    total: total.total + cost!.total,
    usesLongContextRate: total.usesLongContextRate || cost!.usesLongContextRate,
  }), { cacheReadCost: 0, cacheWriteCost: 0, inputCost: 0, outputCost: 0,
    total: 0, usesLongContextRate: false });
}

/** API-equivalent estimate from recorded requests; missing rates remain unknown. */
export function estimateThreadCost(
  thread: ThreadAnalytics,
  rates: Readonly<Record<string, ModelRate>>,
): CostEstimate | null {
  if (!thread.hasDetailedUsage || thread.usageCoverage === "partial") return null;
  const turns = thread.turnDetails.filter(turn => turn.totalTokens > 0);
  return turns.length ? sumCosts(turns.map(turn => estimateTurnCost(turn, rates)))
    : estimateUsageCost(thread, rates);
}
