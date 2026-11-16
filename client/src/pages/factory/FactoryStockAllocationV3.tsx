import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TABS, TAB_LABELS } from "./factorystockallocationv3/utils";
import { ScanningPanel } from "./factorystockallocationv3/components/ScanningPanel";
import { CreateLoadDialog } from "./factorystockallocationv3/components/CreateLoadDialog";
import { useFactoryStockAllocationV3State } from "./useFactoryStockAllocationV3State";
import { FactoryStockAllocationV3Section } from "./FactoryStockAllocationV3Section";

// ─────────────────────── Types ───────────────────────

export default function FactoryStockAllocationV3() {
  const {
    activeTab,
    cancelMutation,
    cancelTargetId,
    createLoadProforma,
    expectedLoads,
    finalizedLoads,
    loadingLoads,
    proformas,
    scanningLoad,
    setActiveTab,
    setCancelTargetId,
    setCreateLoadProforma,
    setScanningLoad,
    startMutation,
    stockLoading,
    stockRows,
    totalEtl,
    totalFtp,
    totalInStock,
    totalLoading,
  } = useFactoryStockAllocationV3State();

  // If scanning panel is open, show it full-screen
  if (scanningLoad) {
    return (
      <div className="h-full flex flex-col bg-background">
        <ScanningPanel load={scanningLoad} onClose={() => setScanningLoad(null)} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Page header */}
      <div className="px-6 pt-5 pb-3 border-b shrink-0">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <PageHeader title="Stock Allocation" />
          <Badge className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-sm">v3.0 TEST</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Factory 2.0 isolated module — not production
          </span>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Stock in Hand</p>
              <p className="text-2xl font-bold">{totalInStock}</p>
              <p className="text-xs text-muted-foreground">bales</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-blue-600 dark:text-blue-400">Expected to Load</p>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalEtl}</p>
              <p className="text-xs text-muted-foreground">bales reserved</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-orange-600 dark:text-orange-400">Loading</p>
              <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">{totalLoading}</p>
              <p className="text-xs text-muted-foreground">bales in progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-green-600 dark:text-green-400">Free to Promise</p>
              <p
                className={`text-2xl font-bold ${totalFtp < 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}
              >
                {totalFtp}
              </p>
              <p className="text-xs text-muted-foreground">bales available</p>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <TabsList className="w-max max-w-full" aria-label="Stock allocation sections">
          {TABS.map((tab) => (
            <PillTabButton
              key={tab}
              onClick={() => setActiveTab(tab)}
              data-testid={`button-v3-tab-${tab}`}
              selected={activeTab === tab}
            >
              {TAB_LABELS[tab]}
              {tab === "expected" && expectedLoads.length > 0 && (
                <span className="ml-1.5 rounded-sm bg-info/10 px-1 text-xs text-info">{expectedLoads.length}</span>
              )}
              {tab === "loading" && loadingLoads.length > 0 && (
                <span className="ml-1.5 rounded-sm bg-warning/10 px-1 text-xs text-warning">{loadingLoads.length}</span>
              )}
            </PillTabButton>
          ))}
        </TabsList>
      </div>

      {/* Tab body */}
      <FactoryStockAllocationV3Section
        activeTab={activeTab}
        expectedLoads={expectedLoads}
        finalizedLoads={finalizedLoads}
        loadingLoads={loadingLoads}
        proformas={proformas}
        setCancelTargetId={setCancelTargetId}
        setCreateLoadProforma={setCreateLoadProforma}
        setScanningLoad={setScanningLoad}
        startMutation={startMutation}
        stockLoading={stockLoading}
        stockRows={stockRows}
      />

      {/* Cancel confirmation */}
      <AlertDialog
        open={cancelTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this load?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the expected load. Free to Promise will be restored. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => cancelTargetId && cancelMutation.mutate(cancelTargetId)}>
              Cancel Load
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Load dialog */}
      <CreateLoadDialog
        proforma={createLoadProforma}
        open={!!createLoadProforma}
        onClose={() => setCreateLoadProforma(null)}
      />
    </div>
  );
}
