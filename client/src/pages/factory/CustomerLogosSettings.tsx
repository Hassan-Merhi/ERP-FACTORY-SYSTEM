import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Pencil, Trash2, Image } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface CustomerOption {
  id: number;
  active: boolean;
  legalName: string;
}

interface CustomerLogo {
  id: number;
  name: string;
}

export default function CustomerLogosSettings() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const { data: allCustomers = [] } = useQuery<CustomerOption[]>({
    queryKey: ["/api/factory/customers"],
    queryFn: () => fetch("/api/factory/customers", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: logos = [], isLoading } = useQuery<CustomerLogo[]>({
    queryKey: ["/api/factory/customers", selectedCustomerId, "logos"],
    queryFn: () =>
      fetch(`/api/factory/customers/${selectedCustomerId}/logos`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!selectedCustomerId,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("name", file.name.replace(/\.[^.]+$/, ""));
      const resp = await fetch(`/api/factory/customers/${selectedCustomerId}/logos`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!resp.ok) throw new Error((await resp.json()).message);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Logo uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers", selectedCustomerId, "logos"] });
    },
    onError: (e: Error) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const resp = await fetch(`/api/factory/customer-logos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) throw new Error((await resp.json()).message);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Logo renamed" });
      setRenamingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers", selectedCustomerId, "logos"] });
    },
    onError: (e: Error) => toast({ title: "Rename failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const resp = await fetch(`/api/factory/customer-logos/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!resp.ok) throw new Error((await resp.json()).message);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Logo removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers", selectedCustomerId, "logos"] });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const activeCustomers = allCustomers.filter((c) => c.active);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Image className="h-6 w-6 text-muted-foreground" />
        <PageHeader title="Customer Logos" />
      </div>
      <p className="text-sm text-muted-foreground">
        Upload logos per customer. These replace the default HMD logo on bale labels when selected during stock entry.
        PNG, JPG or WEBP only — max 500 KB per file.
      </p>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            value={selectedCustomerId}
            onValueChange={(v) => {
              setSelectedCustomerId(v);
              setRenamingId(null);
            }}
          >
            <SelectTrigger data-testid="select-logo-customer">
              <SelectValue placeholder="Choose a customer to manage logos..." />
            </SelectTrigger>
            <SelectContent>
              {activeCustomers.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {selectedCustomerId && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base">
                Logos for {activeCustomers.find((c) => String(c.id) === selectedCustomerId)?.legalName}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
                data-testid="button-upload-logo"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {uploadMutation.isPending ? "Uploading..." : "Upload Logo"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadMutation.mutate(file);
                  e.target.value = "";
                }}
              />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading logos...</p>
            ) : logos.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <Image className="h-10 w-10 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">No logos uploaded yet.</p>
                <p className="text-xs text-muted-foreground">Click "Upload Logo" to add the first one.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {logos.map((logo) => (
                  <div
                    key={logo.id}
                    className="flex items-center gap-3 p-3 rounded-md border"
                    data-testid={`row-logo-${logo.id}`}
                  >
                    <img
                      src={`/api/factory/customer-logos/${logo.id}/image`}
                      alt={logo.name}
                      className="h-12 w-20 object-contain rounded shrink-0"
                    />
                    {renamingId === logo.id ? (
                      <div className="flex items-center gap-2 flex-1 flex-wrap">
                        <Input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="h-8 text-sm flex-1 min-w-0"
                          autoFocus
                          data-testid={`input-rename-logo-${logo.id}`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && renameValue.trim())
                              renameMutation.mutate({ id: logo.id, name: renameValue.trim() });
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                        />
                        <Button
                          size="sm"
                          onClick={() => renameMutation.mutate({ id: logo.id, name: renameValue.trim() })}
                          disabled={!renameValue.trim() || renameMutation.isPending}
                          data-testid={`button-save-rename-${logo.id}`}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRenamingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <span className="flex-1 text-sm font-medium truncate" data-testid={`text-logo-name-${logo.id}`}>
                          {logo.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setRenamingId(logo.id);
                            setRenameValue(logo.name);
                          }}
                          data-testid={`button-rename-logo-${logo.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          onClick={() => deleteMutation.mutate(logo.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-logo-${logo.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
