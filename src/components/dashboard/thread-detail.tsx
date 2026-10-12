"use client";

import { useEffect, useMemo } from "react";
import {
  Bot,
  Clock3,
  Coins,
  FileKey2,
  Gauge,
  MessageSquareText,
  TerminalSquare,
  X,
} from "lucide-react";

import type {
  PricedThread,
  PricedTurn,
} from "@/components/dashboard/dashboard-types";
import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatTokens,
  shortModelName,
} from "@/components/dashboard/formatting";
import type { ModelRate } from "@/lib/analytics-types";
import { estimateTurnCost } from "@/lib/pricing";

interface ThreadDetailProps {
  item: PricedThread | null;
  onClose: () => void;
  rates: Readonly<Record<string, ModelRate>>;
}

interface DetailMetricProps {
  label: string;
  value: string;
}

function DetailMetric({ label, value }: DetailMetricProps): React.ReactNode {
  return (
    <div className="border-l border-[#3a3e34] pl-3">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[#686d5f]">
        {label}
      </dt>
      <dd className="mt-1.5 font-mono text-sm font-semibold text-[#e2ddd1]">
        {value}
      </dd>
    </div>
  );
}

export function ThreadDetail({
  item,
  onClose,
  rates,
}: ThreadDetailProps): React.ReactNode {
  const pricedTurns = useMemo<PricedTurn[]>(
    () =>
      (item?.thread.turnDetails ?? []).map((turn) => ({
        cost: estimateTurnCost(turn, rates),
        turn,
      })).sort(
        (left, right) =>
          Date.parse(right.turn.startedAt) - Date.parse(left.turn.startedAt),
      ),
    [item, rates],
  );
  useEffect(() => {
    if (!item) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClose]);

  if (!item) {
    return null;
  }

  const isClaude = item.thread.source.startsWith("Claude");
  const toolCalls = item.thread.turnDetails.flatMap(turn => turn.toolCallDetails);
  const cacheRatio =
    item.thread.inputTokens > 0
      ? item.thread.cachedInputTokens / item.thread.inputTokens
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      role="presentation"
    >
      <button
        aria-label="Close thread analytics details"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        role="button"
        type="button"
      />
      <aside
        aria-label={`Analytics for ${item.thread.title}`}
        aria-modal="true"
        className="relative h-[calc(100vh-1.5rem)] max-h-[92vh] w-full max-w-5xl overflow-y-auto border border-[#3a3e34] bg-[#12140f] shadow-2xl sm:h-[min(92vh,1100px)]"
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[#30332b] bg-[#12140f]/95 p-5 backdrop-blur sm:p-7">
          <div className="pr-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d7ff5f]">
              Thread telemetry
            </p>
            <h2 className="mt-3 font-display text-xl font-semibold leading-7 tracking-[-0.03em] text-[#f1ecdf]">
              {item.thread.title}
            </h2>
            <p className="mt-2 font-mono text-[10px] text-[#6d7263]">
              {item.thread.id}
            </p>
          </div>
          <button
            aria-label="Close thread details"
            className="flex size-10 shrink-0 items-center justify-center border border-[#383c32] text-[#949989] outline-none transition-colors hover:bg-[#d7ff5f] hover:text-[#172000] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
            onClick={onClose}
            role="button"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="space-y-7 p-5 sm:p-7">
          {isClaude ? (
            <p className="text-xs leading-5 text-[#a5aa9a]">
              Runtime: {item.thread.durationSource === "reported" ? "reported by Claude" : item.thread.durationSource === "mixed" ? "reported durations and elapsed-time estimates" : "estimated from saved timestamps"}.
              {item.thread.parentSessionId ? ` Parent session: ${item.thread.parentSessionId}.` : ""}
              {item.thread.usageCoverage === "partial" ? " Token totals are partial; the full session cost is unknown."
                : item.thread.hasDetailedUsage ? "" : " Token usage is unavailable for this session."}
            </p>
          ) : null}
          <section className="grid grid-cols-2 gap-5 border border-[#30332b] bg-[#171914] p-4 sm:grid-cols-3">
            <DetailMetric
              label="Estimated cost"
              value={formatCurrency(item.cost?.total ?? null)}
            />
            <DetailMetric
              label="Active time"
              value={formatDuration(item.thread.activeDurationMs)}
            />
            <DetailMetric
              label="Total tokens"
              value={item.thread.hasDetailedUsage || !isClaude ? formatTokens(item.thread.totalTokens) : "Unknown"}
            />
            <DetailMetric
              label="Cache hit"
              value={
                item.thread.hasDetailedUsage ? formatPercent(cacheRatio) : "Unknown"
              }
            />
            <DetailMetric label="Turns" value={item.thread.turns.toString()} />
            <DetailMetric
              label="Avg. TTFT"
              value={
                item.thread.timeToFirstTokenMs === null
                  ? "Unknown"
                  : formatDuration(item.thread.timeToFirstTokenMs)
              }
            />
          </section>

          <section aria-labelledby="turn-ledger-heading">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquareText
                  aria-hidden="true"
                  className="text-[#88bfff]"
                  size={17}
                />
                <h3
                  className="font-display text-base font-semibold text-[#eee8dc]"
                  id="turn-ledger-heading"
                >
                  Task-by-task ledger
                </h3>
              </div>
              <span className="font-mono text-[10px] text-[#73786a]">
                {pricedTurns.length} task{pricedTurns.length === 1 ? "" : "s"}
              </span>
            </div>

            {pricedTurns.length > 0 ? (
              <div className="mt-4 overflow-x-auto border border-[#30332b]">
                <table className="w-full min-w-[900px] border-collapse text-left">
                  <caption className="sr-only">
                    User messages with date, model, runtime, tokens, and estimated cost
                  </caption>
                  <thead>
                    <tr className="border-b border-[#30332b] bg-[#1c1e18] font-mono text-[9px] uppercase tracking-[0.14em] text-[#7e8373]">
                      <th className="px-3 py-3 font-medium" scope="col">Task input</th>
                      <th className="px-3 py-3 font-medium" scope="col">Started</th>
                      <th className="px-3 py-3 font-medium" scope="col">Model</th>
                      <th className="px-3 py-3 font-medium" scope="col">Time</th>
                      <th className="px-3 py-3 font-medium" scope="col">Tokens</th>
                      <th className="px-3 py-3 text-right font-medium" scope="col">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#292c25]">
                    {pricedTurns.map(({ cost, turn }, index) => (
                      <tr className="align-top" key={turn.id}>
                        <td className="max-w-md px-3 py-3">
                          <details>
                            <summary className="cursor-pointer list-none text-sm font-medium leading-5 text-[#e2ddd1] outline-none focus-visible:ring-2 focus-visible:ring-[#d7ff5f]">
                              <span className="mr-2 font-mono text-[9px] uppercase text-[#88bfff]">
                                #{index + 1}
                              </span>
                              <span className="line-clamp-2 whitespace-pre-wrap">{turn.message}</span>
                            </summary>
                            <p className="mt-3 whitespace-pre-wrap border-l border-[#3a3e34] pl-3 text-xs leading-5 text-[#a5a99b]">
                              {turn.message}
                            </p>
                          </details>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-[#a5a99b]">
                          {formatDateTime(turn.startedAt)}
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-mono text-xs font-semibold text-[#dcd7ca]">
                            {shortModelName(turn.model)}
                          </p>
                          <p className="mt-1 text-[10px] capitalize text-[#73786a]">
                            {turn.reasoningEffort} effort
                          </p>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-[#dcd7ca]">
                          {!turn.completed && item.thread.isPossiblyActive && index === 0 ? "Running" : formatDuration(turn.durationMs)}
                          <p className="mt-1 text-[10px] text-[#73786a]">
                            TTFT {turn.timeToFirstTokenMs === null ? "--" : formatDuration(turn.timeToFirstTokenMs)}
                          </p>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-[#dcd7ca]">
                          {turn.usageCoverage === "unknown" ? "Unknown" : formatTokens(turn.totalTokens)}
                          <p className="mt-1 text-[10px] text-[#73786a]">
                            {turn.usageCoverage === "unknown" ? "No saved usage" : `${formatTokens(turn.outputTokens)} out${turn.usageCoverage === "partial" ? " / partial" : ""}`}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-xs font-bold text-[#d7ff5f]">
                          {formatCurrency(cost?.total ?? null)}
                          <p className="mt-1 text-[9px] font-normal uppercase text-[#73786a]">
                            {cost?.usesLongContextRate ? "Long" : "Short"} rate
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 border border-dashed border-[#3a3e34] p-4 text-sm leading-6 text-[#858a7a]">
                Turn-level events were not available for this older session.
              </p>
            )}
          </section>

          {isClaude ? (
            <section aria-labelledby="tool-ledger-heading">
              <h3 className="font-display text-base font-semibold text-[#eee8dc]" id="tool-ledger-heading">
                Tool calls ({toolCalls.length})
              </h3>
              {toolCalls.length ? (
                <div className="mt-4 overflow-x-auto border border-[#30332b]">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">Saved tool calls, outcomes, elapsed time, and record source</caption>
                    <thead className="bg-[#1c1e18] text-[#a5aa9a]">
                      <tr>{["Tool", "Started", "Status", "Time", "Source"].map(label => <th className="px-3 py-3" key={label} scope="col">{label}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-[#292c25] text-[#dcd7ca]">
                      {toolCalls.map(call => (
                        <tr key={call.id}>
                          <td className="px-3 py-3 font-mono">{call.name}</td>
                          <td className="whitespace-nowrap px-3 py-3">{formatDateTime(call.startedAt)}</td>
                          <td className="px-3 py-3">{call.status}</td>
                          <td className="px-3 py-3">{call.durationMs === null ? "Unknown" : formatDuration(call.durationMs)}</td>
                          <td className="px-3 py-3">{call.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="mt-3 text-xs text-[#a5aa9a]">No tool calls were found in the saved records.</p>}
            </section>
          ) : null}

          <section aria-labelledby="identity-heading">
            <div className="flex items-center gap-2">
              <Bot aria-hidden="true" className="text-[#88bfff]" size={17} />
              <h3
                className="font-display text-base font-semibold text-[#eee8dc]"
                id="identity-heading"
              >
                Execution identity
              </h3>
            </div>
            <dl className="mt-4 divide-y divide-[#2c2f28] border-y border-[#2c2f28] text-sm">
              <div className="flex justify-between gap-4 py-3">
                <dt className="text-[#74796a]">Model</dt>
                <dd className="font-mono text-right text-[#dcd7ca]">
                  {shortModelName(item.thread.model)} / {item.thread.reasoningEffort}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt className="text-[#74796a]">Project</dt>
                <dd className="max-w-[70%] break-all text-right text-[#dcd7ca]">
                  {item.thread.projectName}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt className="text-[#74796a]">Project path</dt>
                <dd className="max-w-[70%] break-all text-right font-mono text-xs text-[#a5a99b]">
                  {item.thread.projectPath}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt className="text-[#74796a]">Started</dt>
                <dd className="font-mono text-right text-[#dcd7ca]">
                  {formatDateTime(item.thread.startedAt)}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="tokens-heading">
            <div className="flex items-center gap-2">
              <Gauge aria-hidden="true" className="text-[#d7ff5f]" size={17} />
              <h3
                className="font-display text-base font-semibold text-[#eee8dc]"
                id="tokens-heading"
              >
                Token ledger
              </h3>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-px bg-[#30332b] border border-[#30332b]">
              <div className="bg-[#171914] p-4">
                <dt className="text-xs text-[#74796a]">Input</dt>
                <dd className="mt-2 font-mono text-base text-[#e0dbcf]">
                  {formatTokens(item.thread.inputTokens)}
                </dd>
              </div>
              <div className="bg-[#171914] p-4">
                <dt className="text-xs text-[#74796a]">Cached input</dt>
                <dd className="mt-2 font-mono text-base text-[#e0dbcf]">
                  {formatTokens(item.thread.cachedInputTokens)}
                </dd>
              </div>
              {isClaude ? (
                <div className="bg-[#171914] p-4">
                  <dt className="text-xs text-[#74796a]">Cache writes (5m / 1h)</dt>
                  <dd className="mt-2 font-mono text-base text-[#e0dbcf]">{formatTokens(item.thread.cacheWriteTokens - item.thread.cacheWriteLongTokens)} / {formatTokens(item.thread.cacheWriteLongTokens)}</dd>
                </div>
              ) : null}
              <div className="bg-[#171914] p-4">
                <dt className="text-xs text-[#74796a]">Output</dt>
                <dd className="mt-2 font-mono text-base text-[#e0dbcf]">
                  {formatTokens(item.thread.outputTokens)}
                </dd>
              </div>
              <div className="bg-[#171914] p-4">
                <dt className="text-xs text-[#74796a]">Reasoning output</dt>
                <dd className="mt-2 font-mono text-base text-[#e0dbcf]">
                  {isClaude ? "Unknown" : formatTokens(item.thread.reasoningOutputTokens)}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="cost-heading">
            <div className="flex items-center gap-2">
              <Coins aria-hidden="true" className="text-[#ff8067]" size={17} />
              <h3
                className="font-display text-base font-semibold text-[#eee8dc]"
                id="cost-heading"
              >
                Cost composition
              </h3>
            </div>
            {item.cost ? (
              <>
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#858a7a]">
                  {item.cost.usesLongContextRate ? "Long" : "Short"} context rate
                  {item.thread.peakInputTokens > 0
                    ? ` / ${formatTokens(item.thread.peakInputTokens)} peak input`
                    : ""}
                </p>
                <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between border-b border-[#292c25] pb-3">
                  <dt className="text-[#777c6d]">Non-cached input</dt>
                  <dd className="font-mono text-[#dcd7ca]">
                    {formatCurrency(item.cost.inputCost)}
                  </dd>
                </div>
                <div className="flex justify-between border-b border-[#292c25] pb-3">
                  <dt className="text-[#777c6d]">Cache reads</dt>
                  <dd className="font-mono text-[#dcd7ca]">
                    {formatCurrency(item.cost.cacheReadCost)}
                  </dd>
                </div>
                {isClaude ? <div className="flex justify-between border-b border-[#292c25] pb-3">
                  <dt className="text-[#777c6d]">Cache writes</dt>
                  <dd className="font-mono text-[#dcd7ca]">{formatCurrency(item.cost.cacheWriteCost)}</dd>
                </div> : null}
                <div className="flex justify-between border-b border-[#292c25] pb-3">
                  <dt className="text-[#777c6d]">Output</dt>
                  <dd className="font-mono text-[#dcd7ca]">
                    {formatCurrency(item.cost.outputCost)}
                  </dd>
                </div>
                </dl>
              </>
            ) : (
              <p className="mt-4 border border-dashed border-[#3a3e34] p-4 text-sm leading-6 text-[#858a7a]">
                {item.thread.usageCoverage === "partial" || item.thread.usageCoverage === "unknown"
                  ? "Complete token usage is unavailable, so the full session cost cannot be calculated."
                  : `Add pricing for ${item.thread.model} to calculate this thread.`}
              </p>
            )}
          </section>

          <section className="grid grid-cols-3 gap-3 border-t border-[#30332b] pt-5">
            <div className="text-center">
              <TerminalSquare
                aria-hidden="true"
                className="mx-auto text-[#73786a]"
                size={16}
              />
              <p className="mt-2 font-mono text-sm text-[#ded9cc]">
                {item.thread.shellCommands}
              </p>
              <p className="mt-1 text-[10px] text-[#666b5d]">Shell calls</p>
            </div>
            <div className="text-center">
              <FileKey2
                aria-hidden="true"
                className="mx-auto text-[#73786a]"
                size={16}
              />
              <p className="mt-2 font-mono text-sm text-[#ded9cc]">
                {item.thread.prompts}
              </p>
              <p className="mt-1 text-[10px] text-[#666b5d]">Prompts</p>
            </div>
            <div className="text-center">
              <Clock3
                aria-hidden="true"
                className="mx-auto text-[#73786a]"
                size={16}
              />
              <p className="mt-2 font-mono text-sm text-[#ded9cc]">
                {formatDuration(item.thread.wallDurationMs)}
              </p>
              <p className="mt-1 text-[10px] text-[#666b5d]">Wall span</p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
