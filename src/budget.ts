import type { UsageState } from "@earendil-works/pi-durable";

/** A task policy over Pi's usage ledger, not a separate accounting system. */
export function taskUsage(usage: UsageState) {
  const values = [...Object.values(usage.models), ...Object.values(usage.tools)];
  return {
    totalTokens: values.reduce((n, v) => n + (v.totalTokens ?? 0), 0),
    cachedTokens: values.reduce((n, v) => n + (v.cacheRead ?? 0), 0),
    cacheWriteTokens: values.reduce((n, v) => n + (v.cacheWrite ?? 0), 0),
    inputTokens: values.reduce((n, v) => n + (v.input ?? 0), 0),
    outputTokens: values.reduce((n, v) => n + (v.output ?? 0), 0),
    estimatedCostUsd: values.reduce((n, v) => n + (v.cost?.total ?? 0), 0),
  };
}
