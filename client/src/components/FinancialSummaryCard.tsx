import { memo } from "react";
import { StatCard, type StatCardProps } from "@/components/StatCard";

export interface FinancialSummaryCardProps extends Omit<StatCardProps, "tone" | "value"> {
  amount: number | string;
  currency?: string;
  /** Money-flavored tone preset. */
  flow?: "revenue" | "expense" | "profit" | "loss" | "balance" | "receivable" | "payable";
  /** When true, formats `amount` using Intl.NumberFormat. Default true. */
  format?: boolean;
}

const FLOW_TONE: Record<NonNullable<FinancialSummaryCardProps["flow"]>, StatCardProps["tone"]> = {
  revenue: "success",
  expense: "warning",
  profit: "success",
  loss: "destructive",
  balance: "primary",
  receivable: "info",
  payable: "warning",
};

function formatAmount(amount: number | string, currency?: string): string {
  const num = typeof amount === "number" ? amount : parseFloat(amount);
  if (!Number.isFinite(num)) return String(amount);
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(num);
    } catch {
      // fall through to plain formatting
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num);
}

/**
 * FinancialSummaryCard — Accounting-themed StatCard. Maps accounting flows
 * (revenue/expense/profit/loss/etc.) to consistent tones and formats
 * monetary values.
 */
function FinancialSummaryCardComponent({
  amount,
  currency,
  flow = "balance",
  format = true,
  ...rest
}: FinancialSummaryCardProps) {
  const value = format ? formatAmount(amount, currency) : String(amount);
  return <StatCard tone={FLOW_TONE[flow]} value={value} {...rest} />;
}

export const FinancialSummaryCard = memo(FinancialSummaryCardComponent);
