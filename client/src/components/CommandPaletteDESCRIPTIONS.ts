// Extracted from ./CommandPalette.tsx to keep that module under the source-size cap.
import {
  Archive,
  ArrowLeftRight,
  BarChart3,
  Box,
  Calendar,
  FileText,
  LayoutDashboard,
  MessageSquare,
  PieChart,
  ShieldCheck,
  Tag,
  Truck,
  Users,
} from "lucide-react";
import { getAccountingToolLinks, getDeveloperMaintenanceLinks } from "@/lib/accountingToolboxNavigation";
import type { NavItem } from "@/components/sidebar/sidebarPrimitives";

interface CommandPaletteUser {
  username?: string | null;
  currentRole?: string | null;
  role?: string | null;
}

export interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isPOS?: boolean;
  hasErpAccess?: boolean;
  hasFactoryAccess?: boolean;
  hasPropertiesAccess?: boolean;
  isAdminOwner?: boolean;
  user?: CommandPaletteUser;
}

export interface PageEntry {
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
export const DESCRIPTIONS: Record<string, string> = {
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
export const ERP_EXTRAS: PageEntry[] = [
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
export const ERP_HUB_TABS: PageEntry[] = [
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

/** Keep relocated tools directly searchable even when their sidebar shortcuts collapse into parent hubs. */
export const ERP_CONTEXT_ITEMS: NavItem[] = [
  { title: "Stock", url: "/stock", icon: Box },
  { title: "Optional Vouchers", url: "/optional-vouchers", icon: FileText },
  { title: "Supplier Profit Check", url: "/supplier-profit-check", icon: PieChart },
  { title: "POS Item Replacement", url: "/pos-item-replacement", icon: Archive },
  { title: "Stock & Sales Report", url: "/stock-in-sales-report", icon: BarChart3 },
  { title: "Market Price Analysis", url: "/item-market-analysis", icon: BarChart3 },
];

// Keep every original developer accounting destination searchable after collapsing the sidebar.
export const ERP_ACCOUNTING_CONTEXT_ITEMS: NavItem[] = getAccountingToolLinks("erp").map((item) => ({
  title: item.label,
  url: item.path,
  icon: ShieldCheck,
}));

export const FACTORY_ACCOUNTING_CONTEXT: PageEntry[] = [
  {
    label: "Factory Accounting Toolbox",
    description: "Accounting, audit and maintenance tools",
    path: "/factory/accounting/toolbox",
    icon: ShieldCheck,
  },
  ...getAccountingToolLinks("factory").map((item) => ({
    label: item.label,
    description: item.description,
    path: item.path,
    icon: ShieldCheck,
  })),
];

export const PROPERTIES_ACCOUNTING_CONTEXT: PageEntry[] = getAccountingToolLinks("properties").map((item) => ({
  label: item.label,
  description: item.description,
  path: item.path,
  icon: ShieldCheck,
}));

export const FACTORY_MAINTENANCE_CONTEXT: PageEntry[] = getDeveloperMaintenanceLinks("factory").map((item) => ({
  label: item.label,
  description: item.description,
  path: item.path,
  icon: ShieldCheck,
}));

export const PROPERTIES_MAINTENANCE_CONTEXT: PageEntry[] = getDeveloperMaintenanceLinks("properties").map((item) => ({
  label: item.label,
  description: item.description,
  path: item.path,
  icon: ShieldCheck,
}));

/** Factory routes that aren't in FACTORY_NAV_SECTIONS but were historically in the palette. */
export const FACTORY_EXTRAS_ALWAYS: PageEntry[] = [
  // Daybook is pinned, so it is excluded from FACTORY_NAV_SECTIONS; retain search access.
  { label: "Factory Daybook", description: DESCRIPTIONS["/factory/daybook"], path: "/factory/daybook", icon: Calendar },
  { label: "Factory Chat", description: "Internal messaging", path: "/factory/chat", icon: MessageSquare },
  {
    label: "Bale Relabeling",
    description: DESCRIPTIONS["/factory/bale-relabeling"],
    path: "/factory/bale-relabeling",
    icon: Archive,
  },
];

/** Factory destinations whose standalone sidebar links are now contextual or pinned. */
export const FACTORY_CONTEXT_SEARCH: PageEntry[] = [
  { label: "Factory Overview", path: "/factory/production-report", icon: BarChart3 },
  { label: "Factory Agent Ledger", path: "/factory/agents", icon: Users },
  { label: "Factory Accounts", path: "/factory/accounts", icon: PieChart },
  { label: "Factory Vouchers", path: "/factory/vouchers", icon: FileText },
  { label: "Factory Contacts", path: "/factory/contacts", icon: Users },
  { label: "Factory Stock Allocation", path: "/factory/stock-allocation-v5", icon: Box },
  { label: "Factory Sheets & Sacks", path: "/factory/sheets-sacks", icon: Box },
  { label: "Factory Cost Centers", path: "/factory/cost-centers", icon: PieChart },
];
