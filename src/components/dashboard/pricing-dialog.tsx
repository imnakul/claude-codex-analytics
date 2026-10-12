"use client";

import { useEffect } from "react";
import { Info, RotateCcw, X } from "lucide-react";

import type { AnalyticsProvider, ModelRate, TokenRate } from "@/lib/analytics-types";
import { resolveModelRate } from "@/lib/pricing";
import { shortModelName } from "@/components/dashboard/formatting";

interface PricingDialogProps {
  provider: AnalyticsProvider;
  models: string[];
  onChange: (
    model: string,
    context: "long" | "short",
    field: keyof TokenRate,
    value: number | null,
  ) => void;
  onClose: () => void;
  onReset: () => void;
  open: boolean;
  rates: Readonly<Record<string, ModelRate>>;
}

interface RateInputProps {
  context: "long" | "short";
  field: keyof TokenRate;
  label: string;
  model: string;
  nullable?: boolean;
  onChange: PricingDialogProps["onChange"];
  value: number | null;
}

function RateInput({
  context,
  field,
  label,
  model,
  nullable = false,
  onChange,
  value,
}: RateInputProps): React.ReactNode {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.12em] text-[#6f7465]">
        {label}
      </span>
      <span className="mt-1 flex items-center border border-[#3a3e34] bg-[#11130e] focus-within:border-[#d7ff5f]">
        <span className="pl-2 font-mono text-xs text-[#666b5d]">$</span>
        <input
          aria-label={`${label} price per million tokens for ${model}`}
          className="w-full bg-transparent px-1.5 py-2 font-mono text-sm text-[#ebe6d9] outline-none"
          inputMode="decimal"
          min="0"
          onChange={(event) => {
            const rawValue = event.target.value;
            onChange(
              model,
              context,
              field,
              rawValue === "" && nullable
                ? null
                : Math.max(0, Number(rawValue) || 0),
            );
          }}
          role="spinbutton"
          step="0.01"
          type="number"
          value={value ?? ""}
        />
      </span>
    </label>
  );
}

export function PricingDialog({
  provider,
  models,
  onChange,
  onClose,
  onReset,
  open,
  rates,
}: PricingDialogProps): React.ReactNode {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        aria-label="Close pricing settings"
        className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
        onClick={onClose}
        role="button"
        type="button"
      />
      <section
        aria-labelledby="pricing-title"
        aria-modal="true"
        className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-[#42463a] bg-[#151711] shadow-2xl"
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[#30332b] bg-[#151711]/95 p-5 backdrop-blur sm:p-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#ff8067]">
              Local browser settings
            </p>
            <h2
              className="mt-2 font-display text-2xl font-semibold tracking-[-0.04em] text-[#f1ecdf]"
              id="pricing-title"
            >
              Model pricing
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#858a7a]">
              Rates are USD per one million tokens and stay in this browser.
            </p>
          </div>
          <button
            aria-label="Close model pricing settings"
            className="flex size-10 items-center justify-center border border-[#383c32] text-[#949989] outline-none transition-colors hover:bg-[#d7ff5f] hover:text-[#172000] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
            onClick={onClose}
            role="button"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="p-5 sm:p-6">
          <div className="flex gap-3 border border-[#3d4136] bg-[#1c1f18] p-4 text-xs leading-5 text-[#969b8b]">
            <Info aria-hidden="true" className="mt-0.5 shrink-0 text-[#88bfff]" size={16} />
            <p>
              {provider === "claude"
                ? "Defaults use Claude first-party API list prices checked October 12, 2026. Each saved request is priced separately, including cache reads and 5-minute / 1-hour writes. These estimates exclude fast mode, regional premiums, tool charges, discounts, and subscription billing. Unknown models need a saved rate."
                : "Defaults are the OpenAI rates you supplied. Long-context rates apply when a recorded prompt exceeds 272K input tokens. Codex does not expose cache-write token counts, so cache writes are excluded."}
            </p>
          </div>

          <div className="mt-5 divide-y divide-[#30332b] border-y border-[#30332b]">
            {models.map((model) => {
              const rate = resolveModelRate(model, rates) ?? {
                long: null,
                short: {
                  cachedInput: 0,
                  cacheWrite: null,
                  input: 0,
                  output: 0,
                },
              };
              return (
                <article
                  className="grid gap-4 py-5 lg:grid-cols-[0.8fr_2fr] lg:items-start"
                  key={model}
                >
                  <div>
                    <h3 className="font-display text-base font-semibold text-[#e9e4d8]">
                      {shortModelName(model)}
                    </h3>
                    <p className="mt-1 break-all font-mono text-[10px] text-[#666b5d]">
                      {model}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[#858a7a]">
                        Short context
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <RateInput context="short" field="input" label="Input" model={model} onChange={onChange} value={rate.short.input} />
                        <RateInput context="short" field="cachedInput" label="Cached" model={model} nullable onChange={onChange} value={rate.short.cachedInput} />
                        <RateInput context="short" field="cacheWrite" label="5m cache write" model={model} nullable onChange={onChange} value={rate.short.cacheWrite} />
                        {provider === "claude" ? <RateInput context="short" field="cacheWriteLong" label="1h cache write" model={model} nullable onChange={onChange} value={rate.short.cacheWriteLong ?? null} /> : null}
                        <RateInput context="short" field="output" label="Output" model={model} onChange={onChange} value={rate.short.output} />
                      </div>
                    </div>
                    {rate.long ? (
                      <div>
                        <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[#858a7a]">
                          Long context
                        </p>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                          <RateInput context="long" field="input" label="Input" model={model} onChange={onChange} value={rate.long.input} />
                          <RateInput context="long" field="cachedInput" label="Cached" model={model} nullable onChange={onChange} value={rate.long.cachedInput} />
                          <RateInput context="long" field="cacheWrite" label="5m cache write" model={model} nullable onChange={onChange} value={rate.long.cacheWrite} />
                          {provider === "claude" ? <RateInput context="long" field="cacheWriteLong" label="1h cache write" model={model} nullable onChange={onChange} value={rate.long.cacheWriteLong ?? null} /> : null}
                          <RateInput context="long" field="output" label="Output" model={model} onChange={onChange} value={rate.long.output} />
                        </div>
                      </div>
                    ) : (
                      <p className="font-mono text-[10px] text-[#666b5d]">
                        No long-context rate listed.
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <footer className="mt-6 flex flex-col-reverse justify-between gap-3 sm:flex-row">
            <button
              aria-label="Reset all model pricing to defaults"
              className="flex items-center justify-center gap-2 border border-[#3a3e34] px-4 py-2.5 text-sm text-[#aeb3a2] outline-none transition-colors hover:border-[#ff8067] hover:text-[#ff9a85] focus-visible:ring-2 focus-visible:ring-[#d7ff5f]"
              onClick={onReset}
              role="button"
              type="button"
            >
              <RotateCcw aria-hidden="true" size={15} />
              Reset defaults
            </button>
            <button
              aria-label="Save pricing and close settings"
              className="bg-[#d7ff5f] px-5 py-2.5 text-sm font-bold text-[#172000] outline-none transition-colors hover:bg-[#e3ff87] focus-visible:ring-2 focus-visible:ring-white"
              onClick={onClose}
              role="button"
              type="button"
            >
              Done
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
