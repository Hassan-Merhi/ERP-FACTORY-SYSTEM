import type { ClientErrorLike } from "@/lib/clientError";
/**
 * DocumentsModal — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { XCircle, Upload, Eye, Trash2, Check, X, Paperclip, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ShippingDocument } from "../types";
import { LIST_KEY } from "../utils";

export function DocumentsModal({
  open,
  rowId,
  invoiceNumber,
  onClose,
}: {
  open: boolean;
  rowId: number | null;
  invoiceNumber: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newDocName, setNewDocName] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  useEffect(() => {
    setPendingFile(null);
    setNewDocName("");
  }, [rowId]);

  // IMPORTANT: queryKey[0] must be the full fetch URL — the default fetcher uses only queryKey[0].
  // Using [LIST_KEY, rowId, "documents"] would cause every refetch to hit LIST_KEY (the row list)
  // instead of the documents endpoint, wiping the docs list after each optimistic update.
  const docsKey = rowId !== null ? [`${LIST_KEY}/${rowId}/documents`] : [`${LIST_KEY}/null/documents`];
  const { data: docs = [], isLoading } = useQuery<ShippingDocument[]>({
    queryKey: docsKey,
    enabled: open && rowId !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, displayName }: { file: File; displayName: string }) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("displayName", displayName);
      const resp = await fetch(`${LIST_KEY}/${rowId}/documents`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || "Upload failed");
      }
      return resp.json() as Promise<ShippingDocument>;
    },
    onSuccess: (doc: ShippingDocument) => {
      queryClient.setQueryData<ShippingDocument[]>(docsKey, (old = []) => [...old, doc]);
      // Invalidate the main row list to refresh document counts, but NOT docsKey
      // (docsKey already has the correct optimistic data from setQueryData above)
      queryClient.invalidateQueries({ queryKey: [LIST_KEY], exact: true });
      setPendingFile(null);
      setNewDocName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast({ title: "Document uploaded", description: doc.displayName });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      const resp = await apiRequest("DELETE", `${LIST_KEY}/${rowId}/documents/${docId}`, undefined);
      if (!resp.ok && resp.status !== 404) {
        const err = await resp.json().catch(() => ({ message: "Delete failed" }));
        throw new Error(err.message || "Delete failed");
      }
      return { deletedId: docId };
    },
    onSuccess: ({ deletedId }) => {
      queryClient.setQueryData<ShippingDocument[]>(docsKey, (old = []) => old.filter((d) => d.id !== deletedId));
      // Invalidate the main row list to refresh document counts, but NOT docsKey
      queryClient.invalidateQueries({ queryKey: [LIST_KEY], exact: true });
      toast({ title: "Document removed" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setNewDocName(file.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  }

  function handleUpload() {
    if (!pendingFile) return;
    uploadMutation.mutate({ file: pendingFile, displayName: newDocName || pendingFile.name });
  }

  async function handleViewDoc(doc: ShippingDocument) {
    try {
      const resp = await fetch(doc.fileUrl, { credentials: "include" });
      if (!resp.ok) {
        const isJson = resp.headers.get("content-type")?.includes("application/json");
        const msg = isJson ? (await resp.json()).message : await resp.text();
        const isLegacyFile = resp.status === 404;
        toast({
          title: isLegacyFile ? "File no longer available" : "File unavailable",
          description: isLegacyFile
            ? "This file was uploaded before database storage was enabled and cannot be retrieved. Please delete it and re-upload."
            : msg || `Server returned ${resp.status}`,
          variant: "destructive",
        });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast({ title: "Could not open file", description: "Network error", variant: "destructive" });
    }
  }

  function fmtSize(bytes: number | null) {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            Documents
            <span className="font-mono text-sm text-muted-foreground font-normal">{invoiceNumber}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
            </div>
          ) : docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <XCircle className="h-8 w-8 mb-2 text-red-400" />
              <p className="text-sm">No documents uploaded yet</p>
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">Size</TableHead>
                    <TableHead className="text-xs">Uploaded by</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map((doc) =>
                    doc.isGhost ? (
                      <TableRow key={doc.id} data-testid={`row-doc-${doc.id}`} className="bg-destructive/5">
                        <TableCell colSpan={4} className="py-2">
                          <p className="text-xs font-medium text-destructive">Broken record</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            No file is attached to this record. Delete it and re-upload.
                          </p>
                        </TableCell>
                        <TableCell className="py-2">
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate(doc.id)}
                            data-testid={`button-remove-doc-${doc.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : (
                      <TableRow key={doc.id} data-testid={`row-doc-${doc.id}`}>
                        <TableCell
                          className="text-sm font-medium max-w-[130px] truncate"
                          title={doc.displayName || doc.originalName}
                        >
                          {doc.displayName || doc.originalName || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {(doc.fileType || "FILE").split("/").pop()?.toUpperCase() || "FILE"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {fmtSize(doc.fileSize)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{doc.uploadedBy || "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleViewDoc(doc)}
                              data-testid={`button-view-doc-${doc.id}`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={deleteMutation.isPending}
                              onClick={() => deleteMutation.mutate(doc.id)}
                              data-testid={`button-remove-doc-${doc.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Upload Document</p>
            <p className="text-xs text-muted-foreground">Max 25 MB per file.</p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileSelect}
              data-testid="input-file-upload"
            />
            {pendingFile ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground border rounded-md px-2 py-1.5">
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{pendingFile.name}</span>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Display Name</Label>
                  <Input
                    value={newDocName}
                    onChange={(e) => setNewDocName(e.target.value)}
                    placeholder="e.g. Packing List"
                    className="h-8 text-sm"
                    data-testid="input-doc-name"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleUpload}
                    disabled={uploadMutation.isPending}
                    data-testid="button-confirm-upload"
                  >
                    {uploadMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5 mr-1" />
                    )}
                    Upload Document
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPendingFile(null)}>
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-doc"
              >
                <Upload className="h-3.5 w-3.5 mr-1" /> Choose File
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── WhatsApp Package Modal ────────────────────────────────────────────────────
