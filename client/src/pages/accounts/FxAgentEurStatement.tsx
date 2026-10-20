import { useQuery } from "@tanstack/react-query";
import { FileDown, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PeriodFilterValue } from "@/components/ui/period-filter";

interface EurOperation {
  id: number;
  date: string;
  kind: string;
  description: string;
  detail: string;
  eurIn: string;
  eurOut: string;
  balance: string;
  rateUsdPerEur: string;
  voucherId: number | null;
}
interface EurStatement {
  accountName: string;
  activatedOn: string;
  fromDate: string | null;
  toDate: string;
  openingEur: string;
  totalEurIn: string;
  totalEurOut: string;
  closingEur: string;
  rows: EurOperation[];
}

const eur = (amount: string) =>
  Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });

export function fxEurStatementUrl(walletId: number, period: PeriodFilterValue, extension = "") {
  const params = new URLSearchParams();
  if (period.fromDate) params.set("startDate", period.fromDate);
  if (period.toDate) params.set("endDate", period.toDate);
  return "/api/factory/fx-agent-wallets/" + walletId + "/statement" + extension + "?" + params.toString();
}

/** Wallet events only: never show historic USD GL vouchers as EUR transactions. */
export function FxAgentEurStatement({
  walletId,
  periodFilter,
  hideBalances,
}: {
  walletId: number;
  periodFilter: PeriodFilterValue;
  hideBalances: boolean;
}) {
  const { selectedCompany } = useCompany();
  const { data, isPending, error } = useQuery<EurStatement>({
    queryKey: ["fx-agent-eur-statement", selectedCompany?.id, walletId, periodFilter.fromDate || null, periodFilter.toDate || null],
    queryFn: async () => {
      const response = await fetch(fxEurStatementUrl(walletId, periodFilter), { credentials: "include" });
      if (!response.ok) {
        const issue = await response.json().catch(() => null);
        throw new Error(issue?.message || "Could not load EUR movements");
      }
      return response.json();
    },
    enabled: walletId > 0 && !!selectedCompany?.id,
    staleTime: 0,
  });

  if (isPending) return <Skeleton className="h-44 w-full" />;
  if (error) {
    return <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
      {error.message}
    </div>;
  }
  if (!data) return null;

  const format = (amount: string) => hideBalances ? "••••" : "EUR " + eur(amount);
  return (
    <section className="space-y-3" data-testid="fx-agent-eur-statement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-sm">EUR Transactions</h4>
          <p className="text-xs text-muted-foreground">
            Native EUR movements only — starting from the first USD to EUR conversion.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {data.fromDate || data.activatedOn} — {data.toDate}
          </span>
          <Button size="sm" variant="outline" onClick={() => window.open(fxEurStatementUrl(walletId, periodFilter, ".pdf"), "_blank")} data-testid="fx-agent-export-eur-pdf">
            <FileDown className="w-4 h-4 mr-1" /> EUR PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(fxEurStatementUrl(walletId, periodFilter, ".xlsx"), "_blank")} data-testid="fx-agent-export-eur-excel">
            <FileSpreadsheet className="w-4 h-4 mr-1" /> EUR Excel
          </Button>
        </div>
      </div>
      {!hideBalances && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="fx-agent-eur-summary">
          {([
            ["Opening EUR", data.openingEur],
            ["EUR Received", data.totalEurIn],
            ["EUR Paid / Reversed", data.totalEurOut],
            ["Closing EUR", data.closingEur],
          ] as const).map(([label, amount]) => (
            <Card key={label} className="bg-muted/20">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-mono text-base font-semibold tabular-nums">{format(amount)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <div className="rounded-lg border overflow-x-auto hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Date</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead>Notes / Agreed Rate</TableHead>
              {!hideBalances && <TableHead className="text-right">EUR In</TableHead>}
              {!hideBalances && <TableHead className="text-right">EUR Out</TableHead>}
              {!hideBalances && <TableHead className="text-right">EUR Balance</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="bg-muted/20" data-testid="fx-agent-eur-opening">
              <TableCell className="font-mono text-xs">{data.fromDate || data.activatedOn}</TableCell>
              <TableCell className="font-medium">Opening EUR balance</TableCell>
              <TableCell className="text-xs text-muted-foreground">Native wallet only</TableCell>
              {!hideBalances && <TableCell />}
              {!hideBalances && <TableCell />}
              {!hideBalances && <TableCell className="text-right font-mono font-semibold">{format(data.openingEur)}</TableCell>}
            </TableRow>
            {data.rows.map((op) => (
              <TableRow key={op.id} data-testid={"fx-agent-eur-operation-" + op.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs">{op.date}</TableCell>
                <TableCell className="font-medium text-sm">{op.description}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {op.detail && <div>{op.detail}</div>}
                  {!hideBalances && <div>USD/EUR {Number(op.rateUsdPerEur).toFixed(4)}{op.voucherId ? " · Voucher #" + op.voucherId : ""}</div>}
                </TableCell>
                {!hideBalances && <TableCell className="text-right font-mono">{Number(op.eurIn) > 0 ? format(op.eurIn) : "—"}</TableCell>}
                {!hideBalances && <TableCell className="text-right font-mono">{Number(op.eurOut) > 0 ? format(op.eurOut) : "—"}</TableCell>}
                {!hideBalances && <TableCell className="text-right font-mono font-semibold">{format(op.balance)}</TableCell>}
              </TableRow>
            ))}
            {data.rows.length === 0 && (
              <TableRow><TableCell colSpan={hideBalances ? 3 : 6} className="text-center text-sm text-muted-foreground py-6">
                No EUR transactions in this period.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="space-y-2 md:hidden" data-testid="fx-agent-eur-mobile-rows">
        <div className="rounded-lg border bg-muted/20 p-3 flex items-center justify-between text-sm">
          <span>Opening EUR balance</span><span className="font-mono font-semibold">{format(data.openingEur)}</span>
        </div>
        {data.rows.map((op) => (
          <div key={op.id} className="rounded-lg border p-3 space-y-1 text-sm">
            <p className="text-xs text-muted-foreground">{op.date}</p>
            <p className="font-medium">{op.description}</p>
            {op.detail && <p className="text-xs text-muted-foreground">{op.detail}</p>}
            {!hideBalances && (
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-xs">
                <span>{Number(op.eurIn) > 0 ? "+ " + format(op.eurIn) : "− " + format(op.eurOut)}</span>
                <span className="text-right font-semibold">{format(op.balance)}</span>
              </div>
            )}
          </div>
        ))}
        {data.rows.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No EUR transactions in this period.</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        USD history is available in the USD tab. These EUR movements are not extra USD funds.
      </p>
    </section>
  );
}
