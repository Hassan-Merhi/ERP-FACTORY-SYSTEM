import { useEffect, useState, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  MapPin,
  Calendar,
  ShoppingCart,
  MessageSquare,
  Settings,
  Bot,
  Trash2,
  Link as LinkIcon,
  Wrench,
  PieChart,
  BarChart3,
  AlertTriangle,
  Box,
  Archive,
  Users,
  ArrowLeftRight,
  ArrowRight,
  Tag,
  Truck,
  FileText,
  Ship,
  HardHat,
  Sparkles,
  Bell,
  ShieldCheck,
} from "lucide-react";
import { useAppMode } from "@/contexts/AppModeContext";
import { useErpVisibleSections } from "@/components/AppSidebar";
import { useFactoryVisibleSections } from "@/components/FactorySidebar";
import { PROPERTIES_NAV_SECTIONS } from "@/components/PropertiesSidebar";
import type { NavItem, NavSection } from "@/components/sidebar/sidebarPrimitives";

interface CommandPaletteUser {
  username?: string | null;
  currentRole?: string | null;
  role?: string | null;
}

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isPOS?: boolean;
  hasErpAccess?: boolean;
  hasFactoryAccess?: boolean;
  hasPropertiesAccess?: boolean;
  isAdminOwner?: boolean;
  user?: CommandPaletteUser;
}

interface PageEntry {
  label: string;
  description?: string;
  path: string;
  icon: React.ElementType;
  /**
   * The page is registered only in ErpRoutes, so under a factory-type company
   * the route guard redirects this unprefixed path to the factory default
   * before it can render — selecting it would silently navigate somewhere else.
   *
   * Several older admin entries share that condition and are not marked, which
   * is a pre-existing gap rather than a decision; marking is done as entries
   * are verified, so an unmarked entry means "not yet checked", never "checked
   * and fine".
   */
  erpShellOnly?: boolean;
}

/** Optional descriptions overlaid onto items derived from sidebar nav. */
const DESCRIPTIONS: Record<string, string> = {
  "/": "Track containers and shipments",
  "/financial-overview": "Dashboard with key financial metrics",
  "/containers": "Manage all containers",
  "/location-inventory": "Stock levels by location",
  "/stock-otw": "On-the-way stock tracking",
  "/stock-items": "Manage all stock items",
  "/stock-query": "Search and query stock",
  "/accounts": "Chart of accounts and ledgers",
  "/suppliers": "Supplier management",
  "/customers": "Customer accounts",
  "/vouchers": "Payment, receipt and journal vouchers",
  "/daybook": "Daily transaction log",
  "/payroll": "Employee payroll management",
  "/pos": "Point of sale",
  "/pos-daybook": "Point of sale daily log",
  "/sales-report": "Sales analytics and reports",
  "/analytics": "Business analytics",
  "/chat": "Internal messaging",
  "/factory/dashboard": "Intelligence overview",
  "/factory/stock-entry": "Enter bale stock",
  "/factory/bales-hub": "Manage all bales",
  "/factory/raw-materials": "Raw material inventory",
  "/factory/parties": "Factory customers and suppliers",
  "/factory/sales/loadings": "Container loading management",
  "/factory/invoicing": "Proformas, pending and finalized invoices",
  "/factory/payroll-hub": "Workers and employees payroll",
  "/factory/vouchers": "Accounting vouchers",
  "/factory/accounts": "Chart of accounts",
  "/factory/daybook": "Daily transaction log",
  "/factory/location-inventory": "Stock levels by location",
  "/factory/containers-hub": "Factory containers and stock on the way",
  "/factory/intelligence/dashboard": "KPIs and insights",
  "/factory/intelligence/kpis": "Key performance indicators",
  "/factory/intelligence/supplier-hub": "Supplier reports, statements and scores",
  "/factory/intelligence/financial-hub": "Net profit, net position, cash flow and profitability",
  "/factory/intelligence/production-hub": "Production summary, waste tracking and mix optimizer",
  "/factory/bale-products": "Finished bale products",
  "/factory/bale-relabeling": "Relabel and reassign bales",
  "/properties/rentals": "Properties (warehouses) rented out",
  "/properties/rentals?tab=shops": "Shops rented out",
  "/properties/rentals?tab=payments": "Rental payments log",
  "/properties/transfer": "Cash transfer between properties",
  "/properties/accounts": "Chart of accounts",
  "/properties/vouchers": "Accounting vouchers",
};

/** Extra entries that aren't part of any nav section but should appear in the palette. */
const ERP_EXTRAS: PageEntry[] = [
  { label: "Container Dashboard", description: DESCRIPTIONS["/"], path: "/", icon: LayoutDashboard },
  {
    label: "Financial Overview",
    description: DESCRIPTIONS["/financial-overview"],
    path: "/financial-overview",
    icon: LayoutDashboard,
  },
  { label: "Chat", description: "Internal messaging", path: "/chat", icon: MessageSquare },
];

