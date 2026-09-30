import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeftRight,
  Boxes,
  Database,
  Edit,
  FileSpreadsheet,
  Package,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { MergeStockItemsLauncher } from "./components/MergeStockItemsLauncher";
import { ReconcileOTWNamesCard } from "./components/ReconcileOTWNamesCard";
import { LocationCostPriceOverride } from "./components/LocationCostPriceOverride";
import { DataToolsImportDialogs } from "./DataToolsImportDialogs";
import { SilentProductionDialog } from "./SilentProductionDialog";
import { SilentTransferDialog } from "./SilentTransferDialog";
import type { useDataToolsModel } from "./useDataToolsModel";

type Props = {
  model: ReturnType<typeof useDataToolsModel>;
};

function SectionHeading({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ToolCard({
  icon: Icon,
  title,
  description,
  children,
  action,
  accent = "primary",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  action?: ReactNode;
  accent?: "primary" | "amber" | "blue";
}) {
  const iconStyles = {
    primary: "bg-primary/10 text-primary",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  };

  return (
    <Card className="group flex h-full flex-col overflow-hidden border-border/70 bg-card/80 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <CardHeader className="space-y-3 pb-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 ${iconStyles[accent]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <CardTitle className="text-base tracking-tight">{title}</CardTitle>
          <CardDescription className="text-sm leading-5">{description}</CardDescription>
        </div>
      </CardHeader>
      {(children || action) && (
        <CardContent className="mt-auto space-y-4 pt-1">
          {children}
          {action}
        </CardContent>
      )}
    </Card>
  );
}

export function DataToolsView({ model }: Props) {
  const {
    selectedCompany,
    appMode,
    stockLocationId,
    setStockLocationId,
    setStockImportOpen,
    dtCurrentUser,
    locations,
    setSilentStep,
    setSilentValidItems,
    setSilentWarnItems,
    setSilentErrorLines,
    setSilentParseError,
    setSilentFile,
    setSilentAppliedCount,
    setSilentTransferOpen,
    setSilentProdType,
    setSilentProdLocId,
    setSilentProdItems,
    setSilentProdSearchTerm,
    setSilentProdDone,
    setSilentImportMode,
    setSilentImportPreview,
    setSilentProdOpen,
    setBulkRenameOpen,
  } = model;

  if (!selectedCompany) {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardContent className="flex items-center gap-4 p-8">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Select a company</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose a company to access its data tools.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const canManageData = ["Admin", "Owner", "Developer"].includes(dtCurrentUser?.role || "");
  const isDeveloperWorkspace = dtCurrentUser?.role === "Developer" && appMode !== "factory";
  const workspaceLabel = appMode === "factory" ? "Factory workspace" : "ERP workspace";

  return (
    <div className="space-y-8">
      <header className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-card via-card to-primary/10 p-5 shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <Database className="h-5 w-5" />
              </div>
              <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
                {workspaceLabel}
              </Badge>
            </div>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Data Tools</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Practical tools for importing, organizing, and maintaining data in{" "}
                <span className="font-medium text-foreground">{selectedCompany.name}</span>.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              Access and actions are filtered by your role.
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:min-w-[330px]">
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold tabular-nums">{locations.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">Locations</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold tabular-nums">{canManageData ? "Full" : "Standard"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Access level</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
              <p className="text-2xl font-semibold tabular-nums">{appMode === "factory" ? "Factory" : "ERP"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Mode</p>
            </div>
          </div>
        </div>
      </header>

      {appMode === "factory" && (
        <Card className="overflow-hidden border-primary/20 bg-primary/[0.03] shadow-sm">
          <CardContent className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Upload className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Factory setup</p>
                <h3 className="mt-1 text-base font-semibold tracking-tight">Import factory data</h3>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  Import bales, raw stock, opening balances, and production records from one dedicated tool.
                </p>
              </div>
            </div>
            <Link href="/factory/import">
              <Button data-testid="button-go-to-import" className="w-full shrink-0 sm:w-auto">
                <Upload className="mr-2 h-4 w-4" />
                Open Import Tool
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <section className="space-y-4">
        <SectionHeading
          icon={Boxes}
          title="Import & inventory"
          description="Bring inventory in and move it between locations with controlled tools."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ToolCard
            icon={FileSpreadsheet}
            title="Import stock"
            description="Bulk import inventory quantities from an Excel file."
            action={
              <Button
                className="h-10 w-full"
                onClick={() => setStockImportOpen(true)}
                disabled={!stockLocationId}
                data-testid="button-open-stock-import"
              >
                <Upload className="mr-2 h-4 w-4" />
                Import Stock
              </Button>
            }
          >
            <div className="space-y-2">
              <Label>Select location</Label>
              <Select value={stockLocationId} onValueChange={setStockLocationId}>
                <SelectTrigger data-testid="select-location-stock-import">
                  <SelectValue placeholder="Choose location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </ToolCard>

          <ToolCard
            icon={ArrowLeftRight}
            title="Silent Stock Transfer"
            description="Move stock between locations through an Excel upload without creating a daybook entry."
            action={
              <Button
                variant="outline"
                className="h-10 w-full"
                onClick={() => {
                  setSilentStep("setup");
                  setSilentValidItems([]);
                  setSilentWarnItems([]);
                  setSilentErrorLines([]);
                  setSilentParseError("");
                  setSilentFile(null);
                  setSilentAppliedCount(0);
                  setSilentTransferOpen(true);
                }}
                data-testid="button-open-silent-transfer"
              >
                <ArrowLeftRight className="mr-2 h-4 w-4" />
                Open Silent Transfer
              </Button>
            }
          />

          {isDeveloperWorkspace && <LocationCostPriceOverride locations={locations} />}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading
          icon={Sparkles}
          title="Operations & maintenance"
          description="Use focused tools for controlled adjustments, renaming, and cleanup."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {isDeveloperWorkspace && (
            <ToolCard
              icon={Package}
              title="Silent Production / Consumption"
              description="Directly adjust inventory up or down without creating a daybook entry."
              accent="blue"
              action={
                <Button
                  variant="outline"
                  className="h-10 w-full"
                  onClick={() => {
                    setSilentProdType("Production");
                    setSilentProdLocId("");
                    setSilentProdItems([{ stockItemId: "", stockItemName: "", quantity: "", rate: "", currentQty: 0 }]);
                    setSilentProdSearchTerm("");
                    setSilentProdDone(0);
                    setSilentImportMode(false);
                    setSilentImportPreview([]);
                    setSilentProdOpen(true);
                  }}
                  data-testid="button-open-silent-production"
                >
                  <Package className="mr-2 h-4 w-4" />
                  Open Adjustment Tool
                </Button>
              }
            />
          )}

          {appMode !== "factory" && canManageData && (
            <ToolCard
              icon={Edit}
              title="Bulk rename stock items"
              description="Find and replace text across multiple stock item names at once."
              action={
                <Button
                  variant="outline"
                  className="h-10 w-full"
                  onClick={() => setBulkRenameOpen(true)}
                  data-testid="button-open-bulk-rename"
                >
                  <Edit className="mr-2 h-4 w-4" />
                  Open Bulk Rename
                </Button>
              }
            />
          )}

          {appMode !== "factory" && canManageData && <MergeStockItemsLauncher />}

          {appMode !== "factory" && canManageData && <ReconcileOTWNamesCard />}

          {appMode === "factory" && canManageData && (
            <ToolCard
              icon={ArrowLeftRight}
              title="Merge bale products"
              description="Combine duplicate bale products while moving all bales to the item you keep."
              action={
                <Link href="/factory/merge-bale-products">
                  <Button variant="outline" className="h-10 w-full" data-testid="button-open-merge-products">
                    <ArrowLeftRight className="mr-2 h-4 w-4" />
                    Open Merge Tool
                  </Button>
                </Link>
              }
            />
          )}
        </div>
      </section>

      <SilentProductionDialog model={model} />
      <SilentTransferDialog model={model} />
      <DataToolsImportDialogs model={model} />
    </div>
  );
}
