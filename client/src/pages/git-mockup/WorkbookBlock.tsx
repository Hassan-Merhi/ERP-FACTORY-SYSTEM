import { Fragment } from "react";
import { CheckCircle2, XCircle, Building2, Layers3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtD, parseNum, getRealRowBg, groupBySupplier } from "./helpers";
import type { EnrichedContainerApi } from "./types";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

export function WorkbookLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground shadow-sm">
      <span className="mr-1 font-semibold text-foreground/80">Row status</span>
      <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-yellow-400 bg-yellow-300" /> Upcoming ETA, docs
        pending
      </span>
      <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-rose-400 bg-rose-400" /> At port, docs missing
      </span>
      <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-amber-400 bg-amber-300" /> Docs ready, not sent
        to truck
      </span>
      <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-red-500 bg-red-400" /> Offload overdue
      </span>
      <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-orange-500 bg-orange-400" /> Delayed
      </span>
    </div>
  );
}

const WORKBOOK_COLS = 14;

function WorkbookDataRow({ r }: { r: EnrichedContainerApi }) {
  return (
    <tr className={cn("border-b border-border/40 transition-colors last:border-b-0 hover:bg-violet-500/10", getRealRowBg(r))}>
      <td className="py-0.5 px-2 font-mono font-bold">{r.containerNumber}</td>
      <td className="py-0.5 px-2">{r.supplierCode ?? "—"}</td>
      <td className="py-0.5 px-2 text-right font-semibold">${fmt(parseNum(r.grandTotal), 2)}</td>
      <td className="py-0.5 px-2">{fmtD(r.eta)}</td>
      <td className="py-0.5 px-2 font-mono">{r.numberPlate ?? "—"}</td>
      <td className="py-0.5 px-2">{r.trackingLocation ?? "—"}</td>
      <td className="py-0.5 px-2">{fmtD(r.borderDate)}</td>
      <td className={cn("py-0.5 px-2", r.isOverdue ? "text-red-600 font-bold" : "")}>
        {fmtD(r.maxOffloadDate)}
        {r.daysDelayed ? <span className="ml-1 text-[11px]">+{r.daysDelayed}d</span> : null}
      </td>
      <td className="py-0.5 px-2 text-center">
        {r.docReceived ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" />
        )}
      </td>
      <td className="py-0.5 px-2">{r.transporter ?? "—"}</td>
      <td className="py-0.5 px-2 text-right">
        {parseNum(r.transportFee) > 0 ? `$${fmt(parseNum(r.transportFee), 0)}` : "—"}
      </td>
      <td className="py-0.5 px-2">{r.agent ?? "—"}</td>
      <td className="py-0.5 px-2 text-right">{parseNum(r.dutyFee) > 0 ? `$${fmt(parseNum(r.dutyFee), 0)}` : "—"}</td>
      <td className="py-0.5 px-2 max-w-40 truncate text-muted-foreground italic">{r.trackingDescription ?? "—"}</td>
    </tr>
  );
}

/** Workbook grid; on ERP phones each container row reads as a card. */
function WorkbookTable({ children }: { children: React.ReactNode }) {
  const { tableProps } = useMobileCardTable();
  return (
    <table {...tableProps} className="w-full border-collapse whitespace-nowrap text-xs [&_th]:sticky [&_th]:top-0 [&_th]:z-10">
      {children}
    </table>
  );
}

