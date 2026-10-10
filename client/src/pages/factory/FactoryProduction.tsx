import { useState, Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import {
  Factory,
  Package,
  Boxes,
  Tags,
  Search,
  Container,
  History,
  BarChart3,
  ArrowRightLeft,
  ScanLine,
  CheckCircle,
  Users,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";

const ProductionRawStock = lazy(() => import("./ProductionRawStock"));
const MixBatches = lazy(() => import("../MixBatches"));
const ProductionBales = lazy(() => import("../ProductionBales"));
const BaleProducts = lazy(() => import("../BaleProducts"));
const BarcodeLookup = lazy(() => import("../BarcodeLookup"));
const BalesHistory = lazy(() => import("./BalesHistory"));
const ProductionSummary = lazy(() => import("./ProductionSummary"));
const BaleTransfers = lazy(() => import("../BaleTransfers"));
const PressingBales = lazy(() => import("../PressingBales"));
const FactorySuppliers = lazy(() => import("./FactorySuppliers"));
const FactoryContainers = lazy(() => import("./FactoryContainers"));
const FactoryImport = lazy(() => import("./FactoryImport"));

function LoadingFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

type SectionKey =
  | "raw-stock"
  | "mix-batches"
  | "pressing-bales"
  | "production-bales"
  | "bales-history"
  | "bale-products"
  | "barcode-lookup"
  | "production-summary"
  | "bale-transfers"
  | "factory-suppliers"
  | "factory-containers"
  | "factory-import";

interface SidebarItem {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
}

interface SidebarGroup {
  label: string;
  items: SidebarItem[];
}

export default function FactoryProduction() {
  const [activeSection, setActiveSection] = useState<SectionKey>("raw-stock");

  const sidebarGroups: SidebarGroup[] = [
    {
      label: "Master Data",
      items: [
        { key: "factory-suppliers", label: "Factory Suppliers", icon: Users },
        { key: "factory-containers", label: "Factory Containers", icon: Container },
        { key: "bale-products", label: "Bale Products", icon: Tags },
      ],
    },
    {
      label: "Raw Materials",
      items: [
        { key: "raw-stock", label: "Production Raw Stock", icon: Package },
        { key: "mix-batches", label: "Mix Batches", icon: Boxes },
      ],
    },
    {
      label: "Production",
      items: [
        { key: "pressing-bales", label: "Pressing Bales", icon: ScanLine },
        { key: "production-bales", label: "Finalize / Counting", icon: CheckCircle },
        { key: "bales-history", label: "Bales History", icon: History },
      ],
    },
    {
      label: "Logistics",
      items: [{ key: "bale-transfers", label: "Bale Transfers", icon: ArrowRightLeft }],
    },
    {
      label: "Analytics",
      items: [{ key: "production-summary", label: "Production Summary", icon: BarChart3 }],
    },
    {
      label: "Traceability",
      items: [{ key: "barcode-lookup", label: "Barcode Lookup", icon: Search }],
    },
    {
      label: "Data",
      items: [{ key: "factory-import", label: "Import Data", icon: Upload }],
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Factory className="h-8 w-8 text-primary" />
        <div>
          <PageHeader title="Factory Production" subtitle="Manage bales, batches, and production" />
        </div>
      </div>

      <div className="flex gap-6">
        <nav className="w-56 shrink-0 space-y-4">
          {sidebarGroups.map((group) => (
            <div key={group.label}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
                {group.label}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeSection === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setActiveSection(item.key)}
                      data-testid={`tab-factory-${item.key}`}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                        isActive
                          ? "bg-background shadow-xs font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          <Suspense fallback={<LoadingFallback />}>
            {activeSection === "raw-stock" && <ProductionRawStock />}
            {activeSection === "mix-batches" && <MixBatches />}
            {activeSection === "pressing-bales" && <PressingBales />}
            {activeSection === "production-bales" && <ProductionBales />}
            {activeSection === "bales-history" && <BalesHistory />}
            {activeSection === "bale-products" && <BaleProducts />}
            {activeSection === "barcode-lookup" && <BarcodeLookup />}
            {activeSection === "production-summary" && <ProductionSummary />}
            {activeSection === "bale-transfers" && <BaleTransfers />}
            {activeSection === "factory-suppliers" && <FactorySuppliers />}
            {activeSection === "factory-containers" && <FactoryContainers />}
            {activeSection === "factory-import" && <FactoryImport />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
