import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BadgePercent, Save, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { RetailNav } from "./RetailNav";
import {
  createRetailPromotion,
  deactivateRetailPromotion,
  fetchRetailSellingSettings,
  listRetailPromotions,
  saveRetailSellingSettings,
} from "@/pages/pos/retailWave2Api";
import type { RetailPromotion, RetailSellingSettings } from "@/pages/pos/retailWave2Types";

/**
 * Retail selling settings: VAT/tax behaviour, discount limits and the lightweight
 * promotion list. Tax stays disabled until a company turns it on, so existing
 * retail companies keep the exact pre-Wave-2 prices.
 */
export default function RetailSellingSettings() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const [form, setForm] = useState<RetailSellingSettings | null>(null);
  const [promotion, setPromotion] = useState({
    name: "",
    discountType: "percent" as "percent" | "fixed",
    value: "",
    startsAt: "",
    endsAt: "",
  });

  const settingsQuery = useQuery({
    queryKey: ["retail-selling-settings", selectedCompany?.id],
    queryFn: fetchRetailSellingSettings,
    enabled: retailEnabled,
  });

  const promotionsQuery = useQuery({
    queryKey: ["retail-promotions", selectedCompany?.id],
    queryFn: listRetailPromotions,
    enabled: retailEnabled,
  });

  useEffect(() => {
    if (settingsQuery.data) setForm({ ...settingsQuery.data });
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRetailSellingSettings({
        discountLimitPercent: form?.discountLimitPercent,
        requireManagerApproval: form?.requireManagerApproval,
        priceOverrideRequiresApproval: form?.priceOverrideRequiresApproval,
        taxEnabled: form?.taxEnabled,
        taxLabel: form?.taxLabel,
        taxRate: form ? form.taxRatePercent! / 100 : 0,
        taxInclusive: form?.taxInclusive,
      }),
    onSuccess: async (saved) => {
      setForm({ ...saved });
      await queryClient.invalidateQueries({ queryKey: ["retail-selling-settings"] });
      toast({ title: "Settings saved", description: "New checkouts use the updated policy immediately." });
    },
    onError: (error) => toast({ title: "Could not save settings", description: error.message, variant: "destructive" }),
  });

  const createPromotionMutation = useMutation({
    mutationFn: () =>
      createRetailPromotion({
        name: promotion.name.trim(),
        discountType: promotion.discountType,
        value: Number(promotion.value),
        startsAt: promotion.startsAt || null,
        endsAt: promotion.endsAt || null,
      }),
    onSuccess: async (created) => {
      setPromotion({ name: "", discountType: "percent", value: "", startsAt: "", endsAt: "" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-promotions"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      ]);
      toast({ title: "Promotion created", description: `${created.name} applies automatically at checkout.` });
    },
    onError: (error) =>
      toast({ title: "Could not create promotion", description: error.message, variant: "destructive" }),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => deactivateRetailPromotion(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-promotions"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      ]);
    },
    onError: (error) => toast({ title: "Could not deactivate", description: error.message, variant: "destructive" }),
  });

  if (!retailEnabled) return null;

  const settings = settingsQuery.data;
  const editable = settings?.canManageSettings !== false;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      <RetailNav />
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Settings2 className="h-6 w-6" /> Selling settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Tax, discount limits, and the promotions that apply automatically. Subtotal → Discount → Tax → Total is
          calculated from these settings on every sale, receipt and report.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Tax / VAT</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form?.taxEnabled ?? false}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, taxEnabled: event.target.checked } : current))
              }
              data-testid="retail-settings-tax-enabled"
            />
            Charge tax on retail sales
          </label>
          <div>
            <Label htmlFor="retail-tax-label">Tax label</Label>
            <Input
              id="retail-tax-label"
              value={form?.taxLabel ?? ""}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, taxLabel: event.target.value } : current))
              }
            />
          </div>
          <div>
            <Label htmlFor="retail-tax-rate">Rate %</Label>
            <Input
              id="retail-tax-rate"
              type="number"
              min="0"
              step="0.01"
              value={form?.taxRatePercent ?? 0}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) =>
                  current
                    ? {
                        ...current,
                        taxRatePercent: Number(event.target.value),
                        taxRate: Number(event.target.value) / 100,
                      }
                    : current
                )
              }
              data-testid="retail-settings-tax-rate"
            />
          </div>
          <label className="flex items-center gap-2 text-sm md:col-span-3">
            <input
              type="checkbox"
              checked={form?.taxInclusive ?? false}
              disabled={!form || !editable || !form?.taxEnabled}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, taxInclusive: event.target.checked } : current))
              }
              data-testid="retail-settings-tax-inclusive"
            />
            Shelf prices already include tax (tax is carved out of the total instead of added on top)
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Discount limits &amp; approvals</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <Label htmlFor="retail-discount-limit">Discount limit %</Label>
            <Input
              id="retail-discount-limit"
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={form?.discountLimitPercent ?? 0}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, discountLimitPercent: Number(event.target.value) } : current
                )
              }
              data-testid="retail-settings-discount-limit"
            />
            <p className="mt-1 text-xs text-muted-foreground">Above this, a manager must approve the discount.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form?.requireManagerApproval ?? true}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, requireManagerApproval: event.target.checked } : current))
              }
              data-testid="retail-settings-require-approval"
            />
            Require manager approval above the limit
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form?.priceOverrideRequiresApproval ?? true}
              disabled={!form || !editable}
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, priceOverrideRequiresApproval: event.target.checked } : current
                )
              }
              data-testid="retail-settings-override-approval"
            />
            Manual price overrides always need a manager
          </label>
          <div className="md:col-span-3">
            <Button
              disabled={!form || !editable || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              data-testid="retail-settings-save"
            >
              <Save className="mr-1 h-4 w-4" /> {saveMutation.isPending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <BadgePercent className="h-5 w-5" /> Promotions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 rounded-lg border p-3 md:grid-cols-6">
            <div className="md:col-span-2">
              <Label htmlFor="retail-promotion-name">Name</Label>
              <Input
                id="retail-promotion-name"
                value={promotion.name}
                onChange={(event) => setPromotion((current) => ({ ...current, name: event.target.value }))}
                data-testid="retail-promotion-name"
              />
            </div>
            <div>
              <Label htmlFor="retail-promotion-type">Type</Label>
              <select
                id="retail-promotion-type"
                value={promotion.discountType}
                onChange={(event) =>
                  setPromotion((current) => ({ ...current, discountType: event.target.value as "percent" | "fixed" }))
                }
                className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="percent">Percent</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div>
              <Label htmlFor="retail-promotion-value">Value</Label>
              <Input
                id="retail-promotion-value"
                type="number"
                min="0"
                step="0.01"
                value={promotion.value}
                onChange={(event) => setPromotion((current) => ({ ...current, value: event.target.value }))}
                data-testid="retail-promotion-value"
              />
            </div>
            <div>
              <Label htmlFor="retail-promotion-start">Starts</Label>
              <Input
                id="retail-promotion-start"
                type="date"
                value={promotion.startsAt}
                onChange={(event) => setPromotion((current) => ({ ...current, startsAt: event.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="retail-promotion-end">Ends</Label>
              <Input
                id="retail-promotion-end"
                type="date"
                value={promotion.endsAt}
                onChange={(event) => setPromotion((current) => ({ ...current, endsAt: event.target.value }))}
              />
            </div>
            <div className="md:col-span-6">
              <Button
                disabled={
                  !promotion.name.trim() ||
                  !promotion.value ||
                  Number(promotion.value) <= 0 ||
                  createPromotionMutation.isPending
                }
                onClick={() => createPromotionMutation.mutate()}
                data-testid="retail-promotion-create"
              >
                {createPromotionMutation.isPending ? "Creating…" : "Create promotion"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {(promotionsQuery.data ?? []).map((entry: RetailPromotion) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
                data-no-translate
              >
                <span className="font-medium">{entry.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                  {entry.discountType === "percent" ? `${entry.value}%` : `-${entry.value}`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.startsAt ? new Date(entry.startsAt).toLocaleDateString() : "always"}
                  {" → "}
                  {entry.endsAt ? new Date(entry.endsAt).toLocaleDateString() : "no end"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    entry.active
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {entry.active ? "Active" : "Inactive"}
                </span>
                {entry.active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => deactivateMutation.mutate(entry.id)}
                    data-testid="retail-promotion-deactivate"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Deactivate
                  </Button>
                )}
              </div>
            ))}
            {!promotionsQuery.isLoading && !(promotionsQuery.data ?? []).length && (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No promotions yet. Active promotions apply automatically to matching lines.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
