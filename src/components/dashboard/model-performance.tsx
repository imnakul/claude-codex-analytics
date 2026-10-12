import { ArrowUpRight, CircleGauge } from "lucide-react";

import type { ModelAggregate } from "@/components/dashboard/dashboard-types";
import {
  formatCurrency,
  formatDuration,
  formatTokens,
} from "@/components/dashboard/formatting";

interface ModelPerformanceProps {
  models: ModelAggregate[];
}

export function ModelPerformance({
  models,
}: ModelPerformanceProps): React.ReactNode {
  return (
    <section
      aria-labelledby="model-performance-heading"
      className="border border-[#30332b] bg-[#171914]"
    >
      <header className="flex items-start justify-between border-b border-[#30332b] p-4 sm:p-5">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-[#d7ff5f]">
            Comparative signal
          </p>
          <h2
            id="model-performance-heading"
            className="mt-2 font-display text-xl font-semibold tracking-[-0.03em] text-[#f1ecdf]"
          >
            Model performance
          </h2>
        </div>
        <CircleGauge aria-hidden="true" className="text-[#7b806f]" size={22} />
      </header>

      <div className="divide-y divide-[#292c25]">
        {models.length === 0 ? (
          <p className="p-5 text-sm text-[#8e9383]">
            No model data matches the current filters.
          </p>
        ) : (
          models.slice(0, 6).map((model, index) => (
            <article
              className="grid grid-cols-[auto_1fr] gap-3 p-4 transition-colors hover:bg-[#1d1f19] sm:p-5"
              key={model.key}
            >
              <span className="font-mono text-xs text-[#5f6456]">
                {(index + 1).toString().padStart(2, "0")}
              </span>
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-sm font-semibold text-[#f1ecdf]">
                      {model.label}
                    </h3>
                    <p className="mt-1 text-xs text-[#777c6c]">
                      {model.sampleCount} task{model.sampleCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 font-mono text-sm font-semibold text-[#d7ff5f]">
                    {formatCurrency(model.averageCost)}
                    <ArrowUpRight aria-hidden="true" size={13} />
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-[#636859]">Avg. runtime</dt>
                    <dd className="mt-1 font-mono text-[#c9c5b9]">
                      {model.averageDurationMs === null ? "Unknown" : formatDuration(model.averageDurationMs)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#636859]">Avg. tokens</dt>
                    <dd className="mt-1 font-mono text-[#c9c5b9]">
                      {formatTokens(model.averageTokens)}
                    </dd>
                  </div>
                </dl>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
