// Extracted from ./FileStorageTab.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { downloadBlob } from "@/lib/downloadBlob";
import { visibleName } from "./FileStorageSections";
import type { FileFolder, PreviewState, StoredFile } from "./FileStorageTabTypes";

export function useFileStorageTabStatePart1() {
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
    return searchAny(search, visibleName(f));
  });

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
      downloadBlob(blob, visibleName(file));
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
  return {
    allFiles,
    closePreview,
    createFolderMutation,
    deleteFileId,
    deleteFileMutation,
    deleteFileName,
    deleteFolderHasFiles,
    deleteFolderId,
    deleteFolderMutation,
    deleteFolderName,
    fileInputRef,
    filesLoading,
    folderFiles,
    folders,
    foldersLoading,
    formatDisplayDate,
    handleDownload,
    moveFileId,
    moveFileMutation,
    moveFileOpen,
    moveFolderTarget,
    newFolderName,
    newFolderOpen,
    onDeleteFolder,
    onNewFolder,
    onRenameFolder,
    preview,
    previewBlobUrl,
    renameFileId,
    renameFileMutation,
    renameFileName,
    renameFileOpen,
    renameFolderId,
    renameFolderMutation,
    renameFolderName,
    renameFolderOpen,
    search,
    selectedFolderId,
    setDeleteFileId,
    setDeleteFileName,
    setDeleteFolderId,
    setMoveFileId,
    setMoveFileOpen,
    setMoveFolderTarget,
    setNewFolderName,
    setNewFolderOpen,
    setPreview,
    setRenameFileId,
    setRenameFileName,
    setRenameFileOpen,
    setRenameFolderName,
    setRenameFolderOpen,
    setSearch,
    setSelectedFolderId,
    uploadMutation,
  };
}
