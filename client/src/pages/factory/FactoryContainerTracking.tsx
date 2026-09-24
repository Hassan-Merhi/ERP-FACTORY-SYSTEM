import { searchAny } from "@shared/searchNormalization";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, Search, Ship } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

interface InvoiceContainerRow {
  id: number;
  invoiceNumber: string | null;
  containerNumber: string | null;
  status: string;
  grandTotal: string | null;
  orderDate: string;
  customerName: string | null;
  eta: string | null;
  trackingLastStatus: string | null;
  trackingLink: string | null;
  containerStatus: string | null;
}

const LIST_KEY = "/api/factory/invoice-container-tracking";

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const plain = d.slice(0, 10);
  const [y, m, day] = plain.split("-");
  if (!y || !m || !day) return "—";
  return `${day}/${m}/${y.slice(2)}`;
}

function TrackingStatus({ row }: { row: InvoiceContainerRow }) {
  const raw = row.trackingLastStatus?.trim();
  if (!raw) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const lower = raw.toLowerCase();
  const isDelivered = lower.includes("return") || lower.includes("delivered") || lower.includes("gate-out");
  const isInTransit =
    lower.includes("transit") || lower.includes("gate-in") || lower.includes("vessel") || lower.includes("loaded");
  const colorClass = isDelivered
    ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
    : isInTransit
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>{raw}</span>
  );
}

function InvoiceStatus({ status }: { status: string }) {
  const colors: Record<string, string> = {
    VERIFIED: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    FINALIZED: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  };
  const labels: Record<string, string> = {
    VERIFIED: "Verified",
    FINALIZED: "Finalized",
  };
  const cls = colors[status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {labels[status] ?? status}
    </span>
  );
}

export default function FactoryContainerTracking() {
  const [search, setSearch] = useState("");

  const { data: allRows = [], isLoading } = useQuery<InvoiceContainerRow[]>({
    queryKey: [LIST_KEY],
  });

  const filtered = search.trim()
    ? allRows.filter((r) => {
        return searchAny(search, r.containerNumber, r.customerName, r.invoiceNumber);
      })
    : allRows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search container, customer, invoice…"
            className="pl-8"
            data-testid="input-tracking-search"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filtered.length} container{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Ship className="h-10 w-10 opacity-30" />
          <p className="text-sm">
            {allRows.length === 0
              ? "No verified or finalized invoices with a container number yet"
              : "No containers match your search"}
          </p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-20 bg-background">
              <TableRow>
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead className="whitespace-nowrap">Container #</TableHead>
                <TableHead className="whitespace-nowrap">Customer</TableHead>
                <TableHead className="whitespace-nowrap">Invoice</TableHead>
                <TableHead className="whitespace-nowrap text-right">Cost (USD)</TableHead>
                <TableHead className="whitespace-nowrap">ETA</TableHead>
                <TableHead className="whitespace-nowrap">Invoice Status</TableHead>
                <TableHead className="whitespace-nowrap">Tracking Status</TableHead>
                <TableHead className="whitespace-nowrap">Tracking</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row, idx) => (
                <TableRow key={row.id} data-testid={`row-container-tracking-${row.id}`}>
                  <TableCell className="text-center text-muted-foreground text-sm">{idx + 1}</TableCell>
                  <TableCell
                    className="font-mono font-medium text-sm whitespace-nowrap"
                    data-testid={`text-container-num-${row.id}`}
                  >
                    {row.containerNumber}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm" data-testid={`text-customer-${row.id}`}>
                    {row.customerName ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-sm text-muted-foreground"
                    data-testid={`text-invoice-${row.id}`}
                  >
                    {row.invoiceNumber ?? "—"}
                  </TableCell>
                  <TableCell
                    className="text-right whitespace-nowrap text-sm tabular-nums"
                    data-testid={`text-cost-${row.id}`}
                  >
                    {row.grandTotal ? (
                      `$${formatNumber(parseFloat(row.grandTotal))}`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm font-medium" data-testid={`text-eta-${row.id}`}>
                    {row.eta ? (
                      <span className="text-foreground">{fmtDate(row.eta)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell data-testid={`text-invoice-status-${row.id}`}>
                    <InvoiceStatus status={row.status} />
                  </TableCell>
                  <TableCell data-testid={`text-tracking-status-${row.id}`}>
                    <TrackingStatus row={row} />
                  </TableCell>
                  <TableCell data-testid={`cell-tracking-${row.id}`}>
                    {row.trackingLink ? (
                      <a
                        href={row.trackingLink.startsWith("http") ? row.trackingLink : `https://${row.trackingLink}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                        data-testid={`link-tracking-open-${row.id}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        <span className="max-w-[160px] truncate">{row.trackingLink}</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
