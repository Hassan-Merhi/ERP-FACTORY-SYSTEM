import { StockTransferDesktopRow } from "./StockTransferDesktopRow";
import { StockTransferRowAction } from "./StockTransferRowAction";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferDesktopEntries({ model }: { model: StockTransferFormModel }) {
  return (
    <div className="hidden sm:block overflow-x-auto">
      <div className="min-w-[400px]">
        <div className="flex bg-muted/50 border-b sticky top-0 z-30">
          <div className="w-10 sm:w-12 flex items-center justify-center border-r h-9 sm:h-10 font-medium text-xs">
            #
          </div>
          {!model.isPOS && (
            <div className="w-28 sm:w-40 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
              Source
            </div>
          )}
          <div className="flex-1 min-w-[120px] flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Item
          </div>
          <div className="w-16 sm:w-24 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Qty
          </div>
          {!model.isPOS && (
            <>
              <div className="w-16 sm:w-24 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
                Rate
              </div>
              <div className="w-20 sm:w-28 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm bg-muted/30">
                Amt
              </div>
            </>
          )}
          <div className="w-10 sm:w-12 flex items-center justify-center h-9 sm:h-10" />
        </div>
        <div className="max-h-[calc(100dvh-24rem)] overflow-y-auto">
          {model.transferFields.map((field, index) => (
            <div key={field.id} className="flex border-b hover-elevate">
              <div className="w-10 sm:w-12 flex items-center justify-center border-r h-9 sm:h-10 text-xs text-muted-foreground">
                {index + 1}
              </div>
              <StockTransferDesktopRow model={model} index={index} />
              <div className="w-10 sm:w-12 flex items-center justify-center h-9 sm:h-10">
                {model.transferFields.length > 1 && (
                  <StockTransferRowAction
                    onAction={() => model.removeTransfer(index)}
                    testId={`button-remove-transfer-${index}`}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
