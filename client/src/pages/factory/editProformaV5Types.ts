/**
 * Row and line shapes shared by the Edit Proforma V5 drawer and its mobile lines.
 */
export interface ArticleRow {
  articleCode: string;
  productName: string;
  categoryName?: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
}

export interface ExistingLine {
  id: number;
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
  weightPerBaleKg: string;
  pricingMode?: string;
  pricePerKg?: string | null;
}

export interface ProformaData {
  id: number;
  companyId: number;
  name: string;
  isActive: boolean;
  customerId: number;
  destination?: string | null;
  lines: ExistingLine[];
}

export interface AgreedPriceRow {
  article_code: string;
  price_per_bale: string;
}

export interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  weightPerBaleKg: string | null;
  sellingPrice: string | null;
  productionPrice: string | null;
}