function SupplierGroupedRows({ rows }: { rows: EnrichedContainerApi[] }) {
  const groups = groupBySupplier(rows);
  if (groups.length <= 1)
    return (
      <>
        {rows.map((r) => (
          <WorkbookDataRow key={r.id} r={r} />
        ))}
      </>
    );
  return (
    <>
      {groups.map(({ name, rows: sRows }) => (
        <Fragment key={`sup-${name}`}>
          <tr className="border-t border-violet-200/50 bg-violet-50/70 dark:border-violet-500/20 dark:bg-violet-400/10">
            <td
              colSpan={WORKBOOK_COLS}
              className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-violet-800 dark:text-violet-200"
            >
              {name} — {sRows.length}
            </td>
          </tr>
          {sRows.map((r) => (
            <WorkbookDataRow key={r.id} r={r} />
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function RealWorkbookBlock({
  companyName,
  rows,
  headerBg,
  headerText,
}: {
  companyName: string;
  rows: EnrichedContainerApi[];
  headerBg: string;
  headerText: string;
}) {
  const total = {
    amount: rows.reduce((s, r) => s + parseNum(r.grandTotal), 0),
    fee: rows.reduce((s, r) => s + parseNum(r.transportFee), 0),
    duty: rows.reduce((s, r) => s + parseNum(r.dutyFee), 0),
  };

  const shopGroups: Array<{ name: string; rows: EnrichedContainerApi[] }> = [];
  for (const r of rows) {
    const key = r.shopName ?? companyName;
    const existing = shopGroups.find((g) => g.name === key);
    if (existing) existing.rows.push(r);
    else shopGroups.push({ name: key, rows: [r] });
  }
  shopGroups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const hasShops = shopGroups.length > 1;

  const columnHeaders = (
    <tr className="border-b border-border/70 bg-muted/75 text-muted-foreground">
      <th className="py-1 px-2 font-semibold text-center">CTR #</th>
      <th className="py-1 px-2 font-semibold text-center">SUPPLIER</th>
      <th className="py-1 px-2 font-semibold text-center">AMOUNT</th>
      <th className="py-1 px-2 font-semibold text-center">ETA</th>
      <th className="py-1 px-2 font-semibold text-center">TRUCK #</th>
      <th className="py-1 px-2 font-semibold text-center">LOCATION</th>
      <th className="py-1 px-2 font-semibold text-center">BORDER DT.</th>
      <th className="py-1 px-2 font-semibold text-center">MAX OFFLOAD</th>
      <th className="py-1 px-2 font-semibold text-center">DOCS RCVD</th>
      <th className="py-1 px-2 font-semibold text-center">TRANSPORTER</th>
      <th className="py-1 px-2 font-semibold text-center">FEE</th>
      <th className="py-1 px-2 font-semibold text-center">AGENT</th>
      <th className="py-1 px-2 font-semibold text-center">DUTY</th>
      <th className="py-1 px-2 font-semibold text-center">NOTES</th>
    </tr>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-sm dark:shadow-black/20">
      <div className={cn("flex flex-wrap items-center justify-between gap-2 px-4 py-3 shadow-sm", headerBg, headerText)}>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 opacity-80" aria-hidden="true" />
          <span className="text-sm font-bold tracking-wide">{companyName}</span>
        </div>
        <span className="rounded-full bg-black/10 px-3 py-1 text-xs font-bold tabular-nums dark:bg-white/10">
          {rows.length} containers — ${fmt(total.amount, 2)}
        </span>
      </div>

      {hasShops ? (
        <div className="divide-y divide-border/60">
          {shopGroups.map(({ name, rows: shopRows }) => {
            const st = {
              amount: shopRows.reduce((s, r) => s + parseNum(r.grandTotal), 0),
              fee: shopRows.reduce((s, r) => s + parseNum(r.transportFee), 0),
              duty: shopRows.reduce((s, r) => s + parseNum(r.dutyFee), 0),
            };
            return (
              <div key={name}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-200/75 bg-violet-50 px-4 py-2.5 dark:border-violet-500/25 dark:bg-violet-500/15">
                  <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-violet-900 dark:text-violet-200">
                    <Layers3 className="h-3.5 w-3.5" aria-hidden="true" />
                    {name}
                  </span>
                  <span className="rounded-full border border-violet-200/70 bg-background/60 px-2.5 py-1 text-xs font-semibold tabular-nums text-violet-800 dark:border-violet-400/20 dark:text-violet-200">
                    {shopRows.length} container{shopRows.length !== 1 ? "s" : ""} — ${fmt(st.amount, 2)}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <WorkbookTable>
                    <thead>{columnHeaders}</thead>
                    <tbody>
                      <SupplierGroupedRows rows={shopRows} />
                      <tr className="border-t border-violet-200 bg-violet-50/70 text-xs font-semibold text-violet-900 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-200">
                        <td className="py-1 px-2">SUB-TOTAL — {shopRows.length} CTR</td>
                        <td />
                        <td className="py-1 px-2 text-right">${fmt(st.amount, 2)}</td>
                        <td colSpan={7} />
                        <td className="py-1 px-2 text-right">{st.fee > 0 ? `$${fmt(st.fee, 0)}` : "—"}</td>
                        <td />
                        <td className="py-1 px-2 text-right">{st.duty > 0 ? `$${fmt(st.duty, 0)}` : "—"}</td>
                        <td colSpan={1} />
                      </tr>
                    </tbody>
                  </WorkbookTable>
                </div>
              </div>
            );
          })}
          <div className={cn("flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs font-bold", headerBg, headerText)}>
            <span>TOTAL — {rows.length} CTR</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>${fmt(total.amount, 2)}</span>
              {total.fee > 0 && <span>TRANSPORT: ${fmt(total.fee, 0)}</span>}
              {total.duty > 0 && <span>DUTY: ${fmt(total.duty, 0)}</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <WorkbookTable>
            <thead>{columnHeaders}</thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={WORKBOOK_COLS} className="py-3 text-center text-muted-foreground italic text-xs">
                    No containers
                  </td>
                </tr>
              ) : (
                <SupplierGroupedRows rows={rows} />
              )}
              {rows.length > 0 && (
                <tr className={cn("border-t-2 text-xs font-bold", headerBg, headerText)}>
                  <td className="py-1 px-2">TOTAL — {rows.length} CTR</td>
                  <td />
                  <td className="py-1 px-2 text-right">${fmt(total.amount, 2)}</td>
                  <td colSpan={7} />
                  <td className="py-1 px-2 text-right">{total.fee > 0 ? `$${fmt(total.fee, 0)}` : "—"}</td>
                  <td />
                  <td className="py-1 px-2 text-right">{total.duty > 0 ? `$${fmt(total.duty, 0)}` : "—"}</td>
                  <td colSpan={1} />
                </tr>
              )}
            </tbody>
          </WorkbookTable>
        </div>
      )}
    </div>
  );
}
