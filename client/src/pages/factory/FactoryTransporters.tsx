import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, TruckIcon } from "lucide-react";
import { API, fmtUsd, type Transporter } from "./FactoryTransportersPaymentDialog";
import { TransporterStatement } from "./FactoryTransportersTransporterStatement";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

// ─────────────────────────────────────────────────────────────
// ADD TRANSPORTER DIALOG
// ─────────────────────────────────────────────────────────────
function AddTransporterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () => apiRequest("POST", API, { name, phone, notes }),
    onSuccess: () => {
      toast({ title: "Transporter created" });
      queryClient.invalidateQueries({ queryKey: [API] });
      setName("");
      setPhone("");
      setNotes("");
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Transporter</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Transporter name"
                data-testid="input-transporter-name"
              />
            </div>
            <div>
              <Label>Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+961 xx xxx xxx"
                data-testid="input-transporter-phone"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="input-transporter-notes"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A "Transporter Agent" ledger account will be created automatically.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => create.mutate(), "Create Transporter")}
              disabled={!name || create.isPending}
              data-testid="button-create-transporter"
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN PAGE — list
// ─────────────────────────────────────────────────────────────
export default function FactoryTransporters() {
  const { selectedCompany } = useCompany();
  const { AdminDialog } = useAdminOverride();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const canAddTransporter = useExistingRecordChangeAccess().canCreate("POST", API);
  useEffect(() => {
    setSelectedId(null);
    setAddOpen(false);
  }, [selectedCompany?.id]);
  const {
    data: transporters = [],
    isLoading,
    isError: transportersError,
    refetch: refetchTransporters,
  } = useQuery<Transporter[]>({
    queryKey: companyQueryKey(API, selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  if (selectedId !== null) {
    return (
      <div className="p-4 sm:p-6">
        <TransporterStatement transporterId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <TruckIcon className="h-6 w-6 text-orange-500" />
          <div>
            <PageHeader title="Transporters" subtitle="Track charges and payments per transporter." />
          </div>
        </div>
        {canAddTransporter && (
          <Button onClick={() => setAddOpen(true)} size="sm" data-testid="button-add-transporter">
            <Plus className="h-4 w-4 mr-1" /> Add Transporter
          </Button>
        )}
      </div>

      {/* Summary cards */}
      {!isLoading && transporters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL TRANSPORTERS</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{transporters.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL PAID</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className={`text-2xl font-bold ${transporters.reduce((s, t) => s + t.totalPaid, 0) > 0 ? "text-green-600 dark:text-green-400" : ""}`}
              >
                {fmtUsd(transporters.reduce((s, t) => s + t.totalPaid, 0))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL OUTSTANDING</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className={`text-2xl font-bold ${transporters.reduce((s, t) => s + t.outstanding, 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}
              >
                {fmtUsd(transporters.reduce((s, t) => s + t.outstanding, 0))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transporters list */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : transportersError && transporters.length === 0 ? (
            <ErrorState
              onAction={() => void refetchTransporters()}
              actionLabel="Try again"
              className="rounded-none border-0"
            />
          ) : transporters.length === 0 ? (
            <EmptyState
              icon={TruckIcon}
              title="No transporters yet"
              description="Add your first transporter to start tracking charges and payments."
              className="rounded-none border-0"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Transporter</th>
                    <th className="px-4 py-3 font-medium">Phone</th>
                    <th className="px-4 py-3 text-right font-medium">Total Charged</th>
                    <th className="px-4 py-3 text-right font-medium">Total Paid</th>
                    <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {transporters.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b hover-elevate cursor-pointer"
                      onClick={() => setSelectedId(t.id)}
                      data-testid={`row-transporter-${t.id}`}
                    >
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{t.phone || "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{fmtUsd(t.totalCharged)}</td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${t.totalPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                      >
                        {fmtUsd(t.totalPaid)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums font-medium ${t.outstanding > 0 ? "text-red-600 dark:text-red-400" : t.outstanding < 0 ? "text-green-600 dark:text-green-400" : ""}`}
                      >
                        {fmtUsd(t.outstanding)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddTransporterDialog open={addOpen} onClose={() => setAddOpen(false)} />
      {AdminDialog}
    </div>
  );
}
