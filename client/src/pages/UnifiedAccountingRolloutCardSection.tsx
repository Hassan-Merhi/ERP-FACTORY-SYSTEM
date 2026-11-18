// Extracted from ./UnifiedAccountingRollout.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUnifiedAccountingRolloutState } from "./useUnifiedAccountingRolloutState";

export function UnifiedAccountingRolloutCardSection({
  changeMode,
  confirmation,
  launchReady,
  policyReason,
  selectedMode,
  selectedPolicy,
  setConfirmation,
  setPolicyReason,
}: Pick<
  ReturnType<typeof useUnifiedAccountingRolloutState>,
  | "changeMode"
  | "confirmation"
  | "launchReady"
  | "policyReason"
  | "selectedMode"
  | "selectedPolicy"
  | "setConfirmation"
  | "setPolicyReason"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Owner-governed company rollout</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          A metadata pilot would authorize only newly introduced matching, reconciliation, attribution and fiscal-review
          metadata routes after separate compatibility certification. The existing Cost Centers budget/attribution
          editors retain their own permissions and rollout controls. No setting here authorizes new financial GL
          posting, FX realization, inventory cutover, historical repairs or reviewed fiscal closing.
        </p>
        <p className="text-sm text-muted-foreground">
          Approved source revision: {selectedPolicy?.releaseSha ?? "None"}. Last decision:{" "}
          {selectedPolicy?.updatedAt ?? "Not configured"}.
        </p>
        <div>
          <Label>Owner's rollout decision and reason (10–1,000 characters)</Label>
          <Input
            value={policyReason}
            onChange={(e) => setPolicyReason(e.target.value)}
            placeholder="Why this company should enter or leave the metadata pilot"
          />
        </div>
        <div>
          <Label>Type APPROVE PILOT or RETURN READ ONLY</Label>
          <Input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="Exact confirmation phrase"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            disabled={
              !launchReady ||
              selectedMode === "METADATA_PILOT" ||
              confirmation !== "APPROVE PILOT" ||
              policyReason.trim().length < 10 ||
              changeMode.isPending
            }
            onClick={() => changeMode.mutate("METADATA_PILOT")}
          >
            Owner: approve metadata-only pilot
          </Button>
          <Button
            variant="outline"
            disabled={
              selectedMode === "READ_ONLY" ||
              confirmation !== "RETURN READ ONLY" ||
              policyReason.trim().length < 10 ||
              changeMode.isPending
            }
            onClick={() => changeMode.mutate("READ_ONLY")}
          >
            Owner: return to read-only
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Phase 15 deliberately keeps the new metadata writers locked until existing voucher-line replacement flows and
          metadata foreign keys are made compatible and independently certified. A pilot policy row cannot bypass this
          source-level safety gate. A future activation requires review of transaction-level approval-revocation races,
          not just a UI acknowledgement.
        </p>
        <p className="text-xs text-muted-foreground">
          If the deployed source SHA changes or any approval is revoked, the pilot writer gate fails closed at its next
          authorization check. Returning to read-only does not undo legitimate metadata. Existing ERP/Factory vouchers
          and other legacy business transactions continue under their normal posting and permissions.
        </p>
      </CardContent>
    </Card>
  );
}
