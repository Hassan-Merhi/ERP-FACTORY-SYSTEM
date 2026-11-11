export interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}

export interface Location {
  id: number;
  name: string;
  code?: string;
}

export interface ProformaLine {
  id: number;
  articleCode: string;
  productName: string;
  pricePerBale: string;
  pricingMode?: string;
  pricePerKg?: string | null;
}

export interface Proforma {
  id: number;
  customerId: number;
  name: string;
  isActive: boolean;
  lines: ProformaLine[];
}

export interface OrderBale {
  id: number;
  baleId: number;
  referenceNumber: string;
  articleCode: string;
  productName: string;
  weight: string;
  pricePerBale: string;
  totalPrice: string;
}

export interface OrderCharge {
  id: number;
  name: string;
  amount: string;
  chargeType: string;
  voucherId?: number | null;
  ledgerAccountId?: number | null;
}

export interface OrderDetail {
  id: number;
  customerId: number;
  companyId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  bales: OrderBale[];
  charges: OrderCharge[];
}
