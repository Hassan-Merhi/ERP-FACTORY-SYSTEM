// Extracted from ./HistoricalAccounting.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import type { Workpaper, Stock } from "./useHistoricalAccountingStateTypes";

async function read<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message ?? "Historical accounting report unavailable");
  return body as T;
}

export function useHistoricalAccountingState() {
  const [location] = useLocation();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const origin = location.startsWith("/factory/")
    ? "/factory"
    : location.startsWith("/properties/")
      ? "/properties"
      : "";
  const [asOf, setAsOf] = useState("");
  const [from, setFrom] = useState("");
  const [section, setSection] = useState<"trial" | "timeline" | "matching" | "stock" | "limits">("trial");
  const [search, setSearch] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [showRetired, setShowRetired] = useState(true);
  const params = new URLSearchParams();
  if (asOf) params.set("asOfDate", asOf);
  if (from) params.set("fromDate", from);
  const report = useQuery<Workpaper>({
    queryKey: ["/api/accounting/history/report", companyId, asOf, from],
    queryFn: () => read("/api/accounting/history/report?" + params.toString()),
    enabled: !!companyId,
    retry: false,
  });
  const stock = useQuery<Stock>({
    queryKey: ["/api/accounting/history/erp-stock", companyId, asOf],
    queryFn: () => read("/api/accounting/history/erp-stock?asOfDate=" + asOf),
    enabled: !!companyId && section === "stock" && !!asOf,
    retry: false,
  });
  const selected = report.data;
  const accounts = useMemo(
    () =>
      selected?.balance.rows.filter(
        (r) =>
          (includeZero || Math.abs(Number(r.closingDebit)) + Math.abs(Number(r.closingCredit)) > 0.005) &&
          (!search ||
            [r.name, r.code, r.kind, r.accountType].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(search.toLowerCase())
            ))
      ) ?? [],
    [selected, includeZero, search]
  );
  const vouchers = useMemo(
    () => selected?.postingEvidence.documents.filter((v) => showRetired || !v.deleted_on) ?? [],
    [selected, showRetired]
  );
  const links = [
    ["Bank / cash FX", origin + "/accounting/monetary-fx"],
    ["Rental accounting", origin + "/accounting/rentals"],
    ["Intercompany", origin + "/accounting/consolidation"],
    ...(origin === ""
      ? [
          ["ERP inventory audit", "/accounting/erp-inventory"],
          ["Factory production audit", "/accounting/factory-production"],
        ]
      : []),
    ...(origin === "/factory" ? [["Factory production audit", "/factory/accounting/production"]] : []),
  ];
  return {
    accounts,
    asOf,
    from,
    includeZero,
    links,
    report,
    search,
    section,
    selected,
    setAsOf,
    setFrom,
    setIncludeZero,
    setSearch,
    setSection,
    setShowRetired,
    showRetired,
    stock,
    vouchers,
  };
}

export function HistoricalAccountingSection({
  vouchers,
}: Pick<ReturnType<typeof useHistoricalAccountingState>, "vouchers">) {
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Voucher</th>
            <th className="p-2">Effective</th>
            <th className="p-2">Recorded</th>
            <th className="p-2">Retired</th>
            <th className="p-2 text-right">Booked Dr/Cr USD</th>
            <th className="p-2">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {vouchers.map((v) => (
            <tr key={v.id} className="border-b align-top">
              <td className="p-2">
                {v.voucher_number}
                <div className="text-xs">
                  {v.voucher_type} · {v.source_module ?? "legacy"} · {v.currency}
                </div>
              </td>
              <td className="p-2">{v.booked_on}</td>
              <td className="p-2">{v.created_on}</td>
              <td className="p-2">{v.deleted_on ?? "—"}</td>
              <td className="p-2 text-right tabular-nums">
                {v.debit_base} / {v.credit_base}
              </td>
              <td className="p-2">
                {v.late_created ? "Entered later; effective earlier" : ""}
                {v.later_retired && <div>Retired after as-of</div>}
                {!v.posted_now && <div className="text-muted-foreground">Not in current live ledger</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoricalAccountingSection2({
  accounts,
}: Pick<ReturnType<typeof useHistoricalAccountingState>, "accounts">) {
  return (
    <div className="max-h-[660px] overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">Account</th>
            <th className="p-2">Kind / type</th>
            <th className="p-2 text-right">Opening Dr</th>
            <th className="p-2 text-right">Opening Cr</th>
            <th className="p-2 text-right">Activity Dr</th>
            <th className="p-2 text-right">Activity Cr</th>
            <th className="p-2 text-right">Closing Dr</th>
            <th className="p-2 text-right">Closing Cr</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((r, i) => (
            <tr key={r.kind + ":" + r.id + ":" + i} className="border-b">
              <td className="p-2">
                {r.code ?? r.kind}: {r.name}
              </td>
              <td className="p-2">
                {r.kind}
                <div className="text-xs text-muted-foreground">{r.accountType}</div>
              </td>
              {(
                [
                  r.openingDebit,
                  r.openingCredit,
                  r.periodDebit,
                  r.periodCredit,
                  r.closingDebit,
                  r.closingCredit,
                ] as string[]
              ).map((v, j) => (
                <td key={j} className="p-2 text-right tabular-nums">
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
