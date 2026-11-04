import type { RentalModule } from "../../routes/rental/shared";

/** A new Properties receipt is never automatically transferred out of its company. */
export function shouldRunRentalAutoTransfer(module: RentalModule): boolean {
  return module !== "PROPERTIES";
}

export const PROPERTIES_RENT_CASH_CODE = "PROP-RENT-CASH";

const PROPERTIES_RECEIPT_ACCOUNT_TYPES = ["Cash", "Bank", "Asset"] as const;

export function isPropertiesReceiptAccountType(accountType: string): boolean {
  return PROPERTIES_RECEIPT_ACCOUNT_TYPES.some((type) => type === accountType);
}

/** A cashbox starts with no balance and is scoped to exactly the selected company. */
export function propertiesRentCashboxSetupValues(companyId: number) {
  return {
    companyId,
    code: PROPERTIES_RENT_CASH_CODE,
    name: "Properties Rent Cashbox",
    accountType: "Cash" as const,
    subType: "Current Asset",
    openingBalance: "0",
    active: true,
    isHidden: false,
  };
}
