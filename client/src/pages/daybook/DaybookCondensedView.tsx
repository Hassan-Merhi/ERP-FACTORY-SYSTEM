// Extracted from ./DaybookTable.tsx: the condensed (grouped by date and voucher type) Daybook view.
import { ErpListTable } from "@/erp-core";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import { parseISO } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getVoucherTypeBadge } from "@/lib/voucherTypeBadge";
import { DaybookRow, Voucher } from "./types";
import type { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import type { DaybookTableProps } from "./daybookTableProps";

export function renderDaybookCondensedView({
  visibleRows,
  offloadAlphabetical,
  setExpandedCondensedGroups,
  daybookDesktopWindow,
  hideAmounts,
  expandedCondensedGroups,
  formatDisplayDate,
  formatAmount,
  navigate,
  accountNameCache,
  handleView,
}: {
  visibleRows: DaybookTableProps["visibleRows"];
  offloadAlphabetical: Exclude<DaybookTableProps["offloadAlphabetical"], undefined>;
  setExpandedCondensedGroups: DaybookTableProps["setExpandedCondensedGroups"];
  daybookDesktopWindow: ReturnType<typeof useBoundedTableRows>;
  hideAmounts: DaybookTableProps["hideAmounts"];
  expandedCondensedGroups: DaybookTableProps["expandedCondensedGroups"];
  formatDisplayDate: DaybookTableProps["formatDisplayDate"];
  formatAmount: DaybookTableProps["formatAmount"];
  navigate: DaybookTableProps["navigate"];
  accountNameCache: DaybookTableProps["accountNameCache"];
  handleView: DaybookTableProps["handleView"];
}) {
  // Build date → type → rows structure (preserving date order from visibleRows)
  const dateOrder: string[] = [];
  const dateGroups: Record<
    string,
    {
      total: number;
      types: Record<string, { total: number; rows: DaybookRow[] }>;
    }
  > = {};

  for (const row of visibleRows) {
    const date = offloadAlphabetical
      ? "all-offloads"
      : row._type === "voucher"
        ? row.data.voucherDate
        : row.data.offloadedAt.slice(0, 10);
    const type = row._type === "voucher" ? row.data.voucherType : "Offload";
    const amt =
      row._type === "voucher"
        ? parseFloat(String(row.data.totalAmount || "0"))
        : parseFloat(String(row.data.itemsTotal || "0"));

    if (!dateGroups[date]) {
      dateGroups[date] = { total: 0, types: {} };
      dateOrder.push(date);
    }
    dateGroups[date].total += amt;

    if (!dateGroups[date].types[type]) dateGroups[date].types[type] = { total: 0, rows: [] };
    dateGroups[date].types[type].total += amt;
    dateGroups[date].types[type].rows.push(row);
  }

  const toggle = (key: string) =>
    setExpandedCondensedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    // build/vitePhase1PaginationPlugin.ts matches this opening tag on one line.
    // prettier-ignore
    <ErpListTable pageKey="daybook-condensed" scrollLabel="Condensed daybook" scrollRef={daybookDesktopWindow.scrollRef} wrapperClassName="max-h-[calc(100dvh-220px)]">
        <TableHeader className="sticky top-0 z-20 bg-muted [&_th]:bg-muted [&_th]:text-foreground/90">
          <TableRow>
            <TableHead className="sticky left-0 bg-muted z-10 pl-4">
              {offloadAlphabetical ? "Offloaded containers" : "Date / Type"}
            </TableHead>
            <TableHead className="text-right">Count</TableHead>
            {!hideAmounts && <TableHead className="text-right">Total</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody className="text-foreground dark:[&_tr]:border-border/70 dark:[&_td]:border-border/70">
          {dateOrder.map((date) => {
            const dg = dateGroups[date];
            const dateKey = `date-${date}`;
            const isDateExpanded = expandedCondensedGroups.has(dateKey);
            const totalCount = Object.values(dg.types).reduce((s, t) => s + t.rows.length, 0);

            return (
              <div key={dateKey} style={{ display: "contents" }}>
                {/* Date header row */}
                <TableRow
                  className="cursor-pointer bg-muted/30 hover:bg-muted/50 font-semibold"
                  onClick={() => toggle(dateKey)}
                >
                  <TableCell className="sticky left-0 bg-inherit z-10 pl-4">
                    <div className="flex items-center gap-2">
                      {isDateExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm font-semibold">
                        {offloadAlphabetical ? "All dates · A–Z" : formatDisplayDate(parseISO(date))}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono text-muted-foreground">{totalCount}</TableCell>
                  {!hideAmounts && (
                    <TableCell className="text-right font-mono font-semibold">{formatAmount(dg.total)}</TableCell>
                  )}
                </TableRow>

                {/* Type rows within date */}
                {isDateExpanded &&
                  Object.entries(dg.types).map(([type, tg]) => {
                    const typeKey = `${dateKey}-type-${type}`;
                    const isTypeExpanded = expandedCondensedGroups.has(typeKey);
                    const badge =
                      type === "Offload"
                        ? { className: "bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30" }
                        : getVoucherTypeBadge(type);

                    return (
                      <div key={typeKey} style={{ display: "contents" }}>
                        <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => toggle(typeKey)}>
                          <TableCell className="sticky left-0 bg-inherit z-10 pl-10">
                            <div className="flex items-center gap-2">
                              {isTypeExpanded ? (
                                <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                              ) : (
                                <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                              )}
                              <Badge {...badge}>{type}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm font-mono text-muted-foreground">
                            {tg.rows.length}
                          </TableCell>
                          {!hideAmounts && (
                            <TableCell className="text-right font-mono font-medium">{formatAmount(tg.total)}</TableCell>
                          )}
                        </TableRow>

                        {/* Individual voucher rows */}
                        {isTypeExpanded &&
                          tg.rows.map((row) => {
                            if (row._type === "offload") {
                              const o = row.data;
                              const desc = [
                                o.containerNumber,
                                ...(offloadAlphabetical
                                  ? [formatDisplayDate(parseISO(o.offloadedAt.slice(0, 10)))]
                                  : []),
                                o.locationName,
                              ]
                                .filter(Boolean)
                                .join(" — ");
                              return (
                                <TableRow key={`${typeKey}-offload-${o.id}`} className="bg-muted/20">
                                  <TableCell className="sticky left-0 bg-inherit z-10 pl-16 max-w-0 w-full overflow-hidden">
                                    <div className="truncate text-sm" title={desc || "—"}>
                                      {desc || "—"}
                                    </div>
                                  </TableCell>
                                  <TableCell />
                                  {!hideAmounts && (
                                    <TableCell className="text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <span className="text-sm font-mono">{formatAmount(Number(o.itemsTotal))}</span>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            navigate(`/offloads/${o.id}`);
                                          }}
                                          title="View"
                                        >
                                          <Eye className="w-3 h-3" />
                                        </Button>
                                      </div>
                                    </TableCell>
                                  )}
                                </TableRow>
                              );
                            } else {
                              const voucher = row.data as Voucher;
                              const vDesc =
                                voucher.description ||
                                (["Payment", "Receipt", "Journal"].includes(voucher.voucherType) &&
                                accountNameCache[voucher.id]
                                  ? accountNameCache[voucher.id]
                                  : null);
                              return (
                                <TableRow key={`${typeKey}-v-${voucher.id}`} className="bg-muted/20">
                                  <TableCell className="sticky left-0 bg-inherit z-10 pl-16 max-w-0 w-full overflow-hidden">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="truncate text-sm" title={vDesc || voucher.voucherNumber}>
                                        {vDesc || voucher.voucherNumber}
                                      </div>
                                      {voucher.optional && (
                                        <Badge
                                          variant="outline"
                                          className="text-xs text-muted-foreground shrink-0"
                                          data-testid={`badge-optional-condensed-${voucher.id}`}
                                        >
                                          Optional
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell />
                                  {!hideAmounts && (
                                    <TableCell className="text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <span className="text-sm font-mono">{formatAmount(voucher.totalAmount)}</span>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleView(voucher);
                                          }}
                                          title="View"
                                        >
                                          <Eye className="w-3 h-3" />
                                        </Button>
                                      </div>
                                    </TableCell>
                                  )}
                                </TableRow>
                              );
                            }
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </TableBody>
      </ErpListTable>
  );
}
