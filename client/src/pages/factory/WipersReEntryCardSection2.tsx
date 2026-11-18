// Extracted from ./WipersReEntry.tsx to keep that module under the source-size cap.
import { AlertTriangle, CalendarDays, CheckSquare, ChevronDown, ChevronUp, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatLabelNum } from "@/lib/labelHtml";
import { useWipersReEntryState } from "./useWipersReEntryState";

export function WipersReEntryCardSection2({
  balesLoading,
  cleanupMutation,
  cleanupOpen,
  cleanupSelectedIds,
  cleanupTotalKg,
  currentWipersBales,
  setCleanupOpen,
  setSupervisorPassword,
  setSupervisorUsername,
  supervisorPassword,
  supervisorUsername,
  toggleCleanupSelect,
  toggleSelectAll,
}: Pick<
  ReturnType<typeof useWipersReEntryState>,
  | "balesLoading"
  | "cleanupMutation"
  | "cleanupOpen"
  | "cleanupSelectedIds"
  | "cleanupTotalKg"
  | "currentWipersBales"
  | "setCleanupOpen"
  | "setSupervisorPassword"
  | "setSupervisorUsername"
  | "supervisorPassword"
  | "supervisorUsername"
  | "toggleCleanupSelect"
  | "toggleSelectAll"
>) {
  return (
    <Card>
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setCleanupOpen((o) => !o)}>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Current Wipers Stock Cleanup
            {currentWipersBales.length > 0 && <Badge variant="secondary">{currentWipersBales.length} bales</Badge>}
          </span>
          {cleanupOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </CardTitle>
      </CardHeader>
      {cleanupOpen && (
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Use this panel to remove current wipers / garbage bales before re-entering with the new date. Supervisor
            credentials are required.
          </p>
          {balesLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : currentWipersBales.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-sm">
              No wipers / garbage bales currently in stock
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex gap-3">
                  <span>{currentWipersBales.length} bales</span>
                  <span>{formatLabelNum(cleanupTotalKg)} kg total</span>
                </div>
                <Button variant="ghost" size="sm" onClick={toggleSelectAll} data-testid="button-select-all-cleanup">
                  {cleanupSelectedIds.size === currentWipersBales.length ? (
                    <>
                      <CheckSquare className="h-4 w-4 mr-1" />
                      Deselect All
                    </>
                  ) : (
                    <>
                      <Square className="h-4 w-4 mr-1" />
                      Select All
                    </>
                  )}
                </Button>
              </div>
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentWipersBales.map((bale) => (
                      <TableRow
                        key={bale.id}
                        className="cursor-pointer"
                        onClick={() => toggleCleanupSelect(bale.id)}
                        data-testid={`row-cleanup-bale-${bale.id}`}
                      >
                        <TableCell>
                          <div className="flex items-center justify-center">
                            {cleanupSelectedIds.has(bale.id) ? (
                              <CheckSquare className="h-4 w-4 text-primary" />
                            ) : (
                              <Square className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm">{bale.referenceNumber}</TableCell>
                        <TableCell className="text-sm">{bale.productName || bale.category || "-"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {(bale.status || "-").replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatLabelNum(parseFloat(bale.weightKg || "0"))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {cleanupSelectedIds.size > 0 && (
                <div className="border rounded-md p-4 space-y-3 bg-destructive/5">
                  <p className="text-sm font-medium text-destructive flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    Removing {cleanupSelectedIds.size} bale{cleanupSelectedIds.size !== 1 ? "s" : ""} — supervisor
                    authorization required
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="sup-user">Supervisor Username</Label>
                      <Input
                        id="sup-user"
                        value={supervisorUsername}
                        onChange={(e) => setSupervisorUsername(e.target.value)}
                        placeholder="Username"
                        data-testid="input-supervisor-username"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sup-pass">Supervisor Password</Label>
                      <Input
                        id="sup-pass"
                        type="password"
                        value={supervisorPassword}
                        onChange={(e) => setSupervisorPassword(e.target.value)}
                        placeholder="Password"
                        data-testid="input-supervisor-password"
                      />
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    disabled={!supervisorUsername || !supervisorPassword || cleanupMutation.isPending}
                    onClick={() => cleanupMutation.mutate()}
                    data-testid="button-remove-selected"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {cleanupMutation.isPending
                      ? "Removing..."
                      : `Remove ${cleanupSelectedIds.size} Bale${cleanupSelectedIds.size !== 1 ? "s" : ""}`}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function WipersReEntryCardSection3({
  activeLocations,
  entryDate,
  selectedLocationId,
  setCart,
  setEntryDate,
  setSelectedLocationId,
  workers,
}: Pick<
  ReturnType<typeof useWipersReEntryState>,
  | "activeLocations"
  | "entryDate"
  | "selectedLocationId"
  | "setCart"
  | "setEntryDate"
  | "setSelectedLocationId"
  | "workers"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          Entry Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1">
          <Label htmlFor="entry-date">
            Entry Date <span className="text-destructive">*</span>
          </Label>
          <Input
            id="entry-date"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            data-testid="input-entry-date"
          />
          <p className="text-xs text-muted-foreground">Bales will be recorded under this date</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="location">
            Warehouse Location <span className="text-destructive">*</span>
          </Label>
          <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
            <SelectTrigger id="location" data-testid="select-location">
              <SelectValue placeholder="Select location..." />
            </SelectTrigger>
            <SelectContent>
              {activeLocations.map((l) => (
                <SelectItem key={l.id} value={l.id.toString()} data-testid={`option-location-${l.id}`}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Default Worker (optional)</Label>
          <Select
            value=""
            onValueChange={(workerId) => {
              const id = workerId === "none" ? null : parseInt(workerId);
              setCart((prev) => prev.map((i) => ({ ...i, finalizedBy: id })));
            }}
          >
            <SelectTrigger data-testid="select-default-worker">
              <SelectValue placeholder="Apply worker to all rows..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {workers.map((w) => (
                <SelectItem key={w.id} value={w.id.toString()}>
                  {w.fullName || w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
