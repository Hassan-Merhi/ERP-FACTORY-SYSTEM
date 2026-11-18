// Extracted from ./ProductionBonusesPanel.tsx to keep that module under the source-size cap.
import { CheckCheck, Filter, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchField } from "@/components/ui/search-field";
import { money, rowKey } from "./ProductionBonusesPanelTypes";
import { useProductionBonusesPanelState } from "./useProductionBonusesPanelState";

export function ProductionBonusesPanelSection({
  end,
  filter,
  search,
  setEnd,
  setFilter,
  setSearch,
  setSelected,
  setStart,
  start,
}: Pick<
  ReturnType<typeof useProductionBonusesPanelState>,
  "end" | "filter" | "search" | "setEnd" | "setFilter" | "setSearch" | "setSelected" | "setStart" | "start"
>) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-xs text-muted-foreground">
        From
        <Input
          aria-label="Production bonus from"
          type="date"
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
            setSelected([]);
          }}
          className="w-[155px]"
        />
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        To
        <Input
          aria-label="Production bonus to"
          type="date"
          value={end}
          onChange={(event) => {
            setEnd(event.target.value);
            setSelected([]);
          }}
          className="w-[155px]"
        />
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Filter className="h-3.5 w-3.5" /> Review status
        </span>
        <Select
          value={filter}
          onValueChange={(value) => {
            setFilter(value as typeof filter);
            setSelected([]);
          }}
        >
          <SelectTrigger className="w-[156px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="eligible">Needs review</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <SearchField
        aria-label="Search bonus worker"
        value={search}
        placeholder="Worker, category or date"
        onValueChange={setSearch}
        wrapperClassName="min-w-[170px] flex-1"
      />
    </div>
  );
}

export function ProductionBonusesPanelSection2({
  allVisibleSelected,
  canApproveSelected,
  eligible,
  reviewMutation,
  selected,
  selectedAmount,
  selectedRows,
  setConfirmDecision,
  setSelected,
}: Pick<
  ReturnType<typeof useProductionBonusesPanelState>,
  | "allVisibleSelected"
  | "canApproveSelected"
  | "eligible"
  | "reviewMutation"
  | "selected"
  | "selectedAmount"
  | "selectedRows"
  | "setConfirmDecision"
  | "setSelected"
>) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b pb-3">
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          setSelected(
            allVisibleSelected
              ? selected.filter((key) => !eligible.some((row) => rowKey(row) === key))
              : Array.from(new Set([...selected, ...eligible.map(rowKey)]))
          )
        }
        disabled={eligible.length === 0}
      >
        {allVisibleSelected ? "Unselect visible" : "Select all needing review"}
      </Button>
      <span className="mr-auto text-xs text-muted-foreground">
        {selectedRows.length} selected · {money(selectedAmount)} proposed
      </span>
      <Button
        size="sm"
        disabled={!canApproveSelected || reviewMutation.isPending}
        onClick={() => setConfirmDecision("approved")}
      >
        <CheckCheck className="mr-1.5 h-4 w-4" /> Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={selectedRows.length === 0 || reviewMutation.isPending}
        onClick={() => setConfirmDecision("rejected")}
      >
        <XCircle className="mr-1.5 h-4 w-4" /> Reject
      </Button>
    </div>
  );
}
