/** Stable error descriptions for the intercompany stock verification contract. */
export const stockMatchingMessages = {
  sourceNotFound: "No uniquely verified Properties stock item for Excel row",
  codeAmbiguous: "Stock code or alias maps to multiple items",
  nameAmbiguous: "Stock name maps to multiple items",
  inactive: "Stock item is inactive or deleted",
  sourceMismatch: "Excel item name conflicts with the verified Properties stock item",
  destinationMismatch: "Destination stock identity conflicts with the Properties stock item",
  unitMismatch: "Stock unit mismatch",
  missingIdentity: "Verified Properties stock item requires a usable code, name and unit",
  rowDuplicate: "Duplicate physical container / workbook row identity",
  destinationInvalid: "ERP destination company is invalid",
  missingMapping: "Verified stock assignment is missing",
} as const;
