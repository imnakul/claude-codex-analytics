"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  Filter,
  Layers3,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Moon,
  Sun,
  WifiOff,
} from "lucide-react";
import { z } from "zod";

import type {
  ModelAggregate,
  PricedThread,
} from "@/components/dashboard/dashboard-types";
import {
  formatCurrency,
  formatDuration,
  formatTokens,
  shortModelName,
} from "@/components/dashboard/formatting";
import { ModelPerformance } from "@/components/dashboard/model-performance";
import { PricingDialog } from "@/components/dashboard/pricing-dialog";
import { SummaryCard } from "@/components/dashboard/summary-card";
import { ThreadDetail } from "@/components/dashboard/thread-detail";
import { ThreadTable } from "@/components/dashboard/thread-table";
import {
  analyticsSnapshotSchema,
  modelRateSchema,
  type AnalyticsSnapshot,
  type AnalyticsProvider,
  type ModelRate,
  type TokenRate,
} from "@/lib/analytics-types";
import {
  DEFAULT_MODEL_RATES,
  CLAUDE_MODEL_RATES,
  resolveModelRate,
  estimateUsageCost,
  estimateThreadCost,
  estimateTurnCost,
} from "@/lib/pricing";

const pricingStorageSchema = z.record(z.string(), modelRateSchema);
const PRICING_STORAGE_KEY = "codex-analytics-ledger:model-rates:v2";
const VIEW_MODE_STORAGE_KEY = "codex-analytics-ledger:view-mode:v1";
const ANALYTICS_REFRESH_TIMEOUT_MS = 30_000;
const EMPTY_SNAPSHOT: AnalyticsSnapshot = {
  provider: "codex",
  dataHome: "",
  codexHome: "",
  databasePath: "",
  generatedAt: "",
  threads: [],
  warnings: [],
};

const sortOptionSchema = z.enum(["cost", "recent", "time", "tokens"]);
type SortOption = z.infer<typeof sortOptionSchema>;
type Theme = "dark" | "light";

function buildModelAggregates(
  items: PricedThread[],
  rates: Readonly<Record<string, ModelRate>>,
): ModelAggregate[] {
  const buckets = new Map<
    string,
    {
      cost: number;
      duration: number;
      timed: number;
      label: string;
      priced: number;
      samples: number;
      tokens: number;
    }
  >();

  for (const item of items) {
    const key = `${item.thread.model}:${item.thread.reasoningEffort}`;
    const existing = buckets.get(key) ?? {
      cost: 0,
      duration: 0,
      timed: 0,
      label: `${shortModelName(item.thread.model)} / ${item.thread.reasoningEffort}`,
      priced: 0,
      samples: 0,
      tokens: 0,
    };
    const turns = item.thread.turnDetails.filter((turn) => turn.totalTokens > 0);
    if (turns.length > 0) {
      for (const turn of turns) {
        const models = new Set(turn.requestUsage.map(usage => usage.model));
        const sampleModels = models.size ? [...models] : [turn.model];
        for (const model of sampleModels) {
          const turnKey = `${model}:${turn.reasoningEffort}`;
          const turnBucket = buckets.get(turnKey) ?? {
            cost: 0, duration: 0, timed: 0,
            label: `${shortModelName(model)} / ${turn.reasoningEffort}`,
            priced: 0, samples: 0, tokens: 0,
          };
          const requests = turn.requestUsage.filter(usage => usage.model === model);
          const requestCosts = requests.map(usage => estimateUsageCost(usage, rates));
          const cost = requests.length
            ? requestCosts.every(cost => cost !== null) ? requestCosts.reduce((sum, cost) => sum + cost!.total, 0) : null
            : estimateTurnCost(turn, rates)?.total ?? null;
          // A mixed-model turn cannot provide a runtime for each individual model.
          if (sampleModels.length === 1) { turnBucket.duration += turn.durationMs; turnBucket.timed += 1; }
          turnBucket.samples += 1;
          turnBucket.tokens += requests.length
            ? requests.reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0) : turn.totalTokens;
          if (cost !== null) { turnBucket.cost += cost; turnBucket.priced += 1; }
          buckets.set(turnKey, turnBucket);
        }
      }
      continue;
    }
    existing.duration += item.thread.activeDurationMs;
    existing.timed += 1;
    existing.samples += 1;
    existing.tokens += item.thread.totalTokens;
    if (item.cost) {
      existing.cost += item.cost.total;
      existing.priced += 1;
    }
    buckets.set(key, existing);
  }

  return Array.from(buckets.entries())
    .map(([key, value]) => ({
      averageCost: value.priced > 0 ? value.cost / value.priced : null,
      averageDurationMs: value.timed ? value.duration / value.timed : null,
      averageTokens: value.tokens / value.samples,
      key,
      label: value.label,
      pricedThreads: value.priced,
      sampleCount: value.samples,
      totalCost: value.cost,
    }))
    .sort((left, right) => right.sampleCount - left.sampleCount);
}

