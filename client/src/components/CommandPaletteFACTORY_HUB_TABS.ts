// Extracted from ./CommandPalette.tsx to keep that module under the source-size cap.
import {
  AlertTriangle,
  Archive,
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  Box,
  Calendar,
  FileText,
  HardHat,
  Link as LinkIcon,
  PieChart,
  Settings,
  ShieldCheck,
  Ship,
  Trash2,
  Truck,
  Users,
  Wrench,
} from "lucide-react";
import { DESCRIPTIONS, type PageEntry } from "./CommandPaletteDESCRIPTIONS";

/** Factory hub tab entries — each tab in a hub page gets its own searchable entry. */
export const FACTORY_HUB_TABS: PageEntry[] = [
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

export const PROPERTIES_EXTRAS: PageEntry[] = [
  { label: "Properties Daybook", description: "Daily transaction log", path: "/properties/daybook", icon: Calendar },
  { label: "Properties Analytics", description: "Properties analytics", path: "/properties/analytics", icon: PieChart },
  { label: "Rental Shops", description: "Shops rented out", path: "/properties/rentals?tab=shops", icon: Users },
  {
    label: "Rental Payments",
    description: "Rentals payment log",
    path: "/properties/rentals?tab=payments",
    icon: FileText,
  },
  { label: "My Settings", description: "Personal preferences", path: "/properties/my-settings", icon: Settings },
];

export const PROPERTIES_DEVELOPER_EXTRAS: PageEntry[] = [
  {
    label: "Cash Transfer",
    description: "Transfer funds between properties",
    path: "/properties/transfer",
    icon: ArrowLeftRight,
  },
];

export const PROPERTIES_ADMIN_EXTRAS: PageEntry[] = [
  {
    label: "Properties Settings",
    description: "Properties module configuration",
    path: "/properties/settings",
    icon: Settings,
  },
];

export const adminPages: PageEntry[] = [
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

// These are registered in the Factory shell; ERP-only admin paths otherwise
// redirect to the Factory default page before their component can render.
export const factoryAdminPages: PageEntry[] = [
  { label: "Factory Settings", description: "Factory configuration", path: "/factory/settings", icon: Settings },
  {
    label: "Factory Chatbot Settings",
    description: "Factory chatbot configuration",
    path: "/factory/chatbot-settings",
    icon: Bot,
  },
  {
    label: "Deleted Items",
    description: "Restore or review deleted Factory records",
    path: "/factory/deleted-items",
    icon: Trash2,
  },
  {
    label: "Orphaned Records",
    description: "Factory records missing references",
    path: "/factory/orphaned-records",
    icon: LinkIcon,
  },
  {
    label: "Inventory Repair",
    description: "Investigate Factory inventory discrepancies",
    path: "/factory/inventory-repair",
    icon: Wrench,
  },
  {
    label: "Import Cycle Diagnostics",
    description: "Inspect Factory import issues",
    path: "/factory/import-cycle-diagnostics",
    icon: AlertTriangle,
  },
  {
    label: "Account Groups",
    description: "Factory account group settings",
    path: "/factory/account-groups",
    icon: PieChart,
  },
  {
    label: "Company Data Reset",
    description: "Restricted Factory maintenance",
    path: "/factory/company-data-reset",
    icon: Wrench,
  },
];
