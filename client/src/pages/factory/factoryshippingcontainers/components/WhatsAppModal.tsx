import { getErrorDetails } from "@shared/errorUtils";
/**
 * WhatsAppModal — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MessageCircle, Copy, ExternalLink, Eye, Check, RefreshCw, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import type { WaFileWithChecked, WhatsAppPreview } from "../types";
import { LIST_KEY } from "../utils";

export function WhatsAppModal({
  open,
  rowId,
  onClose,
  onMarkDone,
}: {
  open: boolean;
  rowId: number | null;
  onClose: () => void;
  onMarkDone: (id: number, markWaSent: boolean) => void;
}) {
  const { toast } = useToast();
  const [files, setFiles] = useState<WaFileWithChecked[]>([]);
  const [message, setMessage] = useState("");
  const [initialised, setInitialised] = useState(false);
  const [isZipDownloading, setIsZipDownloading] = useState(false);

  const previewUrl = rowId ? `${LIST_KEY}/${rowId}/whatsapp-preview` : null;
  const {
    data: preview,
    isLoading,
    refetch,
  } = useQuery<WhatsAppPreview>({
    queryKey: [previewUrl],
    enabled: open && !!rowId && !!previewUrl,
  });

  // Initialise file list and message when preview data arrives
  useEffect(() => {
    if (!open || !preview) return;
    const fl: WaFileWithChecked[] = preview.files.map((f) => ({ ...f, checked: f.available }));
    setFiles(fl);
    setMessage(preview.defaultMessage);
    setInitialised(true);
  }, [open, preview]);

  // Reset when modal closes
  useEffect(() => {
    if (!open) {
      setFiles([]);
      setMessage("");
      setInitialised(false);
    }
  }, [open]);

  function toggleFile(id: string) {
    setFiles((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, checked: !f.checked } : f));
      // Rebuild message body only if we have a preview base
      if (preview) {
        const checkedNames = next
          .filter((f) => f.checked)
          .map((f) => `- ${f.name}`)
          .join("\n");
        const base = preview.defaultMessage;
        const docBlock = checkedNames || "- (none selected)";
        // Replace the "Documents attached:" block
        setMessage(
          base.replace(/Documents attached:\n[\s\S]*?\n\nThank you\./, `Documents attached:\n${docBlock}\n\nThank you.`)
        );
      }
      return next;
    });
  }

  function handleRefresh() {
    refetch().then(() => toast({ title: "File list refreshed" }));
  }

  function handleCopyMessage() {
    navigator.clipboard.writeText(message).then(() => toast({ title: "Message copied to clipboard" }));
  }

  async function handleDownloadZip() {
    const selected = files
      .filter((f) => f.checked && f.available)
      .map((f) => f.id)
      .join(",");
    if (!selected) {
      toast({ title: "No files selected", variant: "destructive" });
      return;
    }
    setIsZipDownloading(true);
    try {
      const url = `${LIST_KEY}/${rowId}/zip-package?fileIds=${encodeURIComponent(selected)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Download failed" }));
        throw new Error(err.message || "Download failed");
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("The ZIP package was empty. Refresh the file list and try again.");
      }
      const disposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = nameMatch ? nameMatch[1] : exportFileName("shipping package", "zip");
      downloadBlob(blob, filename);
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsZipDownloading(false);
    }
  }

  function handleOpenWhatsApp() {
    const phone = (preview?.whatsappContact || "").replace(/\D/g, "");
    const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : "https://web.whatsapp.com";
    window.open(url, "_blank");
    toast({ title: "WhatsApp opened", description: "Attach the downloaded files, paste the message, then send." });
  }

  function handleMarkDone() {
    if (!rowId) return;
    onMarkDone(rowId, true);
    onClose();
  }

  const checkedCount = files.filter((f) => f.checked).length;
  const p = preview?.row;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-green-600" />
            WhatsApp Package Preview
          </DialogTitle>
        </DialogHeader>

        {isLoading || !initialised ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading package data…
          </div>
        ) : (
          p && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm rounded-md border bg-muted/30 p-3">
                <div>
                  <span className="text-xs text-muted-foreground">Client</span>
                  <p className="font-medium">{p.clientName || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Invoice</span>
                  <p className="font-mono font-medium">{p.invoiceNumber || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Container</span>
                  <p className="font-mono">{p.containerNumber || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Destination</span>
                  <p>{p.destination || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Shipping Company</span>
                  <p>{p.shippingCompany || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">WhatsApp Contact</span>
                  <p>
                    {preview?.whatsappContact || <span className="text-muted-foreground italic text-xs">Not set</span>}
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Files to Include ({checkedCount} selected)
                  </p>
                  <Button size="sm" variant="ghost" onClick={handleRefresh} data-testid="button-refresh-files">
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh Files
                  </Button>
                </div>
                <div className="border rounded-md overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10 text-xs">Send</TableHead>
                        <TableHead className="text-xs">File Name</TableHead>
                        <TableHead className="text-xs">Type</TableHead>
                        <TableHead className="text-xs">Source</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {files.map((f) => (
                        <TableRow
                          key={f.id}
                          data-testid={`row-wa-file-${f.id}`}
                          className={!f.checked || !f.available ? "opacity-50" : ""}
                        >
                          <TableCell>
                            <Checkbox
                              checked={f.checked && f.available}
                              disabled={!f.available}
                              onCheckedChange={() => f.available && toggleFile(f.id)}
                              data-testid={`checkbox-file-${f.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-sm font-medium">
                            {f.name}
                            {!f.available && f.unavailableReason && (
                              <span className="ml-2 text-xs text-muted-foreground italic">({f.unavailableReason})</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {f.fileType}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{f.source}</TableCell>
                          <TableCell>
                            {f.available && f.fileUrl && (
                              <Button size="icon" variant="ghost" asChild>
                                <a href={f.fileUrl} target="_blank" rel="noreferrer">
                                  <Eye className="h-3.5 w-3.5" />
                                </a>
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">WhatsApp Message</p>
                <Textarea
                  rows={10}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="text-sm font-mono"
                  data-testid="textarea-wa-message"
                />
              </div>

              <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 p-3 text-xs text-blue-800 dark:text-blue-300">
                <p className="font-semibold mb-1">How to send:</p>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>Download the ZIP package below.</li>
                  <li>Click "Open WhatsApp" — the message will pre-fill if a contact is set.</li>
                  <li>Attach the downloaded files manually in WhatsApp.</li>
                  <li>Review the message, then click Send.</li>
                  <li>Come back here and click "I Sent It — Mark as Done".</li>
                </ol>
              </div>

              <div className="flex flex-wrap gap-2">
                <ExportButton
                  variant="default"
                  label={isZipDownloading ? "Building ZIP…" : "Download ZIP Package"}
                  onClick={handleDownloadZip}
                  disabled={isZipDownloading}
                  data-testid="button-download-zip"
                />
                <Button variant="outline" onClick={handleCopyMessage} data-testid="button-copy-message">
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy Message
                </Button>
                <Button variant="outline" onClick={handleOpenWhatsApp} data-testid="button-open-whatsapp">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open WhatsApp
                </Button>
                <Button className="ml-auto" onClick={handleMarkDone} data-testid="button-mark-done-wa">
                  <Check className="h-3.5 w-3.5 mr-1" /> I Sent It — Mark as Done
                </Button>
              </div>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Shipping Availability Table ───────────────────────────────────────────────
