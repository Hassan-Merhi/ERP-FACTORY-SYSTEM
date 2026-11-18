// Extracted from ./FactoryWorkersRosterPanel.tsx to keep that module under the source-size cap.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFactoryWorkersRosterPanelState } from "./useFactoryWorkersRosterPanelState";

export function FactoryWorkersRosterPanelSection({
  advanceFilter,
  locationFilter,
  nationalityFilter,
  positionFilter,
  salaryRangeFilter,
  salaryTypeFilter,
  setAdvanceFilter,
  setLocationFilter,
  setNationalityFilter,
  setPositionFilter,
  setSalaryRangeFilter,
  setSalaryTypeFilter,
  setTransportFilter,
  transportFilter,
  uniqueLocations,
  uniqueNationalities,
  uniquePositions,
  uniqueSalaryTypes,
}: Pick<
  ReturnType<typeof useFactoryWorkersRosterPanelState>,
  | "advanceFilter"
  | "locationFilter"
  | "nationalityFilter"
  | "positionFilter"
  | "salaryRangeFilter"
  | "salaryTypeFilter"
  | "setAdvanceFilter"
  | "setLocationFilter"
  | "setNationalityFilter"
  | "setPositionFilter"
  | "setSalaryRangeFilter"
  | "setSalaryTypeFilter"
  | "setTransportFilter"
  | "transportFilter"
  | "uniqueLocations"
  | "uniqueNationalities"
  | "uniquePositions"
  | "uniqueSalaryTypes"
>) {
  return (
    <div className="rounded-xl border bg-muted/30 p-4 flex flex-wrap gap-4">
      {/* Position */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Position</label>
        <Select value={positionFilter} onValueChange={setPositionFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All positions</SelectItem>
            {uniquePositions.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Location */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Location</label>
        <Select value={locationFilter} onValueChange={setLocationFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {uniqueLocations.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Salary type */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Salary Type</label>
        <Select value={salaryTypeFilter} onValueChange={setSalaryTypeFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {uniqueSalaryTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Nationality */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Nationality</label>
        <Select value={nationalityFilter} onValueChange={setNationalityFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All nationalities</SelectItem>
            {uniqueNationalities.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Salary range */}
      <div className="flex flex-col gap-1 min-w-[160px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Salary Range</label>
        <Select value={salaryRangeFilter} onValueChange={setSalaryRangeFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ranges</SelectItem>
            <SelectItem value="0-500">Under $500</SelectItem>
            <SelectItem value="500-1000">$500 – under $1,000</SelectItem>
            <SelectItem value="1000-2000">$1,000 – under $2,000</SelectItem>
            <SelectItem value="2000-5000">$2,000 – under $5,000</SelectItem>
            <SelectItem value="5000+">$5,000 and above</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Transport */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Transport</label>
        <Select value={transportFilter} onValueChange={setTransportFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="has">Has transport allowance</SelectItem>
            <SelectItem value="none">No transport allowance</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Advance status */}
      <div className="flex flex-col gap-1 min-w-[150px]">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Advance</label>
        <Select value={advanceFilter} onValueChange={setAdvanceFilter}>
          <SelectTrigger className="h-8 text-sm bg-background">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="has">Has outstanding advance</SelectItem>
            <SelectItem value="none">No advance</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
