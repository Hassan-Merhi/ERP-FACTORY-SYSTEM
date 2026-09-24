/**
 * POS Price List page shell.
 *
 * Keeps its import path and default export. The location selection, price
 * queries, unpriced detection, inline editor and Excel flows live in
 * ./pospricelist/usePosPriceListModel; the sidebar, toolbar rows, table and
 * import dialog are separate views under ./pospricelist.
 */
import type { POSPriceListProps } from "./pospricelist/types";
import { usePosPriceListModel } from "./pospricelist/usePosPriceListModel";
import { PriceListMobileLocations, PriceListSidebar } from "./pospricelist/PriceListLocations";
import {
  PriceListLocationVisibility,
  PriceListSearchRow,
  PriceListTitleBar,
  PriceListUnpricedGroups,
} from "./pospricelist/PriceListToolbar";
import { PriceListBody } from "./pospricelist/PriceListTable";
import { PriceListImportDialog } from "./pospricelist/PriceListImportDialog";

export default function POSPriceList({ posUser }: POSPriceListProps) {
  const model = usePosPriceListModel({ posUser });

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Locations sidebar — desktop only ── */}
      <PriceListSidebar model={model} />

      {/* ── Main content ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* ── Title bar ── */}
        <PriceListTitleBar model={model} />

        {/* ── Mobile location selector (phones only) ── */}
        <PriceListMobileLocations model={model} />

        {/* ── Locations visibility strip ── */}
        <PriceListLocationVisibility model={model} />

        {/* ── Search + filter row ── */}
        <PriceListSearchRow model={model} />

        {/* ── Unpriced group chips ── */}
        <PriceListUnpricedGroups model={model} />

        <PriceListBody model={model} />
      </div>

      {/* ── Import preview dialog ── */}
      <PriceListImportDialog model={model} />
    </div>
  );
}
