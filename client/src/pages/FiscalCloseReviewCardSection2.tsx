// Extracted from ./FiscalCloseReview.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useFiscalCloseReviewState } from "./useFiscalCloseReviewState";

export function FiscalCloseReviewCardSection2({
  changePolicy,
  policy,
  policyConfirm,
  policyReason,
  setPolicyConfirm,
  setPolicyReason,
}: Pick<
  ReturnType<typeof useFiscalCloseReviewState>,
  "changePolicy" | "policy" | "policyConfirm" | "policyReason" | "setPolicyConfirm" | "setPolicyReason"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reviewed-close enforcement (Owner only)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {policy.isError && <p className="text-destructive text-sm">{(policy.error as Error).message}</p>}
        {policy.data && (
          <>
            <p className="font-medium text-sm">
              {policy.data.enforceReviewedClose
                ? "Required: every new close must use the dual-reviewed path"
                : "Compatibility mode: the original close endpoint is still permitted"}
            </p>
            <p className="text-xs text-muted-foreground">
              Defaults to compatibility mode for existing companies. A signed Owner change is audited. Reopening remains
              a separate, reason-required Admin action.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Owner reason for policy change</Label>
                <Input
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                  placeholder="Explain why the fiscal-close requirement changes"
                />
              </div>
              <div>
                <Label>Type POLICY CHANGE to confirm</Label>
                <Input
                  value={policyConfirm}
                  onChange={(e) => setPolicyConfirm(e.target.value)}
                  placeholder="POLICY CHANGE"
                />
              </div>
            </div>
            <Button
              variant="outline"
              disabled={policyReason.trim().length < 10 || policyConfirm !== "POLICY CHANGE" || changePolicy.isPending}
              onClick={() => changePolicy.mutate(!policy.data!.enforceReviewedClose)}
            >
              {policy.data.enforceReviewedClose
                ? "Disable mandatory reviewed-close (Owner)"
                : "Require independent reviewed-close (Owner)"}
            </Button>
            {policy.data.updatedAt && (
              <p className="text-xs text-muted-foreground">
                Last change: {policy.data.updatedAt} · {policy.data.reason}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FiscalCloseReviewCardSection3({
  history,
}: Pick<ReturnType<typeof useFiscalCloseReviewState>, "history">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded reviewed fiscal closes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {history.isError && (
          <p role="alert" className="text-sm text-destructive">
            {(history.error as Error).message}
          </p>
        )}
        <div className="max-h-[540px] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Recorded</th>
                <th className="p-2">Closure / voucher</th>
                <th className="p-2">Accounting reviewer</th>
                <th className="p-2">Owner reviewer</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.reviewedClosures.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="p-2">{item.certified_at}</td>
                  <td className="p-2">
                    Closure #{item.fiscal_closure_id ?? "reopened"}
                    <div className="text-xs">Voucher #{item.closing_voucher_id}</div>
                  </td>
                  <td className="p-2">{item.accounting_reviewer}</td>
                  <td className="p-2">{item.owner_reviewer}</td>
                  <td className="p-2">{item.currently_closed ? "Closed" : "Reopened / no longer active"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
