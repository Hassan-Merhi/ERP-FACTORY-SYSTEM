/** Stable error descriptions; route consumers can translate using the error code. */
export const tradingProvisioningMessages = {
  duplicateSupplier: "Multiple Properties-named suppliers exist in destination; resolve duplicates before setup",
  inactiveSupplier: "Properties-named destination supplier is inactive or deleted; reactivate it before setup",
  ambiguousSupplier: "Ambiguous destination supplier",
} as const;