function getDefaultRates(): Record<string, ModelRate> {
  return { ...DEFAULT_MODEL_RATES, ...CLAUDE_MODEL_RATES };
}

function projectSortValue(items: PricedThread[], sort: SortOption): number {
  if (sort === "recent") {
    return Math.max(
      ...items.map((item) => {
        const timestamp = Date.parse(item.thread.updatedAt);
        return Number.isFinite(timestamp) ? timestamp : 0;
      }),
    );
  }
  if (sort === "cost") {
    return items.reduce((total, item) => total + (item.cost?.total ?? 0), 0);
  }
  if (sort === "tokens") {
    return items.reduce((total, item) => total + item.thread.totalTokens, 0);
  }
  return items.reduce(
    (total, item) => total + item.thread.activeDurationMs,
    0,
  );
}

export function CodexDashboard({
  initialProvider = "codex",
}: { initialProvider?: AnalyticsProvider }): React.ReactNode {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot>(() => ({
    ...EMPTY_SNAPSHOT,
    provider: initialProvider,
  }));
  const provider = snapshot.provider;
  const providerLabel = provider === "claude" ? "Claude" : "Codex";
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [effortFilter, setEffortFilter] = useState("all");
  const [sort, setSort] = useState<SortOption>("recent");
  const [showInternal, setShowInternal] = useState(false);
  const [groupByProject, setGroupByProject] = useState(false);
  const [viewModeHydrated, setViewModeHydrated] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const refreshInFlight = useRef(false);
  const hasSnapshot = useRef(false);

  const observedModels = useMemo(
    () =>
      Array.from(
        new Set(
          snapshot.threads.flatMap((thread) => [
            thread.model,
            ...thread.turnDetails.flatMap((turn) => [turn.model, ...turn.requestUsage.map(usage => usage.model)]),
          ]),
        ),
      ).sort(),
    [snapshot.threads],
  );
  const [rates, setRates] = useState<Record<string, ModelRate>>(getDefaultRates);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(PRICING_STORAGE_KEY);
        if (!saved) {
          return;
        }
        const raw: unknown = JSON.parse(saved);
        const parsed = pricingStorageSchema.safeParse(raw);
        if (parsed.success) {
          setRates({ ...getDefaultRates(), ...parsed.data });
        }
      } catch (error) {
        console.warn("[codex-analytics-ledger] Could not restore local pricing", error);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("codex-analytics-ledger:theme");
    const nextTheme: Theme = storedTheme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.setTimeout(() => setTheme(nextTheme), 0);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGroupByProject(
        window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "grouped",
      );
      setViewModeHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!viewModeHydrated) {
      return;
    }
    window.localStorage.setItem(
      VIEW_MODE_STORAGE_KEY,
      groupByProject ? "grouped" : "isolated",
    );
  }, [groupByProject, viewModeHydrated]);

  const refresh = useCallback(async (nextProvider: AnalyticsProvider = provider): Promise<void> => {
    if (
      refreshInFlight.current ||
      (document.visibilityState === "hidden" && hasSnapshot.current)
    ) {
      return;
    }

    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await fetch(`/api/analytics?provider=${nextProvider}&refresh=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(ANALYTICS_REFRESH_TIMEOUT_MS),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const errorPayload = z.object({ error: z.string() }).safeParse(raw);
        throw new Error(
          errorPayload.success ? errorPayload.data.error : "Analytics refresh failed.",
        );
      }
      const next = analyticsSnapshotSchema.parse(raw);
      if (next.provider !== provider) {
        setQuery(""); setProjectFilter("all"); setModelFilter("all");
        setEffortFilter("all"); setSelectedThreadId(null); setPricingOpen(false);
      }
      setSnapshot(next);
      hasSnapshot.current = true;
      const url = new URL(window.location.href);
      url.searchParams.set("provider", next.provider);
      window.history.replaceState(null, "", url);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "TimeoutError"
          ? "Analytics refresh timed out after 30 seconds"
          : error instanceof Error
            ? error.message
            : "Analytics refresh failed.";
      console.error("[codex-analytics-ledger] Refresh failed", error);
      setRefreshError(message);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
      setInitialLoadComplete(true);
    }
  }, [provider]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!hasSnapshot.current) void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh]);

  const projects = useMemo(
    () =>
      Array.from(new Set(snapshot.threads.map((thread) => thread.projectName))).sort(),
    [snapshot.threads],
  );

  const pricedThreads = useMemo<PricedThread[]>(
    () =>
      snapshot.threads.map((thread) => ({
        cost: estimateThreadCost(thread, rates),
        thread,
      })),
    [rates, snapshot.threads],
  );

  const selectedThread = useMemo(
    () => pricedThreads.find(item => item.thread.id === selectedThreadId) ?? null,
    [pricedThreads, selectedThreadId],
  );
  const selectThread = useCallback((item: PricedThread): void => {
    setSelectedThreadId(item.thread.id);
  }, []);

  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const items = pricedThreads.filter(({ thread }) => {
      const matchesSearch =
        !normalizedQuery ||
        thread.title.toLowerCase().includes(normalizedQuery) ||
        thread.projectName.toLowerCase().includes(normalizedQuery) ||
        thread.id.toLowerCase().includes(normalizedQuery);
      return (
        matchesSearch &&
        (showInternal || !thread.internal) &&
        (projectFilter === "all" || thread.projectName === projectFilter) &&
        (modelFilter === "all" ||
          thread.model === modelFilter ||
          thread.turnDetails.some((turn) => turn.model === modelFilter || turn.requestUsage.some(usage => usage.model === modelFilter))) &&
        (effortFilter === "all" || thread.reasoningEffort === effortFilter)
      );
    });

    return items.sort((left, right) => {
      if (sort === "cost") {
        return (right.cost?.total ?? -1) - (left.cost?.total ?? -1);
      }
      if (sort === "time") {
        return right.thread.activeDurationMs - left.thread.activeDurationMs;
      }
      if (sort === "tokens") {
        return right.thread.totalTokens - left.thread.totalTokens;
      }
      // “Recent” should reflect the latest activity, not the original start
      // time. Long-running tasks otherwise disappear below newer short tasks.
      return Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt);
    });
  }, [
    effortFilter,
    modelFilter,
    pricedThreads,
    projectFilter,
    query,
    showInternal,
    sort,
  ]);

  const visibleCost = filteredThreads.reduce(
    (sum, item) => sum + (item.cost?.total ?? 0),
    0,
  );
  const visibleTokens = filteredThreads.reduce(
    (sum, item) => sum + item.thread.totalTokens,
    0,
  );
  const visibleTime = filteredThreads.reduce(
    (sum, item) => sum + item.thread.activeDurationMs,
    0,
  );
  const incompleteUsageCount = filteredThreads.filter(item =>
    item.thread.usageCoverage === "partial" || item.thread.usageCoverage === "unknown",
  ).length;
  const visibleProjects = new Set(
    filteredThreads.map((item) => item.thread.projectName),
  ).size;
  const pricedCount = filteredThreads.filter((item) => item.cost !== null).length;
  const aggregates = buildModelAggregates(filteredThreads, rates);
  const projectGroups = useMemo(() => {
    const groups = new Map<string, PricedThread[]>();
    for (const item of filteredThreads) {
      const projectItems = groups.get(item.thread.projectName) ?? [];
      projectItems.push(item);
      groups.set(item.thread.projectName, projectItems);
    }
    return Array.from(groups.entries()).sort(
      ([leftName, leftItems], [rightName, rightItems]) => {
        const valueDifference =
          projectSortValue(rightItems, sort) - projectSortValue(leftItems, sort);
        return valueDifference || leftName.localeCompare(rightName);
      },
    );
  }, [filteredThreads, sort]);

  const updateRate = useCallback(
    (
      model: string,
      context: "long" | "short",
      field: keyof TokenRate,
      value: number | null,
    ): void => {
      setRates((current) => {
        const existing = resolveModelRate(model, current) ?? {
          long: null,
          short: { cachedInput: 0, cacheWrite: null, input: 0, output: 0 },
        };
        const contextRate = existing[context] ?? {
          cachedInput: null,
          cacheWrite: null,
          input: 0,
          output: 0,
        };
        const next = {
          ...current,
          [model]: {
            ...existing,
            [context]: { ...contextRate, [field]: value },
          },
        };
        window.localStorage.setItem(PRICING_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  const resetRates = useCallback((): void => {
    const next = getDefaultRates();
    window.localStorage.setItem(PRICING_STORAGE_KEY, JSON.stringify(next));
    setRates(next);
  }, []);

  const toggleTheme = useCallback((): void => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("codex-analytics-ledger:theme", nextTheme);
    setTheme(nextTheme);
  }, [theme]);

  const updateSort = useCallback((value: string): void => {
    const parsed = sortOptionSchema.safeParse(value);
    if (parsed.success) {
      setSort(parsed.data);
    }
  }, []);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#10120e] text-[#f1ecdf]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_18%_0%,rgba(215,255,95,0.10),transparent_35%),radial-gradient(circle_at_90%_8%,rgba(136,191,255,0.09),transparent_28%)]"
      />
      <div className="relative mx-auto max-w-[1540px] px-4 pb-14 pt-5 sm:px-6 lg:px-8">
        <header className="border-b border-[#35382f] pb-6">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center bg-[#d7ff5f] text-[#172000]">
                  <Activity aria-hidden="true" size={19} strokeWidth={2.2} />
                </span>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8a8f7f]">
                  Codex Analytics Ledger
                </span>
              </div>
              <h1 className="mt-5 max-w-4xl font-display text-4xl font-semibold tracking-[-0.055em] text-[#f1ecdf] sm:text-5xl lg:text-[4.25rem] lg:leading-[0.95]">
                Your work, measured.
                <span className="block text-[#6e7364]">No model call required.</span>
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div aria-label="Analytics provider" className="flex border border-[#35382f] p-1" role="group">
                {(["codex", "claude"] as const).map(value => (
                  <button
                    aria-pressed={provider === value}
                    className={`px-4 py-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[#d7ff5f] ${provider === value ? "bg-[#d7ff5f] text-[#172000]" : "text-[#a5aa9a] hover:text-[#f1ecdf]"}`}
                    disabled={refreshing}
                    key={value}
                    onClick={() => { if (value !== provider) void refresh(value); }}
                    type="button"
                  >
                    {value === "claude" ? "Claude" : "Codex"}
                  </button>
                ))}
              </div>
              <button
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                className="flex size-10 items-center justify-center border border-[#35382f] text-[#a5aa9a] outline-none transition-colors hover:border-[#88bfff] hover:text-[#88bfff] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
                onClick={toggleTheme}
                role="button"
                type="button"
              >
                {theme === "dark" ? (
                  <Sun aria-hidden="true" size={17} />
                ) : (
                  <Moon aria-hidden="true" size={17} />
                )}
              </button>
              <button
                aria-label={autoRefresh ? "Disable automatic refresh" : "Enable automatic refresh"}
                aria-pressed={autoRefresh}
                className={`flex items-center gap-2 border px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#d7ff5f] ${
                  autoRefresh
                    ? "border-[#536139] bg-[#1c2315] text-[#d7ff5f]"
                    : "border-[#35382f] text-[#858a7a] hover:border-[#53584a]"
                }`}
                onClick={() => setAutoRefresh((current) => !current)}
                role="button"
                type="button"
              >
                <span className="relative flex size-2">
                  {autoRefresh ? (
                    <span className="absolute inline-flex size-full animate-ping bg-[#d7ff5f] opacity-60" />
                  ) : null}
                  <span
                    className={`relative inline-flex size-2 ${autoRefresh ? "bg-[#d7ff5f]" : "bg-[#666b5d]"}`}
                  />
                </span>
                {autoRefresh ? "Live / 15s" : "Paused"}
              </button>
              <button
                aria-label={`Refresh ${providerLabel} analytics now`}
                className="flex size-10 items-center justify-center border border-[#35382f] text-[#a5aa9a] outline-none transition-colors hover:border-[#d7ff5f] hover:text-[#d7ff5f] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
                disabled={refreshing}
                onClick={() => void refresh()}
                role="button"
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={refreshing ? "animate-spin" : ""}
                  size={16}
                />
              </button>
              <button
                aria-label="Open model pricing settings"
                className="flex items-center gap-2 border border-[#35382f] px-3 py-2.5 text-xs text-[#b0b5a4] outline-none transition-colors hover:border-[#ff8067] hover:text-[#ff9c88] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
                onClick={() => setPricingOpen(true)}
                role="button"
                type="button"
              >
                <Settings2 aria-hidden="true" size={15} />
                Pricing
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] text-[#676c5e]">
            <span className="flex items-center gap-1.5">
              <Database aria-hidden="true" size={12} />
              {initialLoadComplete
                ? `${providerLabel} / ${snapshot.threads.length} indexed sessions`
                : "Indexing local threads…"}
            </span>
            {snapshot.generatedAt ? (
              <span>Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}</span>
            ) : null}
            {snapshot.databasePath ? (
              <span className="hidden max-w-xl truncate sm:inline">
                {snapshot.databasePath}
              </span>
            ) : null}
          </div>
        </header>

        {!initialLoadComplete ? (
          <div
            aria-live="polite"
            className="mt-4 flex items-center gap-3 border border-[#3d4136] bg-[#171914] p-3 text-sm text-[#b0b5a4]"
            role="status"
          >
            <RefreshCw aria-hidden="true" className="animate-spin shrink-0" size={16} />
            <p>Reading local {providerLabel} analytics. The dashboard controls remain available.</p>
          </div>
        ) : null}

        {refreshError ? (
          <div
            aria-live="polite"
            className="mt-4 flex items-start gap-3 border border-[#7a3b30] bg-[#2a1713] p-3 text-sm text-[#ffad9b]"
            role="alert"
          >
            <WifiOff aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
            <p>
              {refreshError}.
              {snapshot.generatedAt
                ? " Showing the last successful snapshot."
                : " Check the terminal for details, then try refresh again."}
            </p>
          </div>
        ) : null}

        {snapshot.warnings.length > 0 ? (
          <details className="mt-4 border border-[#35382f] bg-[#171914] p-3 text-xs leading-5 text-[#a5aa9a]" open={snapshot.threads.length === 0}>
            <summary className="cursor-pointer font-semibold">{providerLabel} data notes ({snapshot.warnings.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {snapshot.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
            </ul>
          </details>
        ) : null}

        <section
          aria-label="Analytics summary"
          className="mt-6 grid gap-px bg-[#30332b] border border-[#30332b] sm:grid-cols-2 xl:grid-cols-4"
        >
          <SummaryCard
            accent="lime"
            detail={`${visibleProjects} projects in the current view`}
            icon={Layers3}
            label="Visible threads"
            value={filteredThreads.length.toLocaleString()}
          />
          <SummaryCard
            accent="blue"
            detail={incompleteUsageCount ? `Recorded totals; ${incompleteUsageCount} sessions have incomplete usage` : "Session-reported total token usage"}
            icon={Sparkles}
            label="Token volume"
            value={formatTokens(visibleTokens)}
          />
          <SummaryCard
            accent="coral"
            detail={`${pricedCount} of ${filteredThreads.length} threads priced`}
            icon={CircleDollarSign}
            label="Estimated spend"
            value={formatCurrency(pricedCount > 0 ? visibleCost : null)}
          />
          <SummaryCard
            accent="paper"
            detail={provider === "claude" ? "Reported durations with elapsed-time fallbacks" : "Sum of Codex-reported active turn durations"}
            icon={Clock3}
            label="Active runtime"
            value={formatDuration(visibleTime)}
          />
        </section>

        <section aria-label="Thread filters" className="mt-6">
          <div className="grid gap-2 border border-[#30332b] bg-[#171914] p-3 lg:grid-cols-[minmax(240px,1.6fr)_repeat(4,minmax(130px,0.7fr))_auto]">
            <label className="relative block">
              <span className="sr-only">Search threads and projects</span>
              <Search
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#666b5d]"
                size={15}
              />
              <input
                aria-label="Search threads, projects, or thread IDs"
                className="h-10 w-full border border-[#35382f] bg-[#11130e] pl-9 pr-3 text-sm text-[#e5e0d4] outline-none placeholder:text-[#595e51] focus:border-[#d7ff5f]"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search thread, project, ID..."
                role="searchbox"
                type="search"
                value={query}
              />
            </label>

            <FilterSelect
              label="Project"
              onChange={setProjectFilter}
              options={projects.map((project) => ({ label: project, value: project }))}
              value={projectFilter}
            />
            <FilterSelect
              label="Model"
              onChange={setModelFilter}
              options={observedModels.map((model) => ({
                label: shortModelName(model),
                value: model,
              }))}
              value={modelFilter}
            />
            <FilterSelect
              label="Effort"
              onChange={setEffortFilter}
              options={["low", "medium", "high", "unspecified"].map((effort) => ({
                label: effort,
                value: effort,
              }))}
              value={effortFilter}
            />
            <FilterSelect
              label="Sort"
              onChange={updateSort}
              options={[
                { label: "Recent", value: "recent" },
                { label: "Cost: high", value: "cost" },
                { label: "Tokens: high", value: "tokens" },
                { label: "Time: high", value: "time" },
              ]}
              showAll={false}
              value={sort}
            />
            <div className="flex gap-2">
              <button
                aria-label={showInternal ? "Hide internal worker threads" : "Show internal worker threads"}
                aria-pressed={showInternal}
                className={`flex h-10 items-center justify-center gap-2 border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#d7ff5f] ${
                  showInternal
                    ? "border-[#88bfff] bg-[#172333] text-[#a9d1ff]"
                    : "border-[#35382f] text-[#7e8373] hover:border-[#53584a]"
                }`}
                onClick={() => setShowInternal((current) => !current)}
                role="button"
                type="button"
              >
                <Bot aria-hidden="true" size={14} />
                Workers
              </button>
              <button
                aria-label={groupByProject ? "Show a flat thread list" : "Group threads by project"}
                aria-pressed={groupByProject}
                className={`flex h-10 items-center justify-center gap-2 border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#d7ff5f] ${
                  groupByProject
                    ? "border-[#d7ff5f] bg-[#1c2315] text-[#d7ff5f]"
                    : "border-[#35382f] text-[#7e8373] hover:border-[#53584a]"
                }`}
                onClick={() => setGroupByProject((current) => !current)}
                role="button"
                type="button"
              >
                <Layers3 aria-hidden="true" size={14} />
                {groupByProject ? "Isolated" : "Grouped"}
              </button>
            </div>
          </div>
        </section>

        <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="thread-ledger-heading">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#757a6b]">
                  Thread ledger
                </p>
                <h2
                  className="mt-1 font-display text-xl font-semibold tracking-[-0.03em] text-[#eee8dc]"
                  id="thread-ledger-heading"
                >
                  {groupByProject ? "Runs, organized by project" : "Every run, one row"}
                </h2>
              </div>
              <p className="font-mono text-[10px] text-[#666b5d]">
                {filteredThreads.length} result{filteredThreads.length === 1 ? "" : "s"}
              </p>
            </div>
            {groupByProject ? (
              <div className="space-y-4">
                {projectGroups.map(([projectName, items]) => (
                  <details
                    className="group/project border border-[#30332b] bg-[#151711]"
                    key={projectName}
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 border-b border-[#30332b] bg-[#1c1e18] px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#d7ff5f]">
                      <span>
                        <span className="font-display text-sm font-semibold text-[#eee8dc]">
                          {projectName}
                        </span>
                        <span className="ml-2 font-mono text-[10px] text-[#73786a]">
                          {items.length} thread{items.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="font-mono text-xs font-bold text-[#d7ff5f]">
                        {formatCurrency(
                          items.some((item) => item.cost !== null)
                            ? items.reduce(
                                (total, item) => total + (item.cost?.total ?? 0),
                                0,
                              )
                            : null,
                        )}
                      </span>
                    </summary>
                    <ThreadTable
                      items={items}
                      onSelect={selectThread}
                      showProject={false}
                    />
                  </details>
                ))}
              </div>
            ) : (
              <ThreadTable items={filteredThreads} onSelect={selectThread} />
            )}
          </section>
          <div className="xl:sticky xl:top-5">
            <ModelPerformance models={aggregates} />
            <div className="mt-3 border border-[#30332b] bg-[#151711] p-4 text-xs leading-5 text-[#73786a]">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#a3a897]">
                <Filter aria-hidden="true" size={13} /> Reading rule
              </div>
              <p className="mt-3">
                Cost is an estimate from local token counters and your saved rates.
                User inputs stay inside this local app; assistant and tool output
                content is never returned by the analytics API.
              </p>
            </div>
          </div>
        </div>
      </div>

      <ThreadDetail
        item={selectedThread}
        onClose={() => setSelectedThreadId(null)}
        rates={rates}
      />
      <PricingDialog
        provider={provider}
        models={Array.from(new Set([...Object.keys(provider === "claude" ? CLAUDE_MODEL_RATES : DEFAULT_MODEL_RATES), ...observedModels])).filter(model => model !== "Unknown model").sort()}
        onChange={updateRate}
        onClose={() => setPricingOpen(false)}
        onReset={resetRates}
        open={pricingOpen}
        rates={rates}
      />
    </main>
  );
}

interface FilterSelectProps {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  showAll?: boolean;
  value: string;
}

function FilterSelect({
  label,
  onChange,
  options,
  showAll = true,
  value,
}: FilterSelectProps): React.ReactNode {
  return (
    <label className="relative block">
      <span className="sr-only">Filter by {label}</span>
      <select
        aria-label={`Filter by ${label}`}
        className="h-10 w-full appearance-none border border-[#35382f] bg-[#11130e] px-3 pr-8 text-xs capitalize text-[#aeb3a2] outline-none focus:border-[#d7ff5f]"
        onChange={(event) => onChange(event.target.value)}
        role="combobox"
        value={value}
      >
        {showAll ? <option value="all">All {label.toLowerCase()}s</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#666b5d]"
        size={13}
      />
    </label>
  );
}
