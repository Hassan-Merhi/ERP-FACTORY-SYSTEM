// Extracted from ./GroupConsolidationAccounting.tsx to keep that module under the source-size cap.
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGroupConsolidationAccountingState } from "./useGroupConsolidationAccountingState";

export function GroupConsolidationAccountingCardSection2({
  filter,
  financialRows,
  includeZero,
  setFilter,
  setIncludeZero,
}: Pick<
  ReturnType<typeof useGroupConsolidationAccountingState>,
  "filter" | "financialRows" | "includeZero" | "setFilter" | "setIncludeZero"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Member GL trial balance at historical USD</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-3 items-center">
          <Input
            className="max-w-xs"
            placeholder="Search company, account, code or class"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="flex gap-2 items-center text-sm">
            <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> Show
            zero-balance lines
          </label>
        </div>
        <div className="max-h-[650px] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Company</th>
                <th className="p-2">Account</th>
                <th className="p-2">Class</th>
                <th className="p-2 text-right">Booked USD</th>
                <th className="p-2 text-right">Period movement</th>
                <th className="p-2 text-right">Elimination</th>
                <th className="p-2 text-right">Adjusted USD</th>
              </tr>
            </thead>
            <tbody>
              {financialRows.map((r, i) => (
                <tr
                  className="border-b align-top"
                  key={r.companyId + ":" + r.accountKind + ":" + r.accountId + ":" + i}
                >
                  <td className="p-2">{r.companyName}</td>
                  <td className="p-2">
                    {r.code ?? r.accountKind}: {r.name}
                    {r.openingSideAssumed && (
                      <div className="text-xs text-muted-foreground">Opening balance side was inferred</div>
                    )}
                  </td>
                  <td className="p-2">{r.financialClass}</td>
                  <td className="p-2 text-right tabular-nums">{r.bookedUsd}</td>
                  <td className="p-2 text-right tabular-nums">{r.periodMovementUsd}</td>
                  <td className="p-2 text-right tabular-nums">{r.eliminationUsd}</td>
                  <td className="p-2 text-right tabular-nums">{r.adjustedUsd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
