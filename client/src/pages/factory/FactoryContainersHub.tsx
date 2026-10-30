import FactoryContainers from "@/pages/factory/FactoryContainers";
import { FactoryRelatedLinks } from "@/components/FactoryRelatedLinks";

export default function FactoryContainersHub() {
  return (
    <div className="flex flex-col h-full overflow-auto p-4">
      <FactoryRelatedLinks
        className="mb-3 justify-end"
        links={[{ href: "/factory/stock-allocation-v5", label: "Stock Allocation" }]}
      />
      <FactoryContainers />
    </div>
  );
}
