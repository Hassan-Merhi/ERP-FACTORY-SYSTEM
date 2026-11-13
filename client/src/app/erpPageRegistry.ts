import { LayoutDashboard, ShoppingCart, Package, FileText, Layers, ListTree, BarChart3, FolderPlus, Wallet, Receipt, Book, UserCheck, PieChart, Ship, Calculator, TableProperties, ExternalLink, UserRound, ScrollText, Store, LayoutGrid, Handshake, Bot, ShieldCheck, Ticket, Replace, PackageMinus } from "lucide-react";
import { NAV_COLOR, type NavItem, type NavSection } from "@/components/sidebar/sidebarPrimitives";
import { supplierReturnsCopy } from "@/i18n/supplierReturnsTranslations";

/** Canonical metadata for ERP desktop, phone, and command navigation. */
export const ERP_PINNED_ITEMS: NavItem[] = [
  { title: "Tracking", url: "/tracking", icon: Ship },
  { title: "Dashboard", url: "/financial-overview", icon: LayoutDashboard },
  { title: "Agent Ledger", url: "/agents", icon: UserRound },
  { title: "Daybook", url: "/daybook", icon: Book },
  { title: "All Daybook", url: "/transaction-journal", icon: ScrollText },
  { title: "Vouchers", url: "/vouchers", icon: Receipt },
];


export const ERP_NAV_SECTIONS: NavSection[] = [
  {
    label: "Inventory",
    color: NAV_COLOR.inventory,
    items: [
      { title: "Inventory", url: "/inventory", icon: Layers },
      { title: "Stock", url: "/stock", icon: Package },
      { title: "Optional Vouchers", url: "/optional-vouchers", icon: FileText },
      { title: "Profit Check", url: "/supplier-profit-check", icon: Calculator },
    ],
  },
  {
    label: "Sales & POS",
    color: NAV_COLOR.sales,
    items: [
      { title: "POS", url: "/pos", icon: ShoppingCart },
      { title: "Sales Tools", url: "/sales-tools", icon: LayoutGrid },
    ],
  },
  {
    label: "Accounting",
    color: NAV_COLOR.accounting,
    items: [
      { title: "Accounts", url: "/accounts", icon: Wallet },
      { title: "Cost Centers", url: "/cost-centers", icon: ListTree },
      { title: "Parties", url: "/parties", icon: Handshake },
      { title: "Payroll", url: "/payroll", icon: UserCheck },
    ],
  },
  {
    label: "Accounting Tools",
    color: NAV_COLOR.accounting,
    devOnly: true,
    items: [{ title: "Accounting Toolbox", url: "/accounting/toolbox", icon: ShieldCheck }],
  },
  {
    label: "Analytics",
    color: NAV_COLOR.analytics,
    items: [
      { title: "Sales Report", url: "/sales-report", icon: PieChart },
      { title: "Analytics", url: "/analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Rentals",
    color: NAV_COLOR.rentals,
    items: [{ title: "Shops", url: "/erp/rental/shops", icon: Store }],
  },
  {
    label: "AI Tools",
    color: NAV_COLOR.analytics,
    devOnly: true,
    items: [
      { title: "AI Command Center", url: "/ai-command-center", icon: Bot },
      { title: "AI Validation", url: "/ai-validation", icon: ShieldCheck },
    ],
  },
  {
    label: "Others",
    color: NAV_COLOR.analytics,
    items: [
      { title: "Ticket Management", url: "/tickets", icon: Ticket },
      { title: "Supplier Profit Review", url: "/supplier-profit-reconciliation", icon: Calculator },
      { title: "Stock & Sales Report", url: "/stock-in-sales-report", icon: BarChart3 },
      { title: "Market Price Analysis", url: "/item-market-analysis", icon: BarChart3 },
      { title: "POS Item Replacement", url: "/pos-item-replacement", icon: Replace },
      { title: supplierReturnsCopy.en.tab, url: "/supplier-returns", icon: PackageMinus },
    ],
  },
];


export const ERP_UTILITY_ITEMS: NavItem[] = [
  { title: "Create", url: "/create", icon: FolderPlus },
  { title: "Spreadsheet", url: "/spreadsheet", icon: TableProperties },
  { title: "Live Sheets", url: "/live-sheets", icon: ExternalLink },
];


/** Primary phone navigation is defined here, not independently in a second menu. */
export type ErpPrimaryGroup = "tracking" | "inventory" | "sales" | "accounts";

export const ERP_MOBILE_PRIMARY_PATHS: Record<ErpPrimaryGroup, readonly string[]> = {
  tracking: ["/tracking"],
  inventory: ["/inventory", "/stock", "/optional-vouchers", "/supplier-profit-check"],
  sales: ["/pos", "/sales-tools", "/sales-report", "/stock-in-sales-report", "/pos-item-replacement"],
  accounts: [
    "/accounts", "/parties", "/daybook", "/transaction-journal",
    "/vouchers", "/agents", "/financial-overview", "/payroll",
  ],
};

const registryItems: readonly NavItem[] = [
  ...ERP_PINNED_ITEMS,
  ...ERP_NAV_SECTIONS.flatMap((section) => section.items),
  ...ERP_UTILITY_ITEMS,
];
const byUrl = new Map(registryItems.map((item) => [item.url, item]));

export function erpPrimaryGroupDestinations(group: ErpPrimaryGroup): Array<{ title: string; href: string }> {
  return ERP_MOBILE_PRIMARY_PATHS[group].flatMap((url) => {
    const item = byUrl.get(url);
    return item ? [{ title: item.title, href: item.url }] : [];
  });
}

/** For audits, tests and future feature-aware menu discovery. */
export function erpRegisteredNavigationUrls(): string[] {
  return [...new Set(registryItems.map((item) => item.url))];
}