/** ERP hub tab entries — each tab inside a hub page gets its own searchable entry. */
const ERP_HUB_TABS: PageEntry[] = [
  {
    label: "Stock Transfers",
    description: "Transfer stock between locations",
    path: "/sales-tools?tab=transfers",
    icon: ArrowLeftRight,
  },
  { label: "Price List", description: "Product price list", path: "/sales-tools?tab=pricelist", icon: Tag },
  { label: "Suppliers", description: "Supplier management", path: "/parties?tab=suppliers", icon: Truck },
  { label: "Customers", description: "Customer accounts", path: "/parties?tab=customers", icon: Users },
];

/** Factory routes that aren't in FACTORY_NAV_SECTIONS but were historically in the palette. */
const FACTORY_EXTRAS_ALWAYS: PageEntry[] = [
  { label: "Factory Daybook", description: DESCRIPTIONS["/factory/daybook"], path: "/factory/daybook", icon: Calendar },
  { label: "Factory Chat", description: "Internal messaging", path: "/factory/chat", icon: MessageSquare },
  {
    label: "Bale Relabeling",
    description: DESCRIPTIONS["/factory/bale-relabeling"],
    path: "/factory/bale-relabeling",
    icon: Archive,
  },
];

/** Factory hub tab entries — each tab in a hub page gets its own searchable entry. */
const FACTORY_HUB_TABS: PageEntry[] = [
  { label: "Bales", description: "All bale stock", path: "/factory/bales-hub?tab=history", icon: Box },
  {
    label: "Barcode Lookup",
    description: "Look up bales by barcode",
    path: "/factory/bales-hub?tab=barcode",
    icon: Archive,
  },
  {
    label: "Bale Products",
    description: DESCRIPTIONS["/factory/bale-products"],
    path: "/factory/bales-hub?tab=products",
    icon: Box,
  },
  {
    label: "Import History",
    description: "Bale import history",
    path: "/factory/bales-hub?tab=imports",
    icon: Archive,
  },
  { label: "Proformas", description: "Proforma invoices", path: "/factory/invoicing?tab=proformas", icon: FileText },
  {
    label: "Invoices",
    description: "Finalized factory invoices",
    path: "/factory/invoicing?tab=invoices",
    icon: FileText,
  },
  {
    label: "Container Loadings",
    description: "Manage container loadings",
    path: "/factory/sales/loadings?tab=loadings",
    icon: Ship,
  },
  {
    label: "Pending Loadings",
    description: "Loadings pending confirmation",
    path: "/factory/sales/loadings?tab=pending",
    icon: Ship,
  },
  { label: "Payroll", description: "Workers and employees payroll", path: "/factory/payroll-hub", icon: HardHat },
  {
    label: "Workers",
    description: "Worker payroll and attendance",
    path: "/factory/payroll-hub?section=workers",
    icon: HardHat,
  },
  {
    label: "Employees",
    description: "Employee records and payroll",
    path: "/factory/payroll-hub?section=employees",
    icon: Users,
  },
  { label: "Parties", description: "Factory customers and suppliers", path: "/factory/parties", icon: Users },
  {
    label: "Customers",
    description: "Factory customer accounts",
    path: "/factory/parties?section=customers",
    icon: Users,
  },
  {
    label: "Factory Suppliers",
    description: "Factory supplier management",
    path: "/factory/parties?section=suppliers",
    icon: Truck,
  },
  {
    label: "Factory Vouchers",
    description: DESCRIPTIONS["/factory/vouchers"],
    path: "/factory/vouchers",
    icon: FileText,
  },
  {
    label: "Factory Accounts",
    description: DESCRIPTIONS["/factory/accounts"],
    path: "/factory/accounts",
    icon: PieChart,
  },
  {
    label: "Supplier Report",
    description: "Supplier performance report",
    path: "/factory/intelligence/supplier-hub?section=report",
    icon: FileText,
  },
  {
    label: "Supplier Statement",
    description: "Supplier account statement",
    path: "/factory/intelligence/supplier-hub?section=statement",
    icon: FileText,
  },
  {
    label: "Supplier Scores",
    description: "Supplier scoring and evaluation",
    path: "/factory/intelligence/supplier-hub?section=scores",
    icon: PieChart,
  },
  {
    label: "Net Profit",
    description: "Net profit analytics",
    path: "/factory/intelligence/financial-hub?section=net-profit",
    icon: PieChart,
  },
  {
    label: "Net Position",
    description: "Assets vs liabilities net position",
    path: "/factory/intelligence/financial-hub?section=net-position",
    icon: PieChart,
  },
  {
    label: "Cash Flow",
    description: "Cashflow intelligence",
    path: "/factory/intelligence/financial-hub?section=cashflow",
    icon: PieChart,
  },
  {
    label: "Profitability",
    description: "Profitability analysis",
    path: "/factory/intelligence/financial-hub?section=profitability",
    icon: PieChart,
  },
  {
    label: "Production Summary",
    description: "Production output summary",
    path: "/factory/intelligence/production-hub?section=production-summary",
    icon: BarChart3,
  },
  {
    label: "Waste Tracking",
    description: "Production waste tracking",
    path: "/factory/intelligence/production-hub?section=waste",
    icon: BarChart3,
  },
  {
    label: "Mix Optimizer",
    description: "Raw material mix optimizer",
    path: "/factory/intelligence/production-hub?section=mix-optimizer",
    icon: BarChart3,
  },
];

