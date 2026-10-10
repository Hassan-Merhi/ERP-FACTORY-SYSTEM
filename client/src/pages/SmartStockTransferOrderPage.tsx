import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import SmartTransferGeneratorDialog from "@/components/stock-transfer/SmartTransferGeneratorDialog";
import type { SmartPreviewOrderItem } from "@/components/stock-transfer/smartTransferPreviewUi";
import BaseStockTransferOrder from "./StockTransferOrder.tsx";
import { confirmAction } from "@/components/ConfirmHost";

const SOURCE_STORAGE_KEY = "stockTransferOrder_selectedLocations";
const DRAFT_KEY = "stockTransferOrder_autosave_draft";
const AUTO_RESTORE_KEY = "stockTransferOrder_smart_auto_restore";

/**
 * Adds the Phase 5 smart generator to the established StockTransferOrder page
 * without duplicating or rewriting that large editor. The approved preview is
 * imported through the editor's own autosave/restore contract, so all normal
 * validation, editing, exporting and optional-voucher creation remain in one
 * place.
 */
export default function SmartStockTransferOrderPage() {
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const isEditingExistingVoucher = new URLSearchParams(window.location.search).has("edit");

  useEffect(() => {
    if (sessionStorage.getItem(AUTO_RESTORE_KEY) !== "1") return;
    sessionStorage.removeItem(AUTO_RESTORE_KEY);

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const restoreButton = document.querySelector<HTMLButtonElement>('[data-testid="button-restore-draft"]');
      if (restoreButton) {
        window.clearInterval(timer);
        restoreButton.click();
        return;
      }
      if (attempts >= 80) window.clearInterval(timer);
    }, 50);

    return () => window.clearInterval(timer);
  }, []);

  const importPreview = async (payload: {
    destinationLocationId: number;
    sourceLocationIds: number[];
    orderItems: SmartPreviewOrderItem[];
  }) => {
    const existingDraft = localStorage.getItem(DRAFT_KEY);
    if (existingDraft) {
      const replace = await confirmAction({
        title: "Importing this smart preview will replace the current unsaved stock transfer order. Continue?",
      });
      if (!replace) return;
    }

    let feedbackSessionId: string | null = null;
    try {
      const feedbackResponse = await fetch("/api/stock-transfers/smart-feedback/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationLocationId: payload.destinationLocationId,
          sourceLocationIds: payload.sourceLocationIds,
          items: payload.orderItems,
        }),
      });
      if (feedbackResponse.ok) {
        const feedback = await feedbackResponse.json();
        feedbackSessionId = typeof feedback?.sessionId === "string" ? feedback.sessionId : null;
      }
    } catch (error) {
      console.warn("[SmartTransferFeedback] Import tracking failed; continuing with the order import.", error);
    }

    localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(payload.sourceLocationIds));
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        destinationLocationId: payload.destinationLocationId,
        orderItems: payload.orderItems,
        transferDate: new Date().toISOString(),
        isOptional: true,
        savedAt: new Date().toISOString(),
        generatedBy: "smart-multi-source-transfer",
        smartFeedbackSessionId: feedbackSessionId,
      })
    );
    sessionStorage.setItem(AUTO_RESTORE_KEY, "1");
    // Preserve (or inject) tab=transferorder so that if the dialog was opened
    // from the Vouchers page (/vouchers), reloading doesn't fall back to the
    // default Payment tab.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "transferorder");
    window.location.href = url.toString();
  };

  return (
    <>
      <BaseStockTransferOrder />

      {!isEditingExistingVoucher && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="fixed bottom-5 right-5 z-40 h-9 rounded-lg border-border/70 bg-background/90 px-3 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setGeneratorOpen(true)}
            data-testid="button-open-smart-transfer-generator"
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Smart Generate
          </Button>
          <SmartTransferGeneratorDialog open={generatorOpen} onOpenChange={setGeneratorOpen} onImport={importPreview} />
        </>
      )}
    </>
  );
}
