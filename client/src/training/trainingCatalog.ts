/**
 * End-user reference guides. These describe workflows, not permissions or
 * confidential data. Actual tutorials are produced by the sandbox recorder
 * and only attached after review and publication.
 */
export type TrainingMode = "erp" | "factory" | "properties" | "pos";
/** Curated guides use these; generated topics take the sidebar section label. */
export type TrainingCategory = string;
export interface TrainingTopic {
  id: string;
  title: string;
  category: TrainingCategory;
  description: string;
  mode: TrainingMode | "both";
  accessKey?: string;
  route?: string;
  steps: readonly string[];
  /** Tabs on this page the current user may open (generated topics only). */
  tabs?: readonly string[];
  keywords?: readonly string[];
}

export const TRAINING_TOPICS: readonly TrainingTopic[] = [
  {
    id: "welcome",
    title: "Getting started",
    category: "Getting started",
    mode: "both",
    description: "Sign in, select your company, choose ERP or Factory Mode, and find your pages.",
    steps: [
      "Sign in with the credentials your administrator provided.",
      "Use the company selector to confirm which company you are working in.",
      "Select the ERP or Factory Mode and review the pages in the sidebar.",
      "Use only pages your administrator has enabled for your account.",
    ],
    keywords: ["login", "company", "sidebar", "permissions"],
  },
  {
    id: "factory-overview",
    title: "Factory overview",
    category: "Getting started",
    mode: "factory",
    accessKey: "factory/production-report",
    route: "/factory/production-report",
    description: "Understand production summaries and move to the correct Factory work area.",
    steps: [
      "Open Overview in Factory Mode.",
      "Review the available production summaries and their reporting period.",
      "Use the sidebar to open the related production or inventory workflow.",
    ],
  },
  {
    id: "factory-stock-entry",
    title: "Stock entry and bale production",
    category: "Production",
    mode: "factory",
    accessKey: "factory/stock-entry",
    route: "/factory/stock-entry",
    description: "Learn where production entries and bale information are recorded.",
    steps: [
      "Open Stock Entry and confirm the selected production context.",
      "Review the worker, product and quantity fields before making an entry.",
      "In a training company, enter sample production and review its result.",
      "Never finalize real production during a training demonstration.",
    ],
    keywords: ["bales", "workers", "scanning"],
  },
  {
    id: "factory-raw-materials",
    title: "Raw materials and costing",
    category: "Production",
    mode: "factory",
    accessKey: "factory/raw-materials",
    route: "/factory/raw-materials",
    description: "Find raw material stock, receipts and the related cost history.",
    steps: [
      "Open Raw Materials and select the relevant section.",
      "Verify supplier, received weight, currency and expense allocation before recording a receipt.",
      "Review the resulting average cost and inventory value in the training company.",
    ],
    keywords: ["supplier", "average cost", "weight"],
  },
  {
    id: "factory-bale-explorer",
    title: "Find and trace a bale",
    category: "Inventory",
    mode: "factory",
    accessKey: "factory/bales-hub",
    route: "/factory/bales-hub",
    description: "Locate bales, browse history and inspect the available traceability details.",
    steps: [
      "Open Bale Explorer.",
      "Use the available product, barcode or history search.",
      "Review the selected bale details and related production information.",
    ],
    keywords: ["barcode", "search", "bale"],
  },
  {
    id: "factory-containers",
    title: "Containers and loading",
    category: "Inventory",
    mode: "factory",
    accessKey: "factory/containers-hub",
    route: "/factory/containers-hub",
    description: "Understand container records, loading progress and verification.",
    steps: [
      "Open Containers.",
      "Locate a sample container and review its details.",
      "Review the loading and verification stages; use a disposable training container for changes.",
      "Confirm quantities and status before any real finalization.",
    ],
    keywords: ["loading", "verification"],
  },
  {
    id: "factory-stock-allocation",
    title: "Stock allocation and proformas",
    category: "Sales",
    mode: "factory",
    accessKey: "factory/stock-allocation-v5",
    route: "/factory/stock-allocation-v5",
    description: "Find stock allocation and understand the customer proforma workflow.",
    steps: [
      "Open Stock Allocation and use filters to find the sample items.",
      "Review item quantities, assigned customer and agreed prices.",
      "In a training company, inspect the create/edit proforma flow and check totals.",
    ],
    keywords: ["proforma", "pricing", "customer"],
  },
  {
    id: "factory-invoicing",
    title: "Factory sales and invoicing",
    category: "Sales",
    mode: "factory",
    accessKey: "factory/invoicing",
    route: "/factory/invoicing",
    description: "Follow invoicing from a customer sales record through verification.",
    steps: [
      "Open Invoicing and choose the relevant section.",
      "Review sample invoice items, quantities, customer and prices.",
      "Understand verification and finalization before posting any live transaction.",
    ],
    keywords: ["invoice", "sales"],
  },
  {
    id: "factory-payroll",
    title: "Workers, attendance and payroll",
    category: "People",
    mode: "factory",
    accessKey: "factory/payroll-hub",
    route: "/factory/payroll-hub",
    description: "Find worker records, attendance, payroll and benefits.",
    steps: [
      "Open Payroll & Benefits.",
      "Select the worker or attendance section available to your role.",
      "Review sample entries and the relevant approval requirements.",
      "Use the training company for payroll changes, not the live ledger.",
    ],
    keywords: ["attendance", "bonus", "workers"],
  },
  {
    id: "factory-accounts",
    title: "Factory accounts and vouchers",
    category: "Finance",
    mode: "factory",
    accessKey: "factory/accounts",
    route: "/factory/accounts",
    description: "Understand account balances, transactions and financial history.",
    steps: [
      "Open Accounts and select a sample account.",
      "Review its balance and the date filters.",
      "Open the corresponding voucher or statement where you have permission.",
      "Never create a balancing entry merely to demonstrate the interface.",
    ],
    keywords: ["ledger", "customer", "supplier"],
  },
  {
    id: "factory-analytics",
    title: "Factory analytics",
    category: "Reports",
    mode: "factory",
    accessKey: "factory/analytics",
    route: "/factory/analytics",
    description: "Interpret the dashboards, date filters and financial or production KPIs.",
    steps: [
      "Open Analytics and select a reporting period.",
      "Check the displayed KPI definitions before comparing values.",
      "Use filters to inspect the same metric for another period.",
    ],
    keywords: ["kpi", "dashboard"],
  },
  {
    id: "erp-tracking",
    title: "ERP tracking",
    category: "Getting started",
    mode: "erp",
    route: "/tracking",
    description: "Find current tracking information and navigate the ERP sidebar.",
    steps: [
      "Open Tracking from the ERP sidebar.",
      "Choose the available tracking section.",
      "Use search and filters to locate the relevant record.",
    ],
  },
  {
    id: "erp-inventory",
    title: "ERP inventory and stock",
    category: "Inventory",
    mode: "erp",
    accessKey: "location_inventory",
    route: "/inventory",
    description: "Navigate inventory views, locations and available stock records.",
    steps: [
      "Open Inventory.",
      "Select the available inventory view or location filter.",
      "Review quantities and item details before any stock movement.",
    ],
    keywords: ["stock", "locations"],
  },
  {
    id: "erp-pos",
    title: "Point of sale",
    category: "Sales",
    mode: "erp",
    accessKey: "pos",
    route: "/pos",
    description: "See how to find products and review a sale before confirmation.",
    steps: [
      "Open POS in a training company.",
      "Find sample items and review quantity and price.",
      "Review the confirmation stage without creating live sales.",
    ],
    keywords: ["checkout", "sale"],
  },
  {
    id: "erp-vouchers",
    title: "Vouchers and accounting",
    category: "Finance",
    mode: "erp",
    accessKey: "vouchers",
    route: "/vouchers",
    description: "Understand voucher types, balanced entries and audit history.",
    steps: [
      "Open Vouchers and locate a sample voucher.",
      "Review its account, debit, credit and date.",
      "Use the disposable training company to practice voucher creation.",
      "Check the resulting Daybook and account balances in the training company.",
    ],
    keywords: ["journal", "debit", "credit"],
  },
  {
    id: "erp-daybook",
    title: "Daybook and transaction history",
    category: "Finance",
    mode: "erp",
    accessKey: "daybook",
    route: "/daybook",
    description: "Search transaction history and understand what has been posted.",
    steps: [
      "Open Daybook.",
      "Set a date range and find a sample transaction.",
      "Open the corresponding voucher or account details when available.",
    ],
    keywords: ["audit", "history"],
  },
  {
    id: "erp-reports",
    title: "Sales reports and analytics",
    category: "Reports",
    mode: "erp",
    accessKey: "sales_report",
    route: "/sales-report",
    description: "Review reporting periods, filters and totals.",
    steps: [
      "Open Sales Report and select the reporting period.",
      "Apply the available filters.",
      "Check displayed quantities and totals against the selected scope.",
    ],
    keywords: ["kpi", "sales", "analytics"],
  },
] as const;
