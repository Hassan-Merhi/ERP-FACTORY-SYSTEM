/**
 * Types for the AnalyticsLegacy page.
 *
 * Extracted from AnalyticsLegacy.tsx during the Phase 4 god-file split.
 */

export // Type definitions
interface Account {
  id: string;
  accountId: number;
  type: string;
  code: string;
  name: string;
  accountType?: string;
  subType?: string;
  balance: number;
  balanceSide: string | null;
  active: boolean;
  parentId?: number;
  customerId?: number;
}

export interface LocationSales {
  locationId: number;
  locationName: string;
  locationCode: string;
  totalSales: number;
  totalTransactions: number;
  totalQuantity: number;
}

export interface FactorySalesByCustomer {
  customerId: number | null;
  customerName: string | null;
  containers: number;
  totalAmount: string;
  paidAmount: string;
}

export interface FactoryPosCustomerSummary {
  customerId: number | null;
  customerName: string;
  sales: number;
  totalAmount: string;
  cashSales: string;
  creditSales: string;
  depositAmount: string;
}

export interface FactoryPosSummary {
  byCustomer?: FactoryPosCustomerSummary[];
  grand?: FactoryPosCustomerSummary;
}

export interface FactoryContainerSalesData {
  summary: {
    count: number;
    total: number;
    paid: number;
    outstanding: number;
  };
  rows: Array<{
    id: number;
    containerNumber?: string | null;
    customerId: number | null;
    customerName?: string | null;
    invoiceNumber?: string | null;
    saleDate: string;
    containerStatus?: string | null;
    paymentStatus: string;
    totalAmount: string;
    paidAmount: string;
  }>;
}

export interface POSTransaction {
  id: number;
  voucherNumber: string;
  voucherDate: string;
  createdAt: string;
  description: string | null;
  customerName: string | null;
  cashAccountName: string | null;
  totalAmount: number;
  totalQuantity: number;
  itemCount: number;
  items: unknown[];
}

export interface StockLocation {
  locationId: number;
  locationName: string;
  quantity: number;
  averageRate: number;
  totalValue: number;
}

export interface StockMovementItem {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  locations: StockLocation[];
  totalQuantity: number;
  totalValue: number;
}

export interface StockMovementData {
  items: StockMovementItem[];
  summary: {
    totalItems: number;
    grandTotalQuantity: number;
    grandTotalValue: number;
  };
  filters: {
    startDate: string | null;
    endDate: string | null;
    locationId: string | null;
    stockGroupId: string | null;
  };
}

export interface Container {
  id: number;
  containerNumber: string;
  supplierName: string;
  status: string;
  importDate: string;
  offloadDate: string | null;
  itemsTotal: string;
  chargesTotal: string;
  grandTotal: string;
}

export interface ReportContainer {
  id: number;
  containerNumber: string;
  supplierId: number;
  supplierName: string;
  status: string;
  importDate: string | null;
  offloadDate: string | null;
  itemsTotal: string;
  chargesTotal: string;
  grandTotal: string;
  companyId: number;
  companyName: string;
}

export interface ContainerData {
  containers: ReportContainer[];
  summary: {
    totalContainers: number;
    totalItemsTotal: number;
    totalChargesTotal: number;
    totalGrandTotal: number;
  };
  filters: {
    startDate: string | null;
    endDate: string | null;
    supplierId: string | null;
    status: string | null;
  };
}

export interface Location {
  id: number;
  code: string;
  name: string;
}

export interface StockGroup {
  id: number;
  code: string;
  name: string;
}

export interface Supplier {
  id: number;
  code: string;
  legalName: string;
}

export interface OpeningStockGroup {
  id: number;
  code: string;
  name: string;
  opening: {
    quantity: number;
    rate: number;
    value: number;
  };
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
  itemCount: number;
}

export interface OpeningStockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  opening: {
    quantity: number;
    rate: number;
    value: number;
  };
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
}

export interface OpeningStockSummaryData {
  stockGroups: OpeningStockGroup[];
  grandTotal: {
    opening: { quantity: number; value: number };
    closing: { quantity: number; value: number };
  };
  filters: {
    locationId: string | null;
  };
  notes?: {
    opening: string;
    closing: string;
  };
}

export interface OpeningStockItemsData {
  items: OpeningStockItem[];
  totals: {
    opening: { quantity: number; value: number };
    closing: { quantity: number; value: number };
  };
}

export interface NetProfitAccount {
  id: number;
  code: string;
  name: string;
  debit: number;
  credit: number;
  balance: number;
  parentId?: number;
}

export interface NetProfitStatementData {
  netPosition: number;
  openingBalancesNet?: number | null;
  leftPane: {
    openingStock: {
      value: number;
    };
    purchaseAccounts: {
      total: number;
      accounts: NetProfitAccount[];
      count: number;
    };
    directExpenses: {
      total: number;
      accounts: NetProfitAccount[];
      count: number;
    };
    tradingTotal: number;
    grossProfit: number;
    indirectExpenses: {
      total: number;
      accounts: NetProfitAccount[];
      count: number;
    };
    netProfit: number;
  };
  rightPane?: {
    salesAccounts: {
      total: number;
    };
    directIncomes: {
      total: number;
      accounts: NetProfitAccount[];
      count: number;
    };
    closingStock: {
      value: number;
    };
    tradingTotal: number;
    grossProfitBf: number;
    indirectIncomes: {
      total: number;
      accounts: NetProfitAccount[];
      count: number;
    };
    total: number;
  };
}
