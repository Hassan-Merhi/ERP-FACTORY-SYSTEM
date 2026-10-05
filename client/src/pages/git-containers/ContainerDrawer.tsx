import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { EnrichedContainerRow, DrawerForm, seedForm } from "./gitContainerTypes";
import { ContainerDrawerForm } from "./ContainerDrawerForm";

export function ContainerDrawer({
  container,
  open,
  onClose,
  sessionCompanyId,
}: {
  container: EnrichedContainerRow | null;
  open: boolean;
  onClose: () => void;
  sessionCompanyId: number | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<DrawerForm | null>(null);

  useEffect(() => {
    if (open && container) {
      setForm(seedForm(container));
    }
  }, [open, container]);

  const set = <K extends keyof DrawerForm>(field: K, val: DrawerForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [field]: val } : prev));

  const canEdit = sessionCompanyId === null || !container || container.companyId === sessionCompanyId;

  const maxOffload = (() => {
    if (!form?.borderDate) return null;
    const d = new Date(form.borderDate);
    const t = (form.transporter ?? "").toUpperCase();
    const days = t.includes("FARHAT") || t.includes("CONTINENTAL") ? 11 : 14;
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  })();

  const daysDelayed = (() => {
    if ((form?.numberPlate ?? "").trim()) return null;
    if (!form?.eta) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const arrival = new Date(form.eta);
    if (isNaN(arrival.getTime())) return null;
    const diff = Math.floor((today.getTime() - arrival.getTime()) / 86400000);
    return diff > 0 ? diff : null;
  })();

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("PATCH", `/api/containers/${container!.id}/tracking`, data),
    onSuccess: () => {
      void invalidateApiFamily(queryClient, "/api/git/containers");
      toast({ title: "Saved", description: `${container?.containerNumber} updated.` });
      onClose();
    },
    onError: (err: ClientErrorLike) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  function handleSave() {
    if (!container || !form) return;
    mutation.mutate({
      eta: form.eta || null,
      status: form.status,
      transporter: form.transporter || null,
      transportFee: form.transportFee || null,
      numberPlate: form.numberPlate || null,
      trackingLocation: form.trackingLocation || null,
      borderDate: form.borderDate || null,
      agent: form.agent || null,
      dutyFee: form.dutyFee || null,
      docReceived: form.docReceived,
      docsSentDate: form.docsSentDate || null,
      trackingLink: form.trackingLink || null,
      trackingDescription: form.trackingDescription || null,
      blDocs: form.blDocs || null,
      shopName: form.shopName || null,
    });
  }

  if (!container || !form) return null;

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-base font-mono">{container.containerNumber}</SheetTitle>
          <SheetDescription className="text-xs">{container.companyName} — Container Logistics</SheetDescription>
        </SheetHeader>

        <ContainerDrawerForm
          form={form}
          set={set}
          container={container}
          canEdit={canEdit}
          maxOffload={maxOffload}
          daysDelayed={daysDelayed}
        />

        <div className="pt-4 sticky bottom-0 bg-background pb-2">
          <Button
            className="w-full"
            onClick={handleSave}
            disabled={!canEdit || mutation.isPending}
            data-testid="button-save-drawer"
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
