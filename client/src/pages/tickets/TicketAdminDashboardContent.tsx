// Extracted from ./TicketAdminDashboard.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { initial } from "./TicketAdminDashboardHelpers";
import { useTicketAdminDashboardState } from "./useTicketAdminDashboardState";

export function TicketAdminDashboardContent({
  employees,
  filters,
  set,
  setApplied,
  setFilters,
  submit,
}: Pick<
  ReturnType<typeof useTicketAdminDashboardState>,
  "employees" | "filters" | "set" | "setApplied" | "setFilters" | "submit"
>) {
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-3 sm:p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-sm">
          Created from (UTC)
          <Input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          Created through (UTC)
          <Input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          Status
          <Select value={filters.status || "__all__"} onValueChange={(v) => set("status", v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-10 w-full px-2" aria-label="Status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              {["open", "seen", "working", "finalized", "reopened"].map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          Priority
          <Select
            value={filters.priority || "__all__"}
            onValueChange={(v) => set("priority", v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="h-10 w-full px-2" aria-label="Priority">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All priorities</SelectItem>
              {["low", "normal", "high", "urgent"].map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          Source
          <Select
            value={filters.sourceMode || "__all__"}
            onValueChange={(v) => set("sourceMode", v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="h-10 w-full px-2" aria-label="Source">
              <SelectValue placeholder="ERP + Factory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">ERP + Factory</SelectItem>
              <SelectItem value="erp">ERP</SelectItem>
              <SelectItem value="factory">Factory</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          Issue category
          <Input
            maxLength={80}
            value={filters.category}
            onChange={(e) => set("category", e.target.value)}
            placeholder="Exact category"
          />
        </label>
        <label className="space-y-1 text-sm">
          Assigned employee
          <Select
            value={filters.assignedTo || "__all__"}
            onValueChange={(v) => set("assignedTo", v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="h-10 w-full px-2" aria-label="Assigned employee">
              <SelectValue placeholder="All employees" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All employees</SelectItem>
              {employees.data?.users.map((user) => (
                <SelectItem key={user.id} value={String(user.id)}>
                  {user.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setFilters(initial);
            setApplied(initial);
          }}
        >
          Clear
        </Button>
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}
