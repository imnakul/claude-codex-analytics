import { ArrowUpRight, Box, CircleDot, TimerReset } from "lucide-react";

import type { PricedThread } from "@/components/dashboard/dashboard-types";
import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatTokens,
  shortModelName,
} from "@/components/dashboard/formatting";

interface ThreadTableProps {
  items: PricedThread[];
  onSelect: (item: PricedThread) => void;
  showProject?: boolean;
}

function modelAccent(model: string): string {
  if (model.includes("luna")) {
    return "bg-[#d7ff5f] text-[#172000]";
  }
  if (model.includes("terra")) {
    return "bg-[#88bfff] text-[#0d1d2e]";
  }
  if (model.includes("sol")) {
    return "bg-[#ff8067] text-[#2b0c07]";
  }
  return "bg-[#d9d3c5] text-[#23231d]";
}

function cacheRatio(item: PricedThread): number {
  return item.thread.inputTokens > 0
    ? item.thread.cachedInputTokens / item.thread.inputTokens
    : 0;
}

export function ThreadTable({
  items,
  onSelect,
  showProject = true,
}: ThreadTableProps): React.ReactNode {
  if (items.length === 0) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center border border-dashed border-[#3a3e34] bg-[#151711] px-6 text-center">
        <Box aria-hidden="true" className="text-[#666b5d]" size={28} />
        <h3 className="mt-4 font-display text-lg font-semibold text-[#eee8dc]">
          No threads in this cut
        </h3>
        <p className="mt-2 max-w-sm text-sm leading-6 text-[#777c6d]">
          Adjust the project, model, search, or internal-thread filters.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto border border-[#30332b] bg-[#171914] md:block">
        <table className="w-full min-w-[980px] border-collapse text-left">
          <caption className="sr-only">
            Session runtime, token usage, model, and estimated cost
          </caption>
          <thead>
            <tr className="border-b border-[#3a3d34] bg-[#1c1e18] font-mono text-[10px] uppercase tracking-[0.16em] text-[#7e8373]">
              <th className="px-4 py-3 font-medium" scope="col">
                {showProject ? "Thread / project" : "Thread"}
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                Model
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                Last updated
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                Active time
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                Tokens
              </th>
              <th className="px-4 py-3 font-medium" scope="col">
                Cache
              </th>
              <th className="px-4 py-3 text-right font-medium" scope="col">
                Est. cost
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#292c25]">
            {items.map((item) => (
              <tr
                aria-label={`Open analytics details for ${item.thread.title}`}
                className="group cursor-pointer transition-colors duration-150 hover:bg-[#1e211a]"
                key={item.thread.id}
                onClick={() => onSelect(item)}
                onKeyDown={(event: React.KeyboardEvent<HTMLTableRowElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(item);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <td className="max-w-[22rem] px-4 py-4 align-top">
                  <span className="block w-full text-left">
                    <span className="flex items-start gap-2">
                      {item.thread.isPossiblyActive ? (
                        <CircleDot
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-[#d7ff5f]"
                          size={14}
                        />
                      ) : null}
                      <span className="line-clamp-2 text-sm font-medium leading-5 text-[#e8e3d7] transition-colors group-hover:text-[#d7ff5f]">
                        {item.thread.title}
                      </span>
                    </span>
                    {showProject ? (
                      <span className="mt-1.5 block truncate pl-[1.375rem] font-mono text-[10px] uppercase tracking-[0.12em] text-[#686d5f]">
                        {item.thread.projectName}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="px-4 py-4 align-top">
                  <span
                    className={`inline-flex px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${modelAccent(item.thread.model)}`}
                  >
                    {shortModelName(item.thread.model)}
                  </span>
                  <span className="mt-2 block text-xs capitalize text-[#777c6d]">
                    {item.thread.reasoningEffort} effort
                  </span>
                </td>
                <td className="px-4 py-4 align-top font-mono text-xs text-[#a4a698]">
                  {formatDateTime(item.thread.updatedAt)}
                </td>
                <td className="px-4 py-4 align-top">
                  <span className="font-mono text-sm font-semibold text-[#d8d4c9]">
                    {formatDuration(item.thread.activeDurationMs)}
                  </span>
                  <span className="mt-1 block text-[11px] text-[#666b5d]">
                    Wall {formatDuration(item.thread.wallDurationMs)}
                  </span>
                </td>
                <td className="px-4 py-4 align-top">
                  <span className="font-mono text-sm font-semibold text-[#d8d4c9]">
                    {item.thread.hasDetailedUsage || !item.thread.source.startsWith("Claude") ? formatTokens(item.thread.totalTokens) : "Unknown"}
                  </span>
                  <span className="mt-1 block text-[11px] text-[#666b5d]">
                    {item.thread.hasDetailedUsage ? `${formatTokens(item.thread.outputTokens)} out` : "No saved usage"}
                  </span>
                </td>
                <td className="px-4 py-4 align-top">
                  <span className="font-mono text-sm text-[#aeb3a2]">
                    {item.thread.hasDetailedUsage
                      ? formatPercent(cacheRatio(item))
                      : "--"}
                  </span>
                  <span className="mt-1 block text-[11px] text-[#666b5d]">
                    input read
                  </span>
                </td>
                <td className="px-4 py-4 text-right align-top">
                  <span className="font-mono text-sm font-bold text-[#d7ff5f]">
                    {formatCurrency(item.cost?.total ?? null)}
                  </span>
                  <span className="ml-auto mt-1 flex items-center gap-1 text-[11px] text-[#6f7465] transition-colors group-hover:text-[#d7ff5f]">
                    Breakdown
                    <ArrowUpRight aria-hidden="true" size={12} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {items.map((item) => (
          <button
            aria-label={`Open analytics details for ${item.thread.title}`}
            className="w-full border border-[#30332b] bg-[#171914] p-4 text-left outline-none transition-colors hover:border-[#4a4f41] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
            key={item.thread.id}
            onClick={() => onSelect(item)}
            role="button"
            type="button"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-semibold leading-5 text-[#ece7db]">
                  {item.thread.title}
                </p>
                {showProject ? (
                  <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#686d5f]">
                    {item.thread.projectName}
                  </p>
                ) : null}
              </div>
              <span
                className={`shrink-0 px-2 py-1 font-mono text-[9px] font-bold uppercase ${modelAccent(item.thread.model)}`}
              >
                {shortModelName(item.thread.model)}
              </span>
            </div>
            <dl className="mt-5 grid grid-cols-3 gap-2 border-t border-[#2b2e27] pt-4">
              <div>
                <dt className="flex items-center gap-1 text-[10px] text-[#666b5d]">
                  <TimerReset aria-hidden="true" size={11} /> Time
                </dt>
                <dd className="mt-1 font-mono text-xs text-[#d8d4c9]">
                  {formatDuration(item.thread.activeDurationMs)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-[#666b5d]">Tokens</dt>
                <dd className="mt-1 font-mono text-xs text-[#d8d4c9]">
                  {item.thread.hasDetailedUsage || !item.thread.source.startsWith("Claude") ? formatTokens(item.thread.totalTokens) : "Unknown"}
                </dd>
              </div>
              <div className="text-right">
                <dt className="text-[10px] text-[#666b5d]">Est. cost</dt>
                <dd className="mt-1 font-mono text-xs font-bold text-[#d7ff5f]">
                  {formatCurrency(item.cost?.total ?? null)}
                </dd>
              </div>
            </dl>
          </button>
        ))}
      </div>
    </>
  );
}
