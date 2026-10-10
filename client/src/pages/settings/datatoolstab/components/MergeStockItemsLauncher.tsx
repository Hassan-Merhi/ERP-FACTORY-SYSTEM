/**
 * MergeStockItemsLauncher — extracted sub-component.
 *
 * Extracted from DataToolsTab.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowLeftRight } from "lucide-react";
import { MergeStockItemsCard } from "./MergeStockItemsCard";
import { BulkMergeStockItemsCard } from "./BulkMergeStockItemsCard";
import { MergeHistoryCard } from "./MergeHistoryCard";

export function MergeStockItemsLauncher() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("single");

  return (
    <>
      <Card className="group flex h-full flex-col overflow-hidden border-border/70 bg-card/80 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
        <CardHeader className="space-y-3 pb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-primary/10 text-primary">
            <ArrowLeftRight className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-base tracking-tight">Merge duplicate stock items</CardTitle>
            <CardDescription className="text-sm leading-5">
              Merge items individually, run an Excel batch, or review and reverse past merges.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="mt-auto pt-1">
          <Button
            variant="outline"
            className="h-10 w-full"
            onClick={() => {
              setTab("single");
              setOpen(true);
            }}
            data-testid="button-open-merge-launcher"
          >
            <ArrowLeftRight className="h-4 w-4 mr-2" />
            Open Merge Tool
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Merge Duplicate Stock Items</DialogTitle>
            <DialogDescription>
              Choose a merge method below. Quantities and values are preserved exactly to the cent.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab} className="mt-2">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="single" data-testid="tab-merge-single">
                Single Item
              </TabsTrigger>
              <TabsTrigger value="bulk" data-testid="tab-merge-bulk">
                Bulk via Excel
              </TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-merge-history">
                History
              </TabsTrigger>
            </TabsList>
            <TabsContent value="single" className="mt-4">
              <MergeStockItemsCard embedded />
            </TabsContent>
            <TabsContent value="bulk" className="mt-4">
              <BulkMergeStockItemsCard embedded />
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <MergeHistoryCard embedded />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Edit Log helpers ──────────────────────────────────────────────────────────
