import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/page-state";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { Loader2, ArrowLeftRight } from "lucide-react";
import { useIntercompanyPosTabState } from "./useIntercompanyPosTabState";

export function IntercompanyPosTab() {
  const {
    configLoading,
    config,
    srcAccounts,
    destCompanyId,
    setDestCompanyId,
    sourceIntercoAccountId,
    setSourceIntercoAccountId,
    destIntercoAccountId,
    setDestIntercoAccountId,
    enabled,
    setEnabled,
    skipSourceVoucher,
    setSkipSourceVoucher,
    destAccountsLoading,
    destAccounts,
    saveMutation,
    rebuildFrom,
    setRebuildFrom,
    rebuildTo,
    setRebuildTo,
    rebuildMutation,
    otherCompanies,
    canSave,
  } = useIntercompanyPosTabState();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ArrowLeftRight className="h-5 w-5" />
        <h2 className="text-2xl font-semibold">POS Auto-Transfer</h2>
      </div>
      <p className="text-muted-foreground text-sm">
        When enabled, each cash POS sale in this company automatically creates a consolidated journal voucher
        transferring the sale amount to the intercompany account. A mirror voucher is created in the destination
        company.
      </p>

      <Card>
        <CardContent className="pt-6 space-y-5">
          {configLoading ? (
            <LoadingState title="Loading config…" />
          ) : (
            <>
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Enable auto-transfer</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When off, no vouchers are created for POS sales.
                  </p>
                </div>
                <Switch data-testid="switch-interco-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>

              {/* Skip source voucher toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Skip source company voucher</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Only create the mirror entry in the destination company. Use for SP companies so the intercompany
                    credit does not reduce Cash in the source Net Position.
                  </p>
                </div>
                <Switch
                  data-testid="switch-interco-skip-source"
                  checked={skipSourceVoucher}
                  onCheckedChange={setSkipSourceVoucher}
                />
              </div>

              {/* Dest company */}
              <div className="space-y-1.5">
                <Label>Destination Company</Label>
                <Select value={destCompanyId} onValueChange={setDestCompanyId} data-testid="select-dest-company">
                  <SelectTrigger data-testid="select-dest-company-trigger">
                    <SelectValue placeholder="Select destination company…" />
                  </SelectTrigger>
                  <SelectContent>
                    {otherCompanies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)} data-testid={`option-dest-company-${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">The company that receives the mirrored journal entry.</p>
              </div>

              {/* Source interco account */}
              <div className="space-y-1.5">
                <Label>Source Intercompany Account (this company)</Label>
                <Select
                  value={sourceIntercoAccountId}
                  onValueChange={setSourceIntercoAccountId}
                  data-testid="select-src-account"
                >
                  <SelectTrigger data-testid="select-src-account-trigger">
                    <SelectValue placeholder="Select account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {srcAccounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)} data-testid={`option-src-account-${a.id}`}>
                        {a.name} <span className="text-muted-foreground text-xs ml-1">({a.accountType})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Debited in the source company journal (intercompany receivable / due-from account).
                </p>
              </div>

              {/* Dest interco account */}
              <div className="space-y-1.5">
                <Label>Destination Intercompany Account (destination company)</Label>
                {!destCompanyId ? (
                  <p className="text-xs text-muted-foreground italic">Select a destination company first.</p>
                ) : (
                  <Select
                    value={destIntercoAccountId}
                    onValueChange={setDestIntercoAccountId}
                    data-testid="select-dest-account"
                  >
                    <SelectTrigger data-testid="select-dest-account-trigger">
                      <SelectValue placeholder={destAccountsLoading ? "Loading…" : "Select account…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {destAccounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)} data-testid={`option-dest-account-${a.id}`}>
                          {a.name} <span className="text-muted-foreground text-xs ml-1">({a.accountType})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-muted-foreground">
                  Credited in the destination company journal (intercompany payable / due-to account).
                </p>
              </div>

              <div className="pt-2">
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={!canSave || saveMutation.isPending}
                  data-testid="button-save-interco-config"
                >
                  {saveMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save Configuration"
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {config?.enabled && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm font-medium">Rebuild intercompany journals</p>
            <p className="text-xs text-muted-foreground">
              Rebuilds this company&apos;s intercompany POS journals from its cash sales for each date in the range. Use
              it to repair dates where the destination company&apos;s side is missing.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="interco-rebuild-from">From</Label>
                <Input
                  id="interco-rebuild-from"
                  type="date"
                  value={rebuildFrom}
                  onChange={(event) => setRebuildFrom(event.target.value)}
                  data-testid="input-interco-rebuild-from"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="interco-rebuild-to">To</Label>
                <Input
                  id="interco-rebuild-to"
                  type="date"
                  value={rebuildTo}
                  onChange={(event) => setRebuildTo(event.target.value)}
                  data-testid="input-interco-rebuild-to"
                />
              </div>
              <Button
                variant="outline"
                onClick={() => rebuildMutation.mutate()}
                disabled={!rebuildFrom || !rebuildTo || rebuildMutation.isPending}
                data-testid="button-interco-rebuild"
              >
                {rebuildMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Rebuild
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {config && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium mb-3">Current Configuration</p>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Status:{" "}
                <span className={config.enabled ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                  {config.enabled ? "Enabled" : "Disabled"}
                </span>
              </p>
              <p>Destination company ID: {config.destCompanyId}</p>
              <p>Source interco account ID: {config.sourceIntercoAccountId}</p>
              <p>Dest interco account ID: {config.destIntercoAccountId}</p>
              <p>
                Skip source voucher:{" "}
                <span className={config.skipSourceVoucher ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                  {config.skipSourceVoucher ? "Yes (dest-only mode)" : "No"}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
