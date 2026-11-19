// Extracted from ./FileStorageTab.tsx
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Trash2, Eye, Pencil, ArrowRightLeft, Database } from "lucide-react";
import { FileIcon, formatSize, visibleName } from "./FileStorageSections";
import { useFileStorageTabState } from "./useFileStorageTabState";

export function FileStorageTabContent({
  filesLoading,
  folderFiles,
  formatDisplayDate,
  handleDownload,
  openPreview,
  search,
  setDeleteFileId,
  setDeleteFileName,
  setMoveFileId,
  setMoveFileOpen,
  setMoveFolderTarget,
  setRenameFileId,
  setRenameFileName,
  setRenameFileOpen,
}: Pick<
  ReturnType<typeof useFileStorageTabState>,
  | "filesLoading"
  | "folderFiles"
  | "formatDisplayDate"
  | "handleDownload"
  | "openPreview"
  | "search"
  | "setDeleteFileId"
  | "setDeleteFileName"
  | "setMoveFileId"
  | "setMoveFileOpen"
  | "setMoveFolderTarget"
  | "setRenameFileId"
  | "setRenameFileName"
  | "setRenameFileOpen"
>) {
  return (
    <div className="border rounded-md overflow-hidden">
      {filesLoading ? (
        <div className="p-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : folderFiles.length === 0 ? (
        <div className="p-10 text-center text-muted-foreground">
          <Database className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">
            {search ? "No files match your search." : "No files in this folder. Upload a file above."}
          </p>
        </div>
      ) : (
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24">Size</TableHead>
              <TableHead className="w-32">Uploaded</TableHead>
              <TableHead className="text-right w-40">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folderFiles.map((file) => (
              <TableRow key={file.id} data-testid={`row-file-${file.id}`}>
                <TableCell className="pr-0">
                  <FileIcon fileType={file.fileType} fileName={file.fileName} className="h-4 w-4" />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium text-sm truncate max-w-[260px]">{visibleName(file)}</span>
                    {file.displayName && (
                      <span className="text-xs text-muted-foreground truncate max-w-[260px]">{file.fileName}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{formatSize(file.fileSize)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{formatDisplayDate(file.uploadedAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openPreview(file)}
                      title="View"
                      data-testid={`button-view-${file.id}`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setRenameFileId(file.id);
                        setRenameFileName(visibleName(file));
                        setRenameFileOpen(true);
                      }}
                      title="Rename"
                      data-testid={`button-rename-file-${file.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setMoveFileId(file.id);
                        setMoveFolderTarget(file.folderId ? String(file.folderId) : "unfiled");
                        setMoveFileOpen(true);
                      }}
                      title="Move"
                      data-testid={`button-move-file-${file.id}`}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => handleDownload(file)}
                      title="Download"
                      aria-label="Download"
                      data-testid={`button-download-${file.id}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setDeleteFileId(file.id);
                        setDeleteFileName(visibleName(file));
                      }}
                      title="Delete"
                      data-testid={`button-delete-file-${file.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
