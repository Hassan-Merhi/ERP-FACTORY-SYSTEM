import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { Company } from "@shared/schema";
import type { SettingsMessageResult } from "./settingsTypes";

interface FixPOCreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
}

export function FixPOCreditsDialog({ open, onOpenChange, companies }: FixPOCreditsDialogProps) {
  const { toast } = useToast();
  const [selectedSub, setSelectedSub] = useState("");
  const [selectedParent, setSelectedParent] = useState("");
  const [result, setResult] = useState<SettingsMessageResult | null>(null);

  const fixMutation = useMutation({
    mutationFn: async (data: { companyId: number; parentCompanyId: number }) => {
      const res = await apiRequest("POST", "/api/fix-old-po-credits", data);
      if (!res.ok) throw new Error("Failed to fix credits");
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Success", description: data.message });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const reverseMutation = useMutation({
    mutationFn: async (data: { companyId: number; parentCompanyId: number }) => {
      const res = await apiRequest("POST", "/api/reverse-old-po-credits", data);
      if (!res.ok) throw new Error("Failed to reverse credits");
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Success", description: data.message });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setResult(null);
      }}
    >
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Inter-Company Credit Management</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4 text-foreground">
              {!result ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Manage credit management between subsidiaries and parent.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Subsidiary (Source)</Label>
                      <Select value={selectedSub} onValueChange={setSelectedSub}>
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Subsidiary..." />
                        </SelectTrigger>
                        <SelectContent>
                          {companies.map((c) => (
                            <SelectItem key={c.id} value={c.id.toString()}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Parent (Receiver)</Label>
                      <Select value={selectedParent} onValueChange={setSelectedParent}>
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Parent..." />
                        </SelectTrigger>
                        <SelectContent>
                          {companies.map((c) => (
                            <SelectItem key={c.id} value={c.id.toString()}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-4 bg-muted rounded-md">{result.message}</div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {!result && (
            <>
              <Button
                variant="destructive"
                onClick={() =>
                  reverseMutation.mutate({
                    companyId: parseInt(selectedSub),
                    parentCompanyId: parseInt(selectedParent),
                  })
                }
                disabled={!selectedSub || !selectedParent || reverseMutation.isPending}
              >
                Reverse Credits
              </Button>
              <AlertDialogAction
                onClick={() =>
                  fixMutation.mutate({ companyId: parseInt(selectedSub), parentCompanyId: parseInt(selectedParent) })
                }
                disabled={!selectedSub || !selectedParent || fixMutation.isPending}
              >
                Fix Credits
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ResetCompanyDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
}

export function ResetCompanyDataDialog({ open, onOpenChange, companies }: ResetCompanyDataDialogProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<SettingsMessageResult | null>(null);

  const mutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/companies/${id}/reset-data`, {});
      if (!res.ok) throw new Error("Reset failed");
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Success", description: data.message });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setResult(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset Company Data</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4 text-foreground">
              {!result ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Clear all vouchers and entries for a company. This is IRREVERSIBLE.
                  </p>
                  <Select value={selected} onValueChange={setSelected}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select company..." />
                    </SelectTrigger>
                    <SelectContent>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <div className="p-4 bg-muted rounded-md">{result.message}</div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {!result && (
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!selected || mutation.isPending}
              onClick={() => mutation.mutate(parseInt(selected))}
            >
              Reset All Data
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
