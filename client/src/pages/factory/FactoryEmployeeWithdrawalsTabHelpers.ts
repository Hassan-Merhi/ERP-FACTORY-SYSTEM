// Extracted from ./FactoryEmployeeWithdrawalsTab.tsx

export interface Employee {
  id: number;
  code: string | null;
  firstName: string;
  lastName: string;
  currentBalance: string;
}

export interface CashAccount {
  id: number;
  name: string;
  code: string;
}

export function fmt(v: string | number | null | undefined) {
  const n = parseFloat(String(v || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const today = () => new Date().toLocaleDateString("en-CA");
