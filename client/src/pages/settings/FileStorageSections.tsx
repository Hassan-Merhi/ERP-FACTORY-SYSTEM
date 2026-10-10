import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, X, Loader2, FileText, FileImage, FileSpreadsheet, File } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StoredFile {
  id: number;
  folderId: number | null;
  fileName: string;
  displayName: string | null;
  fileType: string;
  fileSize: number;
  description: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
}

type PreviewType = "pdf" | "image" | "csv" | "text" | "excel" | "unsupported";
interface PreviewState {
  file: StoredFile;
  type: PreviewType;
  blobUrl?: string;
  text?: string;
  rows?: unknown[][];
  loading: boolean;
  error?: boolean;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function visibleName(file: StoredFile) {
  return file.displayName || file.fileName;
}

function getPreviewType(file: StoredFile): PreviewType {
  const mt = file.fileType.toLowerCase();
  const name = file.fileName.toLowerCase();
  if (mt === "application/pdf") return "pdf";
  if (mt.startsWith("image/")) return "image";
  if (mt.includes("spreadsheet") || mt.includes("excel") || name.endsWith(".xlsx") || name.endsWith(".xls"))
    return "excel";
  if (name.endsWith(".csv")) return "csv";
  if (mt.startsWith("text/") || name.endsWith(".txt")) return "text";
  return "unsupported";
}

function FileIcon({ fileType, fileName, className }: { fileType: string; fileName: string; className?: string }) {
  const mt = fileType.toLowerCase();
  const name = fileName.toLowerCase();
  if (mt === "application/pdf") return <FileText className={`text-red-500 ${className}`} />;
  if (mt.startsWith("image/")) return <FileImage className={`text-blue-400 ${className}`} />;
  if (
    mt.includes("spreadsheet") ||
    mt.includes("excel") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    name.endsWith(".csv")
  )
    return <FileSpreadsheet className={`text-green-500 ${className}`} />;
  if (mt.includes("word") || name.endsWith(".doc") || name.endsWith(".docx"))
    return <FileText className={`text-blue-500 ${className}`} />;
  return <File className={`text-muted-foreground ${className}`} />;
}

export function PreviewModal({
  preview,
  onClose,
  onDownload,
}: {
  preview: PreviewState | null;
  onClose: () => void;
  onDownload: (file: StoredFile) => void;
}) {
  if (!preview) return null;
  const { file, type, blobUrl, text, rows, loading, error } = preview;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b flex-row items-center justify-between">
          <DialogTitle className="truncate max-w-[80%] text-base">{visibleName(file)}</DialogTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onDownload(file)} data-testid="button-preview-download">
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
            <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-preview-close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto p-4 min-h-[300px]">
          {loading && (
            <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Loading preview...</span>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
              <FileText className="h-10 w-10 opacity-30" />
              <p>Could not load preview.</p>
            </div>
          )}
          {!loading && !error && type === "pdf" && blobUrl && (
            <iframe
              src={blobUrl}
              title="PDF Preview"
              className="w-full h-[65vh] rounded-sm border-0"
              data-testid="preview-pdf"
            />
          )}
          {!loading && !error && type === "image" && blobUrl && (
            <div className="flex items-center justify-center">
              <img
                src={blobUrl}
                alt={visibleName(file)}
                className="max-w-full max-h-[65vh] rounded-sm object-contain"
                data-testid="preview-image"
              />
            </div>
          )}
          {!loading && !error && (type === "csv" || type === "excel") && rows && rows.length > 0 && (
            <div className="overflow-auto max-h-[65vh]">
              <table className="text-xs w-full border-collapse" data-testid="preview-table">
                <tbody>
                  {rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className={ri === 0 ? "bg-muted font-semibold" : "border-b border-border/40 hover:bg-muted/30"}
                    >
                      {row.map((cell, ci: number) => (
                        <td
                          key={ci}
                          className="px-2 py-1 border-r border-border/40 whitespace-nowrap max-w-[200px] truncate"
                        >
                          {cell == null ? "" : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && (type === "csv" || type === "excel") && (!rows || rows.length === 0) && (
            <p className="text-muted-foreground text-sm">No data to preview.</p>
          )}
          {!loading && !error && type === "text" && text !== undefined && (
            <pre
              className="text-xs whitespace-pre-wrap font-mono bg-muted/30 p-4 rounded-sm max-h-[65vh] overflow-auto"
              data-testid="preview-text"
            >
              {text}
            </pre>
          )}
          {!loading && !error && type === "unsupported" && (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground">
              <FileIcon fileType={file.fileType} fileName={file.fileName} className="h-12 w-12" />
              <p className="font-medium">{visibleName(file)}</p>
              <p className="text-sm">
                {file.fileType} &bull; {formatSize(file.fileSize)}
              </p>
              <p className="text-sm">Preview not available for this file type.</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { FileIcon, formatSize, visibleName, getPreviewType };
