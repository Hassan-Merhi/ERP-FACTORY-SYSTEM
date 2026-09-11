import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Loader2, ArrowLeftRight } from "lucide-react";
import {
  insertUserSchema,
  insertCompanySchema,
  insertUserCompanyRoleSchema,
  type Company,
  type LedgerAccount,
} from "@shared/schema";
import type { SettingsIntercompanyPosConfig } from "./settingsTypes";
import { useCompany } from "@/contexts/CompanyContext";

const _userFormSchema = insertUserSchema;
const _companyFormSchema = insertCompanySchema;
const _roleAssignmentSchema = insertUserCompanyRoleSchema.refine(
  (data) => {
    // If role is POS, assignedLocationId must be present
    if (data.role === "POS" && !data.assignedLocationId) {
      return false;
    }
    return true;
  },
  {
    message: "POS roles require an assigned location",
    path: ["assignedLocationId"],
  }
);

type _UserFormData = z.infer<typeof _userFormSchema>;
type _CompanyFormData = z.infer<typeof _companyFormSchema>;
type _RoleAssignmentData = z.infer<typeof _roleAssignmentSchema>;

export function POSReceiptSettings() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-md border border-border bg-muted/30">
        <div className="flex-1">
          <div className="font-medium text-sm">Profit/Loss Comparison on POS Receipts</div>
          <div className="text-xs text-muted-foreground mt-1">
            All POS invoices automatically include P/L Bale and Total P/L columns showing profit or loss vs. configured
            price per item.
          </div>
        </div>
        <Badge variant="secondary" className="shrink-0">
          Always On
        </Badge>
      </div>
    </div>
  );
}

export function IntercompanyPosTab() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  // Current config
  const { data: config, isLoading: configLoading } = useQuery<SettingsIntercompanyPosConfig>({
    queryKey: ["/api/intercompany-pos-config", selectedCompany?.id],
  });

  // All companies (for dest company dropdown)
  const { data: allCompanies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  // Current company accounts (source interco account)
  const { data: srcAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
  });

  const [destCompanyId, setDestCompanyId] = useState<string>("");
  const [sourceIntercoAccountId, setSourceIntercoAccountId] = useState<string>("");
  const [destIntercoAccountId, setDestIntercoAccountId] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [skipSourceVoucher, setSkipSourceVoucher] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Dest company accounts
  const { data: destAccounts = [], isLoading: destAccountsLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/intercompany-pos-config/dest-accounts", destCompanyId],
    queryFn: async () => {
      if (!destCompanyId) return [];
      const res = await fetch(`/api/intercompany-pos-config/dest-accounts?companyId=${destCompanyId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load dest accounts");
      return res.json();
    },
    enabled: !!destCompanyId,
  });

  // Populate form when config loads
  useEffect(() => {
    if (config && !initialized) {
      setDestCompanyId(String(config.destCompanyId ?? ""));
      setSourceIntercoAccountId(String(config.sourceIntercoAccountId ?? ""));
      setDestIntercoAccountId(String(config.destIntercoAccountId ?? ""));
      setEnabled(config.enabled ?? true);
      setSkipSourceVoucher(config.skipSourceVoucher ?? false);
      setInitialized(true);
    }
    if (!config && !configLoading && !initialized) {
      setInitialized(true);
    }
  }, [config, configLoading, initialized]);

  // Reset dest interco account when dest company changes
  const prevDestCompanyId = useRef(destCompanyId);
  const isFirstDestCompanyChange = useRef(true);
  useEffect(() => {
    if (isFirstDestCompanyChange.current) {
      isFirstDestCompanyChange.current = false;
      prevDestCompanyId.current = destCompanyId;
      return;
    }
    if (destCompanyId !== prevDestCompanyId.current) {
      setDestIntercoAccountId("");
      prevDestCompanyId.current = destCompanyId;
    }
  }, [destCompanyId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/intercompany-pos-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          destCompanyId: parseInt(destCompanyId),
          sourceIntercoAccountId: parseInt(sourceIntercoAccountId),
          destIntercoAccountId: parseInt(destIntercoAccountId),
          enabled,
          skipSourceVoucher,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-pos-config"] });
      toast({ title: "Saved", description: "Intercompany POS transfer config saved." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const otherCompanies = allCompanies.filter((c) => c.id !== selectedCompany?.id);
  const canSave = destCompanyId && sourceIntercoAccountId && destIntercoAccountId;

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
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading config…</span>
            </div>
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
