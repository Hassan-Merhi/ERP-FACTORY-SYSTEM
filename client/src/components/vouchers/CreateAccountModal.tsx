import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

const accountTypes = [
  "Indirect Expense",
  "Direct Expense",
  "Income",
  "Asset",
  "Liability",
  "Equity",
  "Bank",
  "Cash",
  "Accounts Payable",
  "Loans",
] as const;

const subTypeOptions: Record<string, string[]> = {
  Expense: ["Direct Expense", "Indirect Expense"],
  Income: ["Direct Income", "Indirect Income"],
  Asset: ["Current Asset", "Fixed Asset", "Input Tax", "Tax Receivable"],
  Liability: ["Current Liability", "Long-term Liability", "Loans Payable", "Output Tax", "Tax Payable"],
};

function normalizeLedgerType(selection: string): { accountType: string; subType?: string } {
  if (selection === "Indirect Expense") return { accountType: "Expense", subType: "Indirect Expense" };
  if (selection === "Direct Expense") return { accountType: "Expense", subType: "Direct Expense" };
  if (["Asset", "Liability", "Equity", "Income", "Expense"].includes(selection)) return { accountType: selection };
  return { accountType: selection };
}

const createAccountSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .refine((val) => val.trim().length > 0, "Name cannot be empty"),
  accountType: z.string().min(1, "Account type is required"),
  subType: z.string().optional(),
});

type CreateAccountFormData = z.infer<typeof createAccountSchema>;

interface CreateAccountModalProps {
  open: boolean;
  onClose: () => void;
  companyId: number;
  onAccountCreated: (account: { id: number; name: string; type: string }) => void;
  defaultAccountType?: string;
  apiRequestFn?: typeof apiRequest;
}

export function CreateAccountModal({
  open,
  onClose,
  companyId,
  onAccountCreated,
  defaultAccountType,
  apiRequestFn,
}: CreateAccountModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const req = apiRequestFn ?? apiRequest;

  const form = useForm<CreateAccountFormData>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: {
      name: "",
      accountType: defaultAccountType || "",
      subType: "",
    },
  });

  const selectedAccountType = form.watch("accountType");
  const availableSubTypes = subTypeOptions[normalizeLedgerType(selectedAccountType).accountType] || [];

  const createMutation = useMutation({
    mutationFn: async (data: CreateAccountFormData) => {
      const normalized = normalizeLedgerType(data.accountType);
      const payload = {
        companyId,
        name: data.name.trim(),
        accountType: normalized.accountType,
        subType: normalized.subType || data.subType || undefined,
      };
      const res = await req("POST", "/api/ledger-accounts", payload);
      return await res.json();
    },
    onSuccess: async (newAccount) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts", companyId] });

      toast({
        title: "Account created",
        description: `"${newAccount.name}" has been created and selected.`,
      });

      onAccountCreated({
        id: newAccount.id,
        name: newAccount.name,
        type: "ledger",
      });

      form.reset();
      onClose();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Save failed",
        description: error.message || "Failed to create account",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: CreateAccountFormData) => {
    createMutation.mutate(data);
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-md" data-testid="modal-create-account">
        <DialogHeader>
          <DialogTitle>Create New Account</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g., Office Supplies" autoFocus data-testid="input-account-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="accountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-account-type">
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {accountTypes.map((type) => (
                        <SelectItem key={type} value={type} data-testid={`option-type-${type}`}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {availableSubTypes.length > 0 && (
              <FormField
                control={form.control}
                name="subType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sub Type (Optional)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-sub-type">
                          <SelectValue placeholder="Select sub type..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {availableSubTypes.map((subType) => (
                          <SelectItem key={subType} value={subType}>
                            {subType}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={createMutation.isPending}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending} data-testid="button-create-account">
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Account"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
