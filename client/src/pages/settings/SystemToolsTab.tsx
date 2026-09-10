import { useState } from "react";
import {
  ArrowUpRight,
  Building2,
  Eraser,
  Loader2,
  Trash2,
  PieChart,
  Layers3,
  ScanSearch,
  Info,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CleanEmptyAccountsDialog } from "./CleanEmptyAccountsDialog";
import { ResetCompanyDataDialog } from "./SystemMaintenanceDialogs";
import { GroupNetPositionPage } from "./GroupNetPositionPage";
import { useLocation } from "wouter";

interface SystemToolsTabProps {
  appMode: string;
  currentUser: any;
  selectedCompany: any;
  companies: any[];
}

interface ToolCard {
  category: string;
  categoryColor: string;
  icon: ReactNode;
  iconBg: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  testId?: string;
  devOnly?: boolean;
}

function SectionHeading({
  icon: Icon,
  eyebrow,
  title,
  description,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
        <h3 className="mt-1 text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function SystemToolCard({ card }: { card: ToolCard }) {
  return (
    <div
      className="group flex min-h-[218px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md sm:p-6"
      data-testid={card.testId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${card.iconBg}`}>{card.icon}</div>
        <Badge className={`rounded-full border-0 px-2.5 py-1 text-[10px] font-semibold ${card.categoryColor}`}>
          {card.category}
        </Badge>
      </div>

      <div className="mt-5 flex-1 space-y-1.5">
        <h4 className="text-base font-semibold tracking-tight">{card.title}</h4>
        <p className="max-w-sm text-sm leading-5 text-muted-foreground">{card.description}</p>
      </div>

      <Button
        variant="outline"
        className="mt-5 h-10 w-full justify-between border-border/70 bg-background/50 transition-colors group-hover:border-primary/30 group-hover:bg-primary/[0.03]"
        onClick={card.onAction}
        data-testid={`button-action-${card.testId}`}
      >
        <span>{card.actionLabel}</span>
        <ArrowUpRight className="h-4 w-4 text-primary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </Button>
    </div>
  );
}

export function SystemToolsTab({ appMode, currentUser, selectedCompany, companies }: SystemToolsTabProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const isDev = currentUser?.role === "Developer";
  const isFactory = appMode === "factory";
  const isProperties = appMode === "properties";

  const [isResetDataDialogOpen, setIsResetDataDialogOpen] = useState(false);
  const [emptyAccountsOpen, setEmptyAccountsOpen] = useState(false);
  const [groupNetPositionOpen, setGroupNetPositionOpen] = useState(false);

  const { data: parentCompanyData } = useQuery<{ parentCompanyId: number | null }>({
    queryKey: ["/api/system/parent-company"],
    enabled: ["Admin", "Owner", "Developer"].includes(currentUser?.role || ""),
  });

  const setParentCompanyMutation = useMutation({
    mutationFn: async (companyId: number | null) => apiRequest("POST", "/api/system/parent-company", { companyId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/system/parent-company"] });
      toast({ title: "Saved", description: "Parent company updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update parent company.", variant: "destructive" });
    },
  });

  const netPositionPath = isFactory
    ? "/factory/net-position-details"
    : isProperties
      ? "/properties/net-position-details"
      : "/net-position-details";

  if (groupNetPositionOpen && !isProperties) {
    return <GroupNetPositionPage onBack={() => setGroupNetPositionOpen(false)} />;
  }

  const cards: ToolCard[] = [
    {
      category: "Recovery",
      categoryColor: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
      icon: <Trash2 className="h-6 w-6 text-rose-500" />,
      iconBg: "bg-rose-500/10",
      title: "Deleted Items",
      description: "Restore deleted records or permanently remove archived data.",
      actionLabel: "Open",
      onAction: () =>
        navigate(isFactory ? "/factory/deleted-items" : isProperties ? "/properties/deleted-items" : "/deleted-items"),
      testId: "card-deleted-items",
    },
    {
      category: "Diagnostics",
      categoryColor: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
      icon: <ScanSearch className="h-6 w-6 text-amber-500" />,
      iconBg: "bg-amber-500/10",
      title: "Import Cycle Diagnostics",
      description: "Detect imbalance issues and troubleshoot import cycle problems.",
      actionLabel: "Run Check",
      onAction: () => navigate("/import-cycle-diagnostics"),
      testId: "card-import-cycle",
    },
    {
      category: "Financials",
      categoryColor: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
      icon: <PieChart className="h-6 w-6 text-violet-500" />,
      iconBg: "bg-violet-500/10",
      title: "Net Position Details",
      description: "View income, expenses, and net position breakdowns by period.",
      actionLabel: "View Details",
      onAction: () => navigate(netPositionPath),
      testId: "card-net-position",
    },
    ...(!isProperties
      ? [
          {
            category: "Financials",
            categoryColor: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
            icon: <Layers3 className="h-6 w-6 text-blue-500" />,
            iconBg: "bg-blue-500/10",
            title: "Group Net Position",
            description: "Combine What We Have, What We Owe, and Net Position across every active company except Properties.",
            actionLabel: "View Group",
            onAction: () => setGroupNetPositionOpen(true),
            testId: "card-group-net-position",
          } satisfies ToolCard,
        ]
      : []),
  ];
  const visibleCards = cards.filter((card) => isDev || !card.devOnly);

  return (
    <div className="space-y-8">
      <header className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-card via-card to-primary/10 p-5 shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <Wrench className="h-5 w-5" />
              </div>
              <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
                Admin tools
              </Badge>
            </div>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">System Tools</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Recovery, diagnostics, and financial insights for{" "}
                <span className="font-medium text-foreground">{selectedCompany?.name || "the current company"}</span>.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              Access and actions are filtered by your role.
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:min-w-[330px]">
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold tabular-nums">{visibleCards.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">Tools</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold">{isDev ? "Developer" : "Admin"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Access</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold">{isFactory ? "Factory" : isProperties ? "Properties" : "ERP"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Workspace</p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          These tools can affect company records or financial views. Review the impact before confirming changes.
        </span>
      </div>

      <section className="space-y-4">
        <SectionHeading
          icon={Sparkles}
          eyebrow="Workspace tools"
          title="Recovery, diagnostics & insights"
          description="Open a focused tool only when you need to inspect or change system data."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {visibleCards.map((card) => (
            <SystemToolCard key={card.testId} card={card} />
          ))}
        </div>
      </section>

      {isDev && (
        <section className="space-y-4">
          <SectionHeading
            icon={Building2}
            eyebrow="Configuration"
            title="Global settings"
            description="Keep cross-company reporting preferences in one place."
          />
          <Card className="overflow-hidden border-border/70 bg-card/80 shadow-sm">
            <CardContent className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Building2 className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold tracking-tight">Master parent company</h4>
                  <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
                    The primary company used for net position reporting.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 sm:min-w-[280px]">
                <Select
                  value={parentCompanyData?.parentCompanyId?.toString() || "none"}
                  onValueChange={(val) => setParentCompanyMutation.mutate(val === "none" ? null : parseInt(val))}
                >
                  <SelectTrigger className="w-full" data-testid="select-parent-company">
                    <SelectValue placeholder="No parent company set" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (Disabled)</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {setParentCompanyMutation.isPending && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {isDev && (
        <section className="space-y-4">
          <SectionHeading
            icon={Wrench}
            eyebrow="Developer only"
            title="Advanced maintenance"
            description="High-impact maintenance actions are kept separate from everyday diagnostics."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card className="group overflow-hidden border-destructive/20 bg-card/80 shadow-sm transition-all hover:-translate-y-0.5 hover:border-destructive/40 hover:shadow-md">
              <CardContent className="flex h-full flex-col p-5 sm:p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div className="mt-4 flex-1">
                  <h4 className="text-base font-semibold tracking-tight">Reset company data</h4>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    Clear vouchers and entries for a company while preserving master data.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-5 h-10 w-full border-destructive/30 hover:bg-destructive/5"
                  onClick={() => setIsResetDataDialogOpen(true)}
                >
                  Reset Data
                </Button>
              </CardContent>
            </Card>

            <Card className="group overflow-hidden border-border/70 bg-card/80 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
              <CardContent className="flex h-full flex-col p-5 sm:p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Eraser className="h-5 w-5" />
                </div>
                <div className="mt-4 flex-1">
                  <h4 className="text-base font-semibold tracking-tight">Clean empty accounts</h4>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    Review and remove ledger accounts that have no transactions.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-5 h-10 w-full"
                  onClick={() => setEmptyAccountsOpen(true)}
                >
                  Clean Accounts
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      <ResetCompanyDataDialog
        open={isResetDataDialogOpen}
        onOpenChange={setIsResetDataDialogOpen}
        companies={companies}
      />
      <CleanEmptyAccountsDialog
        open={emptyAccountsOpen}
        onOpenChange={setEmptyAccountsOpen}
        companyId={selectedCompany?.id}
      />
    </div>
  );
}
