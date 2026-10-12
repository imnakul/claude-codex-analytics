import type { CostEstimate } from "@/lib/pricing";
import type { ThreadAnalytics, ThreadTurnAnalytics } from "@/lib/analytics-types";

export interface PricedThread {
  cost: CostEstimate | null;
  thread: ThreadAnalytics;
}

export interface PricedTurn {
  cost: CostEstimate | null;
  turn: ThreadTurnAnalytics;
}

export interface ModelAggregate {
  averageCost: number | null;
  averageDurationMs: number | null;
  averageTokens: number;
  key: string;
  label: string;
  pricedThreads: number;
  sampleCount: number;
  totalCost: number;
}
