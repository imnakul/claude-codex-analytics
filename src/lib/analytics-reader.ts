import "server-only";

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { analyticsSnapshotSchema, type AnalyticsProvider, type AnalyticsSnapshot } from "@/lib/analytics-types";
import { getAnalyticsSnapshot } from "@/lib/codex-reader";
import { getClaudeAnalyticsSnapshot } from "@/lib/claude-reader";

export function readAnalytics(provider: AnalyticsProvider): AnalyticsSnapshot {
  return provider === "claude" ? getClaudeAnalyticsSnapshot() : getAnalyticsSnapshot();
}

// Keep the provider switch reachable when this machine only has Claude data.
export function initialAnalytics(provider: AnalyticsProvider): AnalyticsSnapshot {
  try {
    return readAnalytics(provider);
  } catch {
    const dataHome = resolve(/* turbopackIgnore: true */ provider === "claude"
      ? process.env.CLAUDE_CONFIG_DIR || join(/* turbopackIgnore: true */ homedir(), ".claude")
      : process.env.CODEX_HOME || join(/* turbopackIgnore: true */ homedir(), ".codex"));
    return analyticsSnapshotSchema.parse({
      provider, dataHome, codexHome: provider === "codex" ? dataHome : "",
      databasePath: dataHome, generatedAt: new Date().toISOString(), threads: [],
      warnings: [`Unable to read local ${provider === "claude" ? "Claude" : "Codex"} data. Check the configured data directory, then refresh, or switch providers above.`],
    });
  }
}
