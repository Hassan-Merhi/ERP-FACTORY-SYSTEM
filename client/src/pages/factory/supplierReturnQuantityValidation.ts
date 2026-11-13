/** Match the ERP supplier-return API's positive three-decimal quantity contract. */
export function isValidSupplierReturnQuantity(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value) && Number(value) > 0;
}
