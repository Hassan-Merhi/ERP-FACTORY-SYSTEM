import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { Plus, Trash2, Loader2 } from "lucide-react";
import {
  insertUserSchema,
  insertCompanySchema,
  insertUserCompanyRoleSchema,
  type Company,
  type LedgerAccount,
} from "@shared/schema";

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

export function ParentCreditAccountSelect({ company }: { company: Pick<Company, "id"> }) {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [isCreating, setIsCreating] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");

  const { data: companySettings } = useQuery({
    queryKey: ["/api/company-settings", company.id],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/company-settings?companyId=${company.id}`, { credentials: "include" });
        if (res.status === 404) return { companyId: company.id, parentCreditAccountId: null };
        if (!res.ok) throw new Error("Failed to fetch settings");
        return res.json();
      } catch {
        return { companyId: company.id, parentCreditAccountId: null };
      }
    },
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", company.id],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/ledger-accounts?companyId=${company.id}`, { credentials: "include" });
        if (!res.ok) return [];
        return res.json();
      } catch {
        return [];
      }
    },
  });

  const liabilityAccounts = ledgerAccounts.filter(
    (acc) => acc.accountType === "Liability" && acc.active && !acc.deletedAt
  );

  const updateSettingsMutation = useMutation({
    mutationFn: async (parentCreditAccountId: number | null) => {
      const res = await modeApiRequest("POST", "/api/company-settings", {
        companyId: company.id,
        parentCreditAccountId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/company-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({ title: "Saved", description: "Parent credit account updated" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createAccountMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await modeApiRequest("POST", "/api/ledger-accounts", {
        companyId: company.id,
        name,
        accountType: "Liability",
        subType: "Current Liability",
      });
      return res.json();
    },
    onSuccess: (newAccount) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      updateSettingsMutation.mutate(newAccount.id);
      setIsCreating(false);
      setNewAccountName("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error creating account", description: error.message, variant: "destructive" });
    },
  });

  const currentAccountId = companySettings?.parentCreditAccountId;
  const currentAccount = ledgerAccounts.find((acc) => acc.id === currentAccountId);

  if (isCreating) {
    return (
      <div className="flex gap-1 items-center">
        <Input
          value={newAccountName}
          onChange={(e) => setNewAccountName(e.target.value)}
          placeholder="Account name..."
          className="h-8 w-32 text-xs"
          data-testid={`input-new-credit-account-${company.id}`}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => newAccountName && createAccountMutation.mutate(newAccountName)}
          disabled={!newAccountName || createAccountMutation.isPending}
          data-testid={`button-save-credit-account-${company.id}`}
        >
          {createAccountMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setIsCreating(false);
            setNewAccountName("");
          }}
          data-testid={`button-cancel-credit-account-${company.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Select
      value={currentAccountId?.toString() || "none"}
      onValueChange={(value) => {
        if (value === "create_new") {
          setIsCreating(true);
        } else {
          const accountId = value === "none" ? null : parseInt(value, 10);
          updateSettingsMutation.mutate(accountId);
        }
      }}
      disabled={updateSettingsMutation.isPending}
    >
      <SelectTrigger className="w-40 h-8 text-xs" data-testid={`select-credit-account-${company.id}`}>
        <SelectValue placeholder="Not Set">{currentAccount ? currentAccount.name : "Not Set"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Not Set</SelectItem>
        {liabilityAccounts.map((acc) => (
          <SelectItem key={acc.id} value={acc.id.toString()}>
            {acc.name}
          </SelectItem>
        ))}
        <SelectItem value="create_new" className="text-primary font-medium">
          + Create New Account
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
