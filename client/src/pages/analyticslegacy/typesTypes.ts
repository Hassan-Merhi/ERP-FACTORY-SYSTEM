// Extracted from ./types.ts

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
  /** Charges added when the container was offloaded, excluding PO charges already in grandTotal. */
  offloadingCharges: string;
  /** Live active vouchers when present; otherwise persisted offload components. */
  chargeBreakdown: {
    duties: string;
    officeCharges: string;
    transportFees: string;
    transferCharges: string;
    additionalCharges: string;
  };
  /** Complete landed amount: original container grand total + offloading charges. */
  totalContainerCost: string;
  companyId: number;
  companyName: string;
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
