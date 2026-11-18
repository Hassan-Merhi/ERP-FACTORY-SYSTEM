// Extracted from ./FactoryContainers.tsx to keep that module under the source-size cap.

/** Row shape produced by the Excel import mapper below and posted to import-excel. */
export interface ContainerImportRow {
  containerNumber: string;
  supplierName: string;
  origin: string;
  totalKg: string;
  ratePerKg: string;
  currencyCode: string;
  fxRateToUsd: string;
  fxSource: string;
  arrivalDate: string;
  notes: string;
  status: string;
  commissionAmount: string;
  commissionCurrencyCode: string;
}
