import type { ClientErrorLike } from "@/lib/clientError";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Loader2, RotateCcw, Wrench } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const dailyWork = [
  {
    title: "Reports",
    description: "Review supplier payable, profit and loss, and export the Supplier Partner sales form.",
    href: "/sp/reports",
    icon: BarChart3,
  },
  {
    title: "Setup",
    description: "Initialize or repair Supplier Partner accounts, warehouse, and supplier-ledger links.",
    href: "/sp/setup",
    icon: Wrench,
  },
];

function NavigationCard({ item, testId }: { item: (typeof dailyWork)[number]; testId: string }) {
  const Icon = item.icon;

  return (
    <Link href={item.href}>
      <a
        data-testid={testId}
        className="block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card className="h-full transition-colors hover:bg-muted/40">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-muted p-2">
                <Icon className="h-5 w-5" />
              </div>
              <CardTitle className="text-base">{item.title}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription>{item.description}</CardDescription>
          </CardContent>
        </Card>
      </a>
    </Link>
  );
}

interface SpSale {
  id: number;
  status?: string;
  saleDate?: string;
  customerName?: string;
  lines?: unknown[];
  totalFinalCostUsd?: string | number;
  totalSalePriceUsd?: string | number;
}

function money(value: unknown): string {
  const amount = Number(value ?? 0);
  return `$${(Number.isFinite(amount) ? amount : 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function SpOverview() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedSale, setSelectedSale] = useState<SpSale | null>(null);
  const [reason, setReason] = useState("");

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const role = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canReverse = role === "Admin" || role === "Developer";

  const { data: sales = [], isLoading: salesLoading } = useQuery<SpSale[]>({
    queryKey: ["/api/sp/sales"],
  });

  const reverseSale = useMutation({
    mutationFn: async () => {
      if (!selectedSale) throw new Error(releaseDebtEnglish("No sale selected"));
      const response = await apiRequest("POST", `/api/sp/sales/${selectedSale.id}/reverse`, { reason });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = String(query.queryKey[0] ?? "");
          return key.startsWith("/api/sp/") || key.includes("/api/locations/") || key === "/api/vouchers";
        },
      });
      toast({
        title: releaseDebtEnglish("Sale reversed"),
        description: releaseDebtEnglish(
          `Stock and accounting were restored together. Reversal voucher #${data.reversalVoucherId}.`
        ),
      });
      setSelectedSale(null);
      setReason("");
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: releaseDebtEnglish("Reversal failed"), description: error.message, variant: "destructive" });
    },
  });

  const recentSales = sales.slice(0, 20);

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="sp-overview">
      <div>
        <h1 className="text-2xl font-semibold">Supplier Partner</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily Supplier Partner work, reporting, stock setup, aliases, and account configuration.
        </p>
      </div>

      <section className="space-y-3" aria-labelledby="sp-daily-work-heading">
        <div>
          <h2
            id="sp-daily-work-heading"
            className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Daily work
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {dailyWork.map((item) => (
            <NavigationCard
              key={item.href}
              item={item}
              testId={`link-sp-overview-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="sp-sales-history-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2
              id="sp-sales-history-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {releaseDebtEnglish("Recent Supplier Partner sales")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Full reversals restore the original FIFO lots, ERP inventory, cash or bank, and supplier payable in one
              transaction.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {salesLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{releaseDebtEnglish("Loading sales…")}</span>
              </div>
            ) : recentSales.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">
                {releaseDebtEnglish("No Supplier Partner sales have been posted yet.")}
              </p>
            ) : (
              <div className="divide-y">
                {recentSales.map((sale) => (
                  <div
                    key={sale.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
                    data-testid={`row-sp-sale-${sale.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">Sale #{sale.id}</span>
                        <Badge variant={sale.status === "reversed" ? "secondary" : "outline"}>{sale.status}</Badge>
                        <span className="text-xs text-muted-foreground">{sale.saleDate}</span>
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground">{sale.customerName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {sale.lines?.length ?? 0} lot line(s) · Cost {money(sale.totalFinalCostUsd)}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      <span className="font-semibold tabular-nums">{money(sale.totalSalePriceUsd)}</span>
                      {canReverse && sale.status === "posted" && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            setSelectedSale(sale);
                            setReason("");
                          }}
                          data-testid={`button-reverse-sp-sale-${sale.id}`}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          <span>{releaseDebtEnglish("Reverse")}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Dialog
        open={!!selectedSale}
        onOpenChange={(open) => {
          if (!open && !reverseSale.isPending) {
            setSelectedSale(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse Supplier Partner sale #{selectedSale?.id}</DialogTitle>
            <DialogDescription>
              This creates a compensating voucher and restores every original stock lot. The posted sale remains visible
              as reversed and cannot be reversed twice.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="text-sm font-medium" htmlFor="sp-sale-reversal-reason">
              {releaseDebtEnglish("Required reason")}
            </label>
            <textarea
              id="sp-sale-reversal-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={500}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder={releaseDebtEnglish("Explain why the full sale is being reversed…")}
              data-testid="input-sp-sale-reversal-reason"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelectedSale(null)} disabled={reverseSale.isPending}>
                {releaseDebtEnglish("Keep sale")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => reverseSale.mutate()}
                disabled={reason.trim().length < 5 || reverseSale.isPending}
                data-testid="confirm-reverse-sp-sale"
              >
                {reverseSale.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reverse sale
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
