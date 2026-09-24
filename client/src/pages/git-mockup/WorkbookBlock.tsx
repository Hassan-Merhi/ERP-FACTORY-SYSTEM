import { Fragment } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtD, parseNum, getRealRowBg, groupBySupplier } from "./helpers";
import type { EnrichedContainerApi } from "./types";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

export function WorkbookLegend() {
  return (
    <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground px-1">
      <span className="font-medium">Row colour:</span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm bg-yellow-200 border border-yellow-400" /> Upcoming ETA, docs
        pending
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm bg-rose-200 border border-rose-400" /> At port, docs missing
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-300" /> Docs ready, not sent
        to truck
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-3 h-3 rounded-sm bg-red-200 border border-red-400" /> Offload overdue
      </span>
    </div>
  );
}

const WORKBOOK_COLS = 14;

function WorkbookDataRow({ r }: { r: EnrichedContainerApi }) {
  return (
    <tr className={cn("border-b last:border-b-0", getRealRowBg(r))}>
      <td className="py-0.5 px-2 font-mono font-bold">{r.containerNumber}</td>
      <td className="py-0.5 px-2">{r.supplierCode ?? "—"}</td>
      <td className="py-0.5 px-2 text-right font-semibold">${fmt(parseNum(r.grandTotal), 2)}</td>
      <td className="py-0.5 px-2">{fmtD(r.eta)}</td>
      <td className="py-0.5 px-2 font-mono">{r.numberPlate ?? "—"}</td>
      <td className="py-0.5 px-2">{r.trackingLocation ?? "—"}</td>
      <td className="py-0.5 px-2">{fmtD(r.borderDate)}</td>
      <td className={cn("py-0.5 px-2", r.isOverdue ? "text-red-600 font-bold" : "")}>
        {fmtD(r.maxOffloadDate)}
        {r.daysDelayed ? <span className="ml-1 text-[10px]">+{r.daysDelayed}d</span> : null}
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
    <table {...tableProps} className="w-full text-xs whitespace-nowrap border-collapse">
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
          <tr className="bg-muted/40 border-t border-border">
            <td
              colSpan={WORKBOOK_COLS}
              className="py-0.5 px-2 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground"
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
    <tr className="bg-muted/60 border-b text-muted-foreground">
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
    <div className="rounded-md border overflow-hidden">
      <div className={cn("flex items-center justify-center gap-3 px-3 py-1.5", headerBg, headerText)}>
        <span className="text-sm font-bold tracking-wide">{companyName}</span>
        <span className="text-xs font-semibold opacity-90">
          {rows.length} containers — ${fmt(total.amount, 2)}
        </span>
      </div>

      {hasShops ? (
        <div className="divide-y">
          {shopGroups.map(({ name, rows: shopRows }) => {
            const st = {
              amount: shopRows.reduce((s, r) => s + parseNum(r.grandTotal), 0),
              fee: shopRows.reduce((s, r) => s + parseNum(r.transportFee), 0),
              duty: shopRows.reduce((s, r) => s + parseNum(r.dutyFee), 0),
            };
            return (
              <div key={name}>
                <div className="flex items-center justify-center gap-3 px-3 py-1 bg-yellow-100 dark:bg-yellow-900/30 border-b border-yellow-300 dark:border-yellow-700">
                  <span className="text-xs font-bold uppercase tracking-wide text-yellow-900 dark:text-yellow-300">
                    {name}
                  </span>
                  <span className="text-xs text-yellow-800 dark:text-yellow-400">
                    {shopRows.length} container{shopRows.length !== 1 ? "s" : ""} — ${fmt(st.amount, 2)}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <WorkbookTable>
                    <thead>{columnHeaders}</thead>
                    <tbody>
                      <SupplierGroupedRows rows={shopRows} />
                      <tr className="bg-yellow-50 dark:bg-yellow-900/10 border-t border-yellow-200 dark:border-yellow-800 text-xs font-semibold text-yellow-900 dark:text-yellow-300">
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
          <div className={cn("px-3 py-1.5 flex items-center justify-between text-xs font-bold", headerBg, headerText)}>
            <span>TOTAL — {rows.length} CTR</span>
            <div className="flex gap-4">
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
