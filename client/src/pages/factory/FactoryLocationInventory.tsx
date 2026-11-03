import { FactoryLocationInventoryLocationView } from "./FactoryLocationInventoryLocationView";
import { FactoryRelatedLinks } from "@/components/FactoryRelatedLinks";
import { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";
import { FactoryLocationInventoryProductView } from "./FactoryLocationInventoryProductView";

export default function FactoryLocationInventory() {
  const inventory = useFactoryLocationInventory();
  return inventory.selectedLocation ? (
    <FactoryLocationInventoryProductView inventory={inventory} />
  ) : (
    <div className="min-w-0">
      <FactoryRelatedLinks
        className="justify-end px-4 pt-3 md:px-6"
        links={[
          { href: "/factory/stock-allocation-v5", label: "Stock Allocation" },
          { href: "/factory/sheets-sacks", label: "Sheets & Sacks" },
        ]}
      />
      <FactoryLocationInventoryLocationView inventory={inventory} />
    </div>
  );
}
