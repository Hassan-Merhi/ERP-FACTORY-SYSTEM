import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { readFromBuffer } from "@/lib/excelHelper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Upload,
  Download,
  Trash2,
  Eye,
  Pencil,
  ArrowRightLeft,
  Search,
  Loader2,
  Database,
  ChevronRight,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────
interface FileFolder {
  id: number;
  name: string;
  companyId: number;
  createdAt: string;
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────
import { PreviewModal, FileIcon, formatSize, visibleName, getPreviewType } from "./FileStorageSections";
import { FolderList } from "./FolderList";
import { FileStorageDialogs } from "./FileStorageDialogs";

// ── Main Component ────────────────────────────────────────────────────────────
export function FileStorageTab() {
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<number | null | "unfiled">("unfiled");
  const [search, setSearch] = useState("");

  // Preview state
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewBlobUrl = useRef<string | null>(null);

  // Folder dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameFolderOpen, setRenameFolderOpen] = useState(false);
  const [renameFolderId, setRenameFolderId] = useState<number | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [deleteFolderId, setDeleteFolderId] = useState<number | null>(null);
  const [deleteFolderName, setDeleteFolderName] = useState("");
  const [deleteFolderHasFiles, setDeleteFolderHasFiles] = useState(false);

  // File dialogs
  const [renameFileOpen, setRenameFileOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<number | null>(null);
  const [renameFileName, setRenameFileName] = useState("");
  const [deleteFileId, setDeleteFileId] = useState<number | null>(null);
  const [deleteFileName, setDeleteFileName] = useState("");
  const [moveFileOpen, setMoveFileOpen] = useState(false);
  const [moveFileId, setMoveFileId] = useState<number | null>(null);
  const [moveFolderTarget, setMoveFolderTarget] = useState<string>("unfiled");

  const { data: folders = [], isLoading: foldersLoading } = useQuery<FileFolder[]>({
    queryKey: ["/api/file-folders"],
  });

  const { data: allFiles = [], isLoading: filesLoading } = useQuery<StoredFile[]>({
    queryKey: ["/api/files"],
  });

  const folderFiles = allFiles.filter((f) => {
    const match = selectedFolderId === "unfiled" ? f.folderId == null : f.folderId === selectedFolderId;
    if (!match) return false;
    if (!search.trim()) return true;
    return visibleName(f).toLowerCase().includes(search.toLowerCase());
  });

  const _fileCountForFolder = (id: number | null) =>
    allFiles.filter((f) => (id === null ? f.folderId == null : f.folderId === id)).length;

  const onRenameFolder = (id: number, name: string) => {
    setRenameFolderId(id);
    setRenameFolderName(name);
    setRenameFolderOpen(true);
  };

  const onDeleteFolder = (id: number, name: string, hasFiles: boolean) => {
    setDeleteFolderId(id);
    setDeleteFolderName(name);
    setDeleteFolderHasFiles(hasFiles);
  };

  const onNewFolder = () => setNewFolderOpen(true);

  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/file-folders", { name }),
    onSuccess: () => {
      toast({ title: "Folder created" });
      setNewFolderName("");
      setNewFolderOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/file-folders"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) =>
      apiRequest("PATCH", `/api/file-folders/${id}`, { name }),
    onSuccess: () => {
      toast({ title: "Folder renamed" });
      setRenameFolderOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/file-folders"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/file-folders/${id}`),
    onSuccess: () => {
      toast({ title: "Folder deleted" });
      setDeleteFolderId(null);
      if (selectedFolderId === deleteFolderId) setSelectedFolderId("unfiled");
      queryClient.invalidateQueries({ queryKey: ["/api/file-folders"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Cannot delete", description: e.message, variant: "destructive" });
      setDeleteFolderId(null);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (selectedFolderId !== "unfiled" && selectedFolderId !== null) {
        formData.append("folderId", String(selectedFolderId));
      }
      const res = await fetch("/api/files/upload", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "File uploaded" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    },
  });

  const renameFileMutation = useMutation({
    mutationFn: async ({ id, displayName }: { id: number; displayName: string }) =>
      apiRequest("PATCH", `/api/files/${id}`, { displayName }),
    onSuccess: () => {
      toast({ title: "File renamed" });
      setRenameFileOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const moveFileMutation = useMutation({
    mutationFn: async ({ id, folderId }: { id: number; folderId: number | null }) =>
      apiRequest("PATCH", `/api/files/${id}`, { folderId }),
    onSuccess: () => {
      toast({ title: "File moved" });
      setMoveFileOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/files/${id}`),
    onSuccess: () => {
      toast({ title: "File deleted" });
      setDeleteFileId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
    },
    onError: (e: ClientErrorLike) => {
      if (!e?._handledGlobally) toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const handleDownload = async (file: StoredFile) => {
    try {
      const res = await fetch(`/api/files/${file.id}/download`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = visibleName(file);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
  };

  const revokePreviewUrl = useCallback(() => {
    if (previewBlobUrl.current) {
      URL.revokeObjectURL(previewBlobUrl.current);
      previewBlobUrl.current = null;
    }
  }, []);

  const closePreview = useCallback(() => {
    revokePreviewUrl();
    setPreview(null);
  }, [revokePreviewUrl]);

  useEffect(() => () => revokePreviewUrl(), [revokePreviewUrl]);

  const openPreview = async (file: StoredFile) => {
    const type = getPreviewType(file);
    setPreview({ file, type, loading: true });
    try {
      const res = await fetch(`/api/files/${file.id}/preview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");

      if (type === "pdf" || type === "image") {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        previewBlobUrl.current = url;
        setPreview({ file, type, blobUrl: url, loading: false });
      } else if (type === "csv") {
        const text = await res.text();
        const rows = text
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const result: string[] = [];
            let cur = "";
            let inQ = false;
            for (const ch of line) {
              if (ch === '"') {
                inQ = !inQ;
              } else if (ch === "," && !inQ) {
                result.push(cur);
                cur = "";
              } else {
                cur += ch;
              }
            }
            result.push(cur);
            return result;
          });
        setPreview({ file, type, rows, loading: false });
      } else if (type === "text") {
        const text = await res.text();
        setPreview({ file, type, text, loading: false });
      } else if (type === "excel") {
        const ab = await res.arrayBuffer();
        try {
          const wb = await readFromBuffer(ab);
          const sheet = wb.worksheets[0];
          const rows: unknown[][] = [];
          sheet.eachRow((row) => {
            rows.push((row.values as unknown[]).slice(1));
          });
          setPreview({ file, type, rows, loading: false });
        } catch {
          setPreview({ file, type: "unsupported", loading: false });
        }
      } else {
        setPreview({ file, type: "unsupported", loading: false });
      }
    } catch {
      setPreview((p) => (p ? { ...p, loading: false, error: true } : null));
    }
  };

  const currentFolderName =
    selectedFolderId === "unfiled" ? "Unfiled" : (folders.find((f) => f.id === selectedFolderId)?.name ?? "Files");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Upload className="h-5 w-5" />
        <h2 className="text-2xl font-semibold">File Storage</h2>
      </div>

      <div className="flex gap-4 min-h-[600px]">
        {/* ── Left: Folder List ────────────────────────────────────────────── */}
        <FolderList
          selectedFolderId={selectedFolderId}
          setSelectedFolderId={setSelectedFolderId}
          allFiles={allFiles}
          folders={folders}
          foldersLoading={foldersLoading}
          onRename={onRenameFolder}
          onDelete={onDeleteFolder}
          onNewFolder={onNewFolder}
        />

        {/* ── Right: File Area ─────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium flex-1">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              {currentFolderName}
              <span className="text-muted-foreground font-normal text-xs">({folderFiles.length} files)</span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search files..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-44 h-8 text-sm"
                data-testid="input-file-search"
              />
            </div>
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
              data-testid="button-upload-file"
            >
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx,.csv,.doc,.docx,.txt,.gif,.bmp,.svg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMutation.mutate({ file });
              }}
              data-testid="input-file-picker"
            />
          </div>

          {/* File list */}
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
              <Table>
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
                            <span className="text-xs text-muted-foreground truncate max-w-[260px]">
                              {file.fileName}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {formatSize(file.fileSize)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDisplayDate(file.uploadedAt)}
                      </TableCell>
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
        </div>
      </div>

      {/* ── Preview Modal ────────────────────────────────────────────────────── */}
      <PreviewModal preview={preview} onClose={closePreview} onDownload={handleDownload} />

      <FileStorageDialogs
        newFolderOpen={newFolderOpen}
        setNewFolderOpen={setNewFolderOpen}
        newFolderName={newFolderName}
        setNewFolderName={setNewFolderName}
        createFolderMutation={createFolderMutation}
        renameFolderOpen={renameFolderOpen}
        setRenameFolderOpen={setRenameFolderOpen}
        renameFolderName={renameFolderName}
        setRenameFolderName={setRenameFolderName}
        renameFolderId={renameFolderId}
        renameFolderMutation={renameFolderMutation}
        deleteFolderId={deleteFolderId}
        setDeleteFolderId={setDeleteFolderId}
        deleteFolderName={deleteFolderName}
        deleteFolderHasFiles={deleteFolderHasFiles}
        deleteFolderMutation={deleteFolderMutation}
        renameFileOpen={renameFileOpen}
        setRenameFileOpen={setRenameFileOpen}
        renameFileName={renameFileName}
        setRenameFileName={setRenameFileName}
        renameFileId={renameFileId}
        renameFileMutation={renameFileMutation}
        moveFileOpen={moveFileOpen}
        setMoveFileOpen={setMoveFileOpen}
        moveFileId={moveFileId}
        moveFolderTarget={moveFolderTarget}
        setMoveFolderTarget={setMoveFolderTarget}
        folders={folders}
        moveFileMutation={moveFileMutation}
        deleteFileId={deleteFileId}
        setDeleteFileId={setDeleteFileId}
        deleteFileName={deleteFileName}
        deleteFileMutation={deleteFileMutation}
      />
    </div>
  );
}
