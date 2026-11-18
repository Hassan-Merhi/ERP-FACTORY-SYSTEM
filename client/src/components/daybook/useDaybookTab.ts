import { useHubQueryState } from "@/hooks/use-hub-query-state";

export type DaybookTab = "transactions" | "activity";

export const DAYBOOK_TABS: readonly DaybookTab[] = ["transactions", "activity"];

/**
 * The open Daybook tab, kept in `?tab=` so links, Back and reloads reopen it.
 * A link without `?tab` opens the first visible tab and the URL stays clean.
 * While the caller's permissions load (`ready` false) a deep-linked tab is kept
 * instead of being stripped.
 */
export function useDaybookTab(visibleTabs: readonly DaybookTab[] = DAYBOOK_TABS, ready = true) {
  return useHubQueryState<DaybookTab>({
    key: "tab",
    allowedValues: ready ? visibleTabs : DAYBOOK_TABS,
    knownValues: DAYBOOK_TABS,
    defaultValue: visibleTabs[0] ?? "transactions",
    omitDefault: true,
  });
}