const PROPERTIES_EXTRAS: PageEntry[] = [
  { label: "Properties Daybook", description: "Daily transaction log", path: "/properties/daybook", icon: Calendar },
  {
    label: "Properties Dashboard",
    description: "Properties overview",
    path: "/properties/dashboard",
    icon: LayoutDashboard,
  },
  { label: "Properties Analytics", description: "Properties analytics", path: "/properties/analytics", icon: PieChart },
  { label: "My Settings", description: "Personal preferences", path: "/my-settings", icon: Settings },
];

const PROPERTIES_ADMIN_EXTRAS: PageEntry[] = [
  {
    label: "Properties Settings",
    description: "Properties module configuration",
    path: "/properties/settings",
    icon: Settings,
  },
];

const adminPages: PageEntry[] = [
  { label: "Settings", description: "App configuration and system tools", path: "/settings", icon: Settings },
  { label: "Chatbot Settings", description: "AI assistant configuration", path: "/chatbot-settings", icon: Bot },
  {
    label: "Notification Settings",
    description: "Configure notification recipients per event type",
    path: "/notification-settings",
    icon: Bell,
  },
  { label: "Deleted Items", description: "View and restore deleted records", path: "/deleted-items", icon: Trash2 },
  {
    label: "Orphaned Records",
    description: "Records with missing references",
    path: "/orphaned-records",
    icon: LinkIcon,
  },
  { label: "Inventory Repair", description: "Fix inventory discrepancies", path: "/inventory-repair", icon: Wrench },
  {
    label: "Convergence Reconciliation",
    description: "Check documents against the evidence behind them",
    path: "/convergence-reconciliation",
    icon: ShieldCheck,
    erpShellOnly: true,
  },
  {
    label: "Balance Repair",
    description: "Fix rent ledger drift, missing voucher entries, orphaned transfers, deposit flags",
    path: "/balance-repair",
    icon: Wrench,
  },
  {
    label: "Net Position Details",
    description: "Detailed net position breakdown (assets vs liabilities)",
    path: "/net-position-details",
    icon: PieChart,
  },
  {
    label: "Import Cycle Diagnostics",
    description: "Diagnose import cycle issues",
    path: "/import-cycle-diagnostics",
    icon: AlertTriangle,
  },
  {
    label: "Account Migration",
    description: "Move a ledger account with its full statement to another company",
    path: "/account-migration",
    icon: ArrowRight,
  },
  {
    label: "Intercompany Links",
    description: "Configure cross-company payment notification links",
    path: "/intercompany-links",
    icon: ArrowRight,
  },
];

const intercompanyPages: PageEntry[] = [
  {
    label: "Intercompany Requests",
    description: "Review and approve intercompany payment notifications",
    path: "/intercompany-requests",
    icon: ArrowRight,
  },
];

const posPages: PageEntry[] = [
  { label: "Point of Sale", description: "POS interface", path: "/", icon: ShoppingCart },
  { label: "POS Daybook", description: "Daily POS log", path: "/pos-daybook", icon: Calendar },
  { label: "Location Inventory", description: "Stock levels by location", path: "/location-inventory", icon: MapPin },
  { label: "Chat", description: "Internal messaging", path: "/pos-chat", icon: MessageSquare },
];

function navItemToEntry(item: NavItem): PageEntry {
  return {
    label: item.title,
    description: DESCRIPTIONS[item.url],
    path: item.url,
    icon: item.icon,
  };
}

function buildEntries(sections: NavSection[], extras: PageEntry[] = [], extraNavItems: NavItem[] = []): PageEntry[] {
  const seen = new Set<string>();
  const out: PageEntry[] = [];
  for (const e of extras) {
    if (!seen.has(e.path)) {
      seen.add(e.path);
      out.push(e);
    }
  }
  for (const item of extraNavItems) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      out.push(navItemToEntry(item));
    }
  }
  for (const section of sections) {
    for (const item of section.items) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        out.push(navItemToEntry(item));
      }
    }
  }
  return out;
}

