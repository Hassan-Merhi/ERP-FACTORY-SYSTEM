// Extracted from ./SupplierStatement.tsx: balances and currency cards derived from a loaded statement.
import type { SupplierStatementProps } from "./SupplierStatement";

export function deriveSupplierStatementView({
  statementData,
  formatNum,
}: {
  statementData: NonNullable<SupplierStatementProps["statementData"]>;
  formatNum: SupplierStatementProps["formatNum"];
}) {
  const activeSt = (statementData.statement || []).filter((c) => c.status !== "OFFLOADED");
  const activeContainerCount = activeSt.length;
  const activeKg = activeSt.reduce((sum: number, c) => sum + parseFloat(c.actualReceivedKg || c.totalKg || "0"), 0);
  const currencyGroups = statementData.currencyGroups || [];

  const ownMap: Record<string, { own: number; totalFreight: number }> = {};
  for (const g of currencyGroups) {
    const cc = g.currencyCode;
    if (!ownMap[cc]) ownMap[cc] = { own: 0, totalFreight: 0 };
    ownMap[cc].own += parseFloat(g.netPayable || "0");
    ownMap[cc].totalFreight += parseFloat(g.totalFreight || "0");
  }

  const renderBalCard = (cc: string, bal: number, label: string, testId: string, freight?: number) => {
    const isOverpaid = bal < -0.005;
    const isSettled = Math.abs(bal) <= 0.005;
    const ccPrefix = cc !== "USD" ? `${cc} ` : "$";
    return (
      <div key={`${testId}-${cc}`} className="rounded-xl border p-4">
        <div className="text-xs text-muted-foreground font-medium">
          {cc} {label}
        </div>
        <div
          className={`text-xl font-bold mt-1 tabular-nums ${isSettled ? "text-muted-foreground" : isOverpaid ? "text-green-600 dark:text-green-400" : ""}`}
          data-testid={`${testId}-${cc}`}
        >
          {isSettled ? (
            <>
              {ccPrefix}— <span className="text-sm font-normal">Settled</span>
            </>
          ) : isOverpaid ? (
            <>
              {ccPrefix}
              {formatNum(String(Math.abs(bal).toFixed(2)))} <span className="text-sm font-normal">CR</span>
            </>
          ) : (
            <>
              {ccPrefix}
              {formatNum(String(bal.toFixed(2)))}
            </>
          )}
        </div>
        {freight && freight > 0.005 && (
          <div className="text-xs text-orange-600 dark:text-orange-400 mt-1">
            incl. {ccPrefix}
            {formatNum(String(freight.toFixed(2)))} freight
          </div>
        )}
      </div>
    );
  };

  return { activeContainerCount, activeKg, ownMap, renderBalCard };
}

export type SupplierStatementView = ReturnType<typeof deriveSupplierStatementView>;
