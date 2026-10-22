import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlaskConical, Copy } from "lucide-react";

interface ProvisionedErpTestCompany {
  company: { id: number; name: string; code: string };
  tester: { username: string; role: string };
  password: string;
  settingsAccess: false;
}

export function CreateErpTestCompanyDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [companyName, setCompanyName] = useState("ERP Test Company");
  const [username, setUsername] = useState("");
  const [created, setCreated] = useState<ProvisionedErpTestCompany | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/companies/erp-test", {
        companyName: companyName.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      return (await response.json()) as ProvisionedErpTestCompany;
    },
    onSuccess: (result) => {
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: "Test company created",
        description: "The ERP tester has data access without administrative Settings.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Unable to create test company", description: error.message, variant: "destructive" });
    },
  });

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      // Credentials are deliberately shown only once; do not persist them.
      setCreated(null);
      setUsername("");
      setCompanyName("ERP Test Company");
    }
  }

  const credentials = created
    ? `ERP test company: ${created.company.name} (${created.company.code})\nUsername: ${created.tester.username}\nPassword: ${created.password}`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" data-testid="button-create-erp-test-company">
          <FlaskConical className="h-4 w-4 mr-2" />
          Create ERP Test Company
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? "ERP Tester Credentials" : "Create Isolated ERP Test Company"}</DialogTitle>
          <DialogDescription>
            {created
              ? "Copy these credentials now. The password cannot be viewed again after closing."
              : "Creates an empty, standalone ERP company and a Manager tester. The tester can enter and remove test data but cannot access administrative Settings or another company."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
              <p>
                <strong>Company:</strong> {created.company.name} ({created.company.code})
              </p>
              <p>
                <strong>Username:</strong> {created.tester.username}
              </p>
              <p className="break-all">
                <strong>One-time password:</strong> <code data-testid="erp-test-password">{created.password}</code>
              </p>
              <p>
                <strong>Access:</strong> ERP data entry, no administrative Settings
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                navigator.clipboard.writeText(credentials).then(
                  () => toast({ title: "Credentials copied" }),
                  () =>
                    toast({
                      title: "Copy failed",
                      description: "Select and copy the credentials shown above.",
                      variant: "destructive",
                    })
                );
              }}
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy Credentials
            </Button>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (companyName.trim().length >= 2) createMutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="erp-test-company-name">Company name</Label>
              <Input
                id="erp-test-company-name"
                value={companyName}
                maxLength={120}
                onChange={(event) => setCompanyName(event.target.value)}
                required
                minLength={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="erp-test-username">Username (optional)</Label>
              <Input
                id="erp-test-username"
                value={username}
                maxLength={48}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Leave blank to generate a unique username"
              />
              <p className="text-xs text-muted-foreground">
                Letters, numbers, dots, underscores, and dashes. The password is generated securely.
              </p>
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={createMutation.isPending || companyName.trim().length < 2}
            >
              {createMutation.isPending ? "Creating..." : "Create Test Company & User"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
