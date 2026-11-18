// Extracted from ./GroupConsolidationAccounting.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  label,
  read,
  type CompanyList,
  type Consolidation,
  type TransferReport,
} from "./GroupConsolidationAccountingTypes";

export function useGroupConsolidationAccountingState() {
  const [chosen, setChosen] = useState<number[]>([]);
  const [from, setFrom] = useState("");
  const [asOf, setAsOf] = useState("");
  const [filter, setFilter] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [tab, setTab] = useState<"pairs" | "trial" | "transfers" | "workpaper">("pairs");
  const companies = useQuery<CompanyList>({
    queryKey: ["/api/accounting/consolidation/companies"],
    queryFn: () => read("/api/accounting/consolidation/companies"),
    retry: false,
  });
  const available = companies.data?.companies ?? [];
  useEffect(() => {
    if (available.length && chosen.length === 0) {
      setChosen(available.map((x) => x.id));
    }
    // Identity of accessible selection is defined by company IDs, not array object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies.data?.scope, available.map((x) => x.id).join(",")]);
  const companyString = useMemo(
    () =>
      chosen
        .slice()
        .sort((a, b) => a - b)
        .join(","),
    [chosen]
  );
  const query = new URLSearchParams({ companyIds: companyString });
  if (from) query.set("fromDate", from);
  if (asOf) query.set("asOfDate", asOf);
  const ready = chosen.length > 0 && companies.isSuccess;
  const report = useQuery<Consolidation>({
    queryKey: ["/api/accounting/consolidation/report", companyString, from, asOf],
    queryFn: () => read("/api/accounting/consolidation/report?" + query.toString()),
    enabled: ready,
    retry: false,
  });
  const transfers = useQuery<TransferReport>({
    queryKey: ["/api/accounting/consolidation/transfers", companyString, asOf],
    queryFn: () => {
      const p = new URLSearchParams({ companyIds: companyString });
      if (asOf) p.set("asOfDate", asOf);
      return read("/api/accounting/consolidation/transfers?" + p.toString());
    },
    enabled: ready && tab === "transfers",
    retry: false,
  });
  const companyName = (id: number) => available.find((c) => c.id === id)?.name ?? "Company #" + id;
  const financialRows = useMemo(
    () =>
      report.data?.rows.filter(
        (x) =>
          (includeZero || Math.abs(Number(x.bookedUsd)) + Math.abs(Number(x.eliminationUsd)) > 0.005) &&
          (!filter ||
            [x.companyName, x.name, x.code, x.accountKind, x.financialClass].some((s) =>
              String(s ?? "")
                .toLowerCase()
                .includes(filter.toLowerCase())
            ))
      ) ?? [],
    [report.data, includeZero, filter]
  );
  return {
    asOf,
    available,
    chosen,
    companies,
    companyName,
    filter,
    financialRows,
    from,
    includeZero,
    onlyIssues,
    ready,
    report,
    setAsOf,
    setChosen,
    setFilter,
    setFrom,
    setIncludeZero,
    setOnlyIssues,
    setTab,
    tab,
    transfers,
  };
}

export function GroupConsolidationAccountingCardSection({
  companyName,
  onlyIssues,
  setOnlyIssues,
  transfers,
}: Pick<
  ReturnType<typeof useGroupConsolidationAccountingState>,
  "companyName" | "onlyIssues" | "setOnlyIssues" | "transfers"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash and loan transfer legs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {transfers.isFetching && <p className="text-sm text-muted-foreground">Loading transfer evidence…</p>}
        {transfers.isError && <p className="text-destructive text-sm">{(transfers.error as Error).message}</p>}
        {transfers.data && (
          <>
            <p className="text-sm">
              Checked {transfers.data.summary.total} · Matched
              {" " + transfers.data.summary.matched} · Flagged {transfers.data.summary.flagged}
              {transfers.data.summary.truncated ? " · Latest 250 per company (truncated)" : ""}
            </p>
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Transfer</th>
                    <th className="p-2">Companies</th>
                    <th className="p-2 text-right">Source USD</th>
                    <th className="p-2">From voucher</th>
                    <th className="p-2">To voucher</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.data.rows
                    .filter((t) => !onlyIssues || t.status !== "matched")
                    .map((t) => (
                      <tr key={t.transferId} className="border-b align-top">
                        <td className="p-2">
                          #{t.transferId} · {t.type}
                          <div className="text-xs">{t.transferDate}</div>
                        </td>
                        <td className="p-2">
                          {companyName(t.fromCompanyId)}
                          <div className="text-muted-foreground">→ {companyName(t.toCompanyId)}</div>
                        </td>
                        <td className="p-2 text-right tabular-nums">{t.amountSourceUsd}</td>
                        <td className="p-2">
                          {t.fromVoucherId ? <span>{t.fromVoucherNumber ?? "#" + t.fromVoucherId}</span> : "Missing"}
                          <div className="text-xs">Interco GL: {t.sourceSideUsd ?? "Missing"}</div>
                        </td>
                        <td className="p-2">
                          {t.toVoucherId ? <span>{t.toVoucherNumber ?? "#" + t.toVoucherId}</span> : "Missing"}
                          <div className="text-xs">Interco GL: {t.destinationSideUsd ?? "Missing"}</div>
                        </td>
                        <td className="p-2">
                          {label(t.status)}
                          <div className="text-xs text-muted-foreground">{t.explanation}</div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
              Show only flagged transfers
            </label>
            <p className="text-xs text-muted-foreground">
              Voucher IDs belong to their own company. Switch to that authorized company before opening its original
              voucher; this page never substitutes the active company's voucher.
            </p>
            <p className="text-xs text-muted-foreground">{transfers.data.policy}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
