import { Trash2, ArrowLeftRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useFactoryInvoiceDetailModel } from "../useFactoryInvoiceDetailModel";

type Model = ReturnType<typeof useFactoryInvoiceDetailModel>;

export function FactoryInvoiceDetailFinalizeDialog({ model, isFinalized }: { model: Model; isFinalized: boolean }) {
  const { baleRefArticle, setBaleRefArticle, setExchangeBale, setNewRefInput, setRemoveBaleState, order, isAdmin } =
    model;
  return (
    <Dialog
      open={baleRefArticle !== null}
      onOpenChange={(open) => {
        if (!open) setBaleRefArticle(null);
      }}
    >
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {baleRefArticle?.name}
            <span className="ml-2 font-mono text-sm text-muted-foreground">({baleRefArticle?.code})</span>
          </DialogTitle>
        </DialogHeader>
        {baleRefArticle &&
          (() => {
            const balesForArticle = (order?.bales ?? [])
              .filter((b) => b.articleCode === baleRefArticle.code)
              .sort((a, b) => a.baleReference.localeCompare(b.baleReference));
            const canExchange = isAdmin && isFinalized;
            return balesForArticle.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No bale references found for this item.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {balesForArticle.length} bale{balesForArticle.length !== 1 ? "s" : ""} loaded
                  {canExchange && (
                    <span className="ml-1">
                      — hover a chip to remove <Trash2 className="inline h-3 w-3" /> or exchange{" "}
                      <ArrowLeftRight className="inline h-3 w-3" />
                    </span>
                  )}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {balesForArticle.map((b) => (
                    <div
                      key={b.id}
                      className="group relative rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-sm text-center"
                      data-testid={`bale-ref-${b.baleReference}`}
                    >
                      {b.baleReference}
                      {canExchange && (
                        <>
                          <button
                            className="absolute -top-1.5 -left-1.5 opacity-0 group-hover:opacity-100 touch:opacity-100 bg-background border rounded-full p-0.5 hover-elevate transition-opacity"
                            onClick={() => setRemoveBaleState({ orderBaleId: b.id, reference: b.baleReference })}
                            data-testid={`button-remove-bale-${b.id}`}
                            title="Remove this bale and return to stock"
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </button>
                          <button
                            className="absolute -top-1.5 -right-1.5 opacity-0 group-hover:opacity-100 touch:opacity-100 bg-background border rounded-full p-0.5 hover-elevate transition-opacity"
                            onClick={() => {
                              setExchangeBale({ orderBaleId: b.id, reference: b.baleReference });
                              setNewRefInput("");
                            }}
                            data-testid={`button-exchange-bale-${b.id}`}
                            title="Exchange this bale for another"
                          >
                            <ArrowLeftRight className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}
