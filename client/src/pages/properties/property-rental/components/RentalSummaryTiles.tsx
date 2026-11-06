/**
 * Desktop/tablet summary tiles for the rental pages: six equal tiles (the
 * former Outstanding/Credit pair overflowed its card at tablet widths).
 * Extracted from PropertyRentalPage.tsx to keep it under the 900-line cap.
 */
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtMoney } from "../utils";

interface Props {
  testIdPrefix: string;
  unitCount: number;
  totals: {
    totalMonthlyRent: number;
    totalGuarantee: number;
    totalPaid: number;
    totalOwed: number;
    totalCredit: number;
  };
  isPropertiesRental: boolean;
  paidLabel: ReactNode;
  paidValue: ReactNode;
}

export function RentalSummaryTiles({
  testIdPrefix,
  unitCount,
  totals,
  isPropertiesRental,
  paidLabel,
  paidValue,
}: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">TOTAL UNITS</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div className="text-lg font-bold" data-testid={`stat-${testIdPrefix}-total-units`}>
            {unitCount}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">RENT / MONTH</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div
            className="text-lg font-bold text-blue-600 dark:text-blue-400"
            data-testid={`stat-${testIdPrefix}-monthly-rent`}
          >
            ${fmtMoney(totals.totalMonthlyRent)}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">expected from active leases</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
            {isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div
            className={`text-lg font-bold ${isPropertiesRental ? "text-red-600 dark:text-red-400" : ""}`}
            data-testid={`stat-${testIdPrefix}-total-guarantee`}
          >
            ${fmtMoney(totals.totalGuarantee)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">{paidLabel}</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div
            className={`text-lg font-bold ${totals.totalPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}
            data-testid={`stat-${testIdPrefix}-total-paid`}
          >
            {paidValue}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
            {isPropertiesRental ? "TO COLLECT" : "OUTSTANDING"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div
            className={`text-lg font-bold ${isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
            data-testid={`stat-${testIdPrefix}-total-outstanding`}
          >
            ${fmtMoney(totals.totalOwed)}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {isPropertiesRental ? "tenants owe you" : "owed by tenants"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="px-3 pt-3 pb-1">
          <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
            {isPropertiesRental ? "OWED TO TENANTS" : "CREDIT"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <div
            className={`text-lg font-bold ${isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
            data-testid={`stat-${testIdPrefix}-total-credit`}
          >
            ${fmtMoney(totals.totalCredit)}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {isPropertiesRental ? "tenant prepayments / overpayments" : "advance / overpaid"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
