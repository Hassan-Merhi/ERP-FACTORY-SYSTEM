import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { LedgerAccount } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Search, Eraser } from "lucide-react";

interface CleanEmptyAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: number;
}

export function CleanEmptyAccountsDialog({ open, onOpenChange, companyId }: CleanEmptyAccountsDialogProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState("");

  const {
    data: emptyAccounts = [],
    isLoading,
    refetch: _refetch,
  } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts/empty", companyId],
    enabled: open && !!companyId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest("POST", "/api/ledger-accounts/bulk-delete", { accountIds: ids });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete accounts");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts/empty", companyId] });
      setSelected([]);
      toast({
        title: "Accounts deleted",
        description: `${data.deleted} account(s) deleted${data.skipped > 0 ? `, ${data.skipped} skipped (not empty)` : ""}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const filtered = emptyAccounts.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eraser className="h-5 w-5 text-rose-500" />
            Clean Empty Accounts
          </DialogTitle>
          <DialogDescription>Delete ledger accounts with zero transactions across all vouchers.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4 mt-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search empty accounts..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="border rounded-md overflow-hidden flex-1 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={filtered.length > 0 && selected.length === filtered.length}
                      onCheckedChange={(checked) => {
                        if (checked) setSelected(filtered.map((a) => a.id));
                        else setSelected([]);
                      }}
                    />
                  </TableHead>
                  <TableHead>Account Name</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                      Loading accounts...
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                      No empty accounts found
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.includes(account.id)}
                          onCheckedChange={(checked) => {
                            if (checked) setSelected([...selected, account.id]);
                            else setSelected(selected.filter((id) => id !== account.id));
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-medium text-sm">{account.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {account.accountType}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={selected.length === 0 || deleteMutation.isPending}
            onClick={() => deleteMutation.mutate(selected)}
          >
            {deleteMutation.isPending ? "Deleting..." : `Delete ${selected.length} Accounts`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
