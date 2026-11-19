// Extracted from ./useFactorySettingsModelPart1.ts

export type OcContainer = {
  containerId: number;
  containerNumber: string;
  charges: { id: number; description: string; amount: string; currencyCode: string }[];
};

export type BaleValidationResult = {
  totalRows: number;
  validRows: {
    rowIndex: number;
    articleCode: string;
    productName: string;
    productId: number;
    quantity: number;
    weight: number;
    productionDate: string;
  }[];
  skippedRows: { rowIndex: number; articleCode: string; reason: string }[];
  totalBales: number;
  totalWeight: number;
  totalProducts: number;
};
