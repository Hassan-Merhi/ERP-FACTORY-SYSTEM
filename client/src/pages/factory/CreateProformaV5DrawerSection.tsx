// Extracted from ./CreateProformaV5Drawer.tsx to keep that module under the source-size cap.
import { cn } from "@/lib/utils";
import { useCreateProformaV5DrawerState } from "./useCreateProformaV5DrawerState";
import { formatUsd } from "@/lib/moneyDisplay";
import { CreateProformaV5DrawerSectionContent } from "./CreateProformaV5DrawerSectionContent";

export function CreateProformaV5DrawerSection({
  errors,
  handleQtyChange,
  handleQtyKeyDown,
  kgPrices,
  map,
  n,
  pricingModes,
  qtyRefs,
  quantities,
  sellingPrices,
  sendToLoading,
  setKgPrices,
  setPricingModes,
  setSellingPrices,
  totalExpected,
  totalKg,
  totalQty,
  totalValue,
  visibleRows,
  visibleTotalBalance,
}: Pick<
  ReturnType<typeof useCreateProformaV5DrawerState>,
  | "errors"
  | "handleQtyChange"
  | "handleQtyKeyDown"
  | "kgPrices"
  | "map"
  | "n"
  | "pricingModes"
  | "qtyRefs"
  | "quantities"
  | "sellingPrices"
  | "sendToLoading"
  | "setKgPrices"
  | "setPricingModes"
  | "setSellingPrices"
  | "totalExpected"
  | "totalKg"
  | "totalQty"
  | "totalValue"
  | "visibleRows"
  | "visibleTotalBalance"
>) {
  return (
    <div className="mx-3 hidden min-w-0 overflow-x-auto rounded-b-xl border border-t-0 bg-card shadow-sm md:block phone-land:hidden sm:mx-5">
      <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
        <colgroup>
          {sendToLoading && n > 0 ? (
            <>
              <col style={{ width: "25%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "16%" }} />
            </>
          ) : (
            <>
              <col style={{ width: "27%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "20%" }} />
            </>
          )}
        </colgroup>
        <thead>
          <tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
            <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">
              Product
            </th>
            <th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
              Available Balance
            </th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
              Qty / Container
            </th>
            <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground">
              Total KG
            </th>
            {sendToLoading && n > 0 && (
              <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-amber-600 dark:text-amber-400">
                Expected Total ({n}×)
              </th>
            )}
            <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">Price</th>
          </tr>
        </thead>
        <CreateProformaV5DrawerSectionContent
          errors={errors}
          handleQtyChange={handleQtyChange}
          handleQtyKeyDown={handleQtyKeyDown}
          kgPrices={kgPrices}
          map={map}
          n={n}
          pricingModes={pricingModes}
          qtyRefs={qtyRefs}
          quantities={quantities}
          sellingPrices={sellingPrices}
          sendToLoading={sendToLoading}
          setKgPrices={setKgPrices}
          setPricingModes={setPricingModes}
          setSellingPrices={setSellingPrices}
          visibleRows={visibleRows}
        />
        <tfoot>
          <tr className="sticky bottom-0 z-20 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
            <td className="sticky left-0 z-10 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800">
              <span className="text-foreground">Totals</span>
              <span className="ml-1.5 font-normal text-muted-foreground">({visibleRows.length} products)</span>
            </td>
            <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
            <td
              className={cn(
                "border-r px-2 py-3 text-center font-mono tabular-nums",
                visibleTotalBalance < 0
                  ? "text-destructive"
                  : visibleTotalBalance > 0
                    ? "text-green-700 dark:text-green-400"
                    : "text-muted-foreground"
              )}
            >
              {visibleTotalBalance > 0 ? `+${visibleTotalBalance}` : visibleTotalBalance}
            </td>
            <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-foreground">
              {totalQty > 0 ? totalQty : <span className="text-muted-foreground/40">—</span>}
            </td>
            <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-muted-foreground">
              {totalKg > 0 ? (
                <span className="text-foreground">
                  {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                </span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </td>
            {sendToLoading && n > 0 && (
              <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-amber-600 dark:text-amber-400">
                {totalExpected > 0 ? totalExpected : <span className="text-muted-foreground/40">—</span>}
              </td>
            )}
            <td className="px-2 py-3 text-center font-mono tabular-nums text-foreground">
              {totalValue > 0 ? formatUsd(totalValue, 2) : <span className="text-muted-foreground/40">—</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
