import type { ClientErrorLike } from "@/lib/clientError";
/**
 * EntityFormWrapper — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import type { AccountingFormValues, EntityType } from "../types";
import { entityConfig, getDefaultValues } from "../utils";
import { LocationForm } from "./LocationForm";
import { LedgerAccountForm } from "./LedgerAccountForm";
import { EmployeeForm } from "./EmployeeForm";
import { SupplierForm } from "./SupplierForm";
import { StockGroupForm } from "./StockGroupForm";
import { StockItemForm } from "./StockItemForm";

export // Wrapper component to properly recreate form when entity changes
function EntityFormWrapper({
  entityType,
  config,
}: {
  entityType: EntityType;
  config: (typeof entityConfig)[EntityType];
}) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const defaultValues = getDefaultValues(entityType);

  const form = useForm<AccountingFormValues>({
    resolver: zodResolver(config.schema),
    defaultValues,
  });

  const createMutation = useMutation({
    mutationFn: async (data: AccountingFormValues) => {
      // Always submit against the selected company; location routes enforce the session company too.
      if (!selectedCompany?.id) throw new Error("No company selected");
      const payload = {
        ...data,
        companyId: selectedCompany.id,
        ...(entityType === "stockGroup"
          ? { name: String(data.name || "").trim(), code: String(data.name || "").trim() }
          : {}),
        ...(entityType === "stockItem"
          ? { openingQty: "0", openingRate: "0", openingValue: "0", reorderLevel: "0" }
          : {}),
      };
      const res = await modeApiRequest("POST", config.endpoint, payload);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: `${config.label} created`,
        description: `"${data.name || data.legalName || data.code || "New record"}" is ready to use.`,
        duration: 3500,
        className: "max-w-sm rounded-xl border-primary/20 px-4 py-3 pr-8 shadow-lg",
      });
      queryClient.invalidateQueries({ queryKey: [config.endpoint] });

      // invalidate by the companyId that the backend actually stored
      if (data?.companyId != null) {
        queryClient.invalidateQueries({
          queryKey: [config.endpoint, data.companyId],
        });
      } else if (selectedCompany?.id != null) {
        queryClient.invalidateQueries({
          queryKey: [config.endpoint, selectedCompany.id],
        });
      }

      form.reset(getDefaultValues(entityType));
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to create record",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: AccountingFormValues) => {
    createMutation.mutate(data);
  };

  const handleCancel = () => {
    form.reset(getDefaultValues(entityType));
  };

  // Render appropriate form based on entity type
  switch (entityType) {
    case "location":
      return (
        <LocationForm form={form} onSubmit={onSubmit} onCancel={handleCancel} isPending={createMutation.isPending} />
      );
    case "ledger":
      return (
        <LedgerAccountForm
          form={form}
          onSubmit={onSubmit}
          onCancel={handleCancel}
          isPending={createMutation.isPending}
        />
      );
    case "employee":
      return (
        <EmployeeForm form={form} onSubmit={onSubmit} onCancel={handleCancel} isPending={createMutation.isPending} />
      );
    case "supplier":
      return (
        <SupplierForm form={form} onSubmit={onSubmit} onCancel={handleCancel} isPending={createMutation.isPending} />
      );
    case "stockGroup":
      return (
        <StockGroupForm form={form} onSubmit={onSubmit} onCancel={handleCancel} isPending={createMutation.isPending} />
      );
    case "stockItem":
      return (
        <StockItemForm form={form} onSubmit={onSubmit} onCancel={handleCancel} isPending={createMutation.isPending} />
      );
  }
}