function PaletteItem({ page, onSelect }: { page: PageEntry; onSelect: (path: string) => void }) {
  const Icon = page.icon;
  return (
    <CommandItem
      key={page.path}
      value={`${page.label} ${page.description ?? ""}`}
      onSelect={() => onSelect(page.path)}
      data-testid={`command-item-${page.path.replace(/\//g, "-").replace(/^-/, "") || "home"}`}
    >
      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
      <div className="flex flex-col">
        <span>{page.label}</span>
        {page.description && <span className="text-xs text-muted-foreground">{page.description}</span>}
      </div>
    </CommandItem>
  );
}

export function CommandPalette({
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  isPOS = false,
  hasErpAccess = true,
  hasFactoryAccess = false,
  hasPropertiesAccess = false,
  isAdminOwner = false,
  user,
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const appMode = useAppMode();
  const [, setLocation] = useLocation();
  const effectiveRole = user?.currentRole ?? user?.role ?? "";
  const isOwner = effectiveRole === "Owner";
  const canSeeAdminCommands = effectiveRole === "Admin" || effectiveRole === "Developer";

  const isControlled = externalOpen !== undefined;
  const open = isControlled ? externalOpen : internalOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      if (!isControlled) setInternalOpen(value);
      externalOnOpenChange?.(value);
    },
    [isControlled, externalOnOpenChange]
  );

  useEffect(() => {
    if (!isAdminOwner) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen, isAdminOwner]);

  const navigate = useCallback(
    (path: string) => {
      setOpen(false);
      setLocation(path);
    },
    [setOpen, setLocation]
  );

  const erpVis = useErpVisibleSections(hasErpAccess && !isPOS ? user : undefined);
  const factoryVis = useFactoryVisibleSections(
    hasFactoryAccess && !isPOS && user ? { role: user.role ?? undefined } : undefined
  );

  const erpPages = useMemo(
    () =>
      buildEntries(
        erpVis.sections,
        [...ERP_EXTRAS, ...ERP_HUB_TABS],
        [...erpVis.visiblePinnedItems, ...erpVis.visibleUtilityItems]
      ),
    [erpVis.sections, erpVis.visiblePinnedItems, erpVis.visibleUtilityItems]
  );

  const factoryPages = useMemo(() => {
    return buildEntries(factoryVis.sections, [...FACTORY_EXTRAS_ALWAYS, ...FACTORY_HUB_TABS]);
  }, [factoryVis.sections]);

  const propertiesPages = useMemo(
    () =>
      buildEntries(PROPERTIES_NAV_SECTIONS, [
        ...PROPERTIES_EXTRAS,
        ...(canSeeAdminCommands ? PROPERTIES_ADMIN_EXTRAS : []),
      ]).filter((page) => !isOwner || page.path !== "/properties/analytics"),
    [canSeeAdminCommands, isOwner]
  );

  const showErp = !isPOS && hasErpAccess;
  const showFactory = !isPOS && hasFactoryAccess;
  const showProperties = !isPOS && hasPropertiesAccess;
  // Global admin routes (e.g. /settings, /deleted-items) only work in ERP/Factory shells.
  // In properties-only mode, suppress them since the properties shell redirects away.
  const showAdmin = !isPOS && canSeeAdminCommands && (showErp || showFactory);
  // Entries whose page lives only in ErpRoutes are dropped outside the ERP
  // shell: under a factory company the guard redirects the unprefixed path away,
  // so offering them means offering a command that goes somewhere else.
  const visibleAdminPages = useMemo(
    () => adminPages.filter((page) => !page.erpShellOnly || appMode === "erp"),
    [appMode]
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages..." data-testid="input-command-palette" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No pages found.</CommandEmpty>

        {isPOS && (
          <CommandGroup heading="POS">
            {posPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showErp && (
          <CommandGroup heading="ERP">
            {erpPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showErp && showFactory && <CommandSeparator />}

        {showFactory && (
          <CommandGroup heading="Factory">
            {factoryPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {(showErp || showFactory) && showProperties && <CommandSeparator />}

        {showProperties && (
          <CommandGroup heading="Properties">
            {propertiesPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showAdmin && <CommandSeparator />}

        {showAdmin && (
          <CommandGroup heading="Admin & Settings">
            {visibleAdminPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading="Intercompany">
          {intercompanyPages.map((p) => (
            <PaletteItem key={p.path} page={p} onSelect={navigate} />
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="AI Assistant">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("openAIChat", { detail: { prefill: "" } }));
            }}
            data-testid="command-ask-ai"
          >
            <Sparkles className="mr-2 h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <span>Ask AI Assistant</span>
              <span className="text-xs text-muted-foreground">Open the ERP AI chatbot</span>
            </div>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
