// Extracted from ./FileStorageTab.tsx to keep that module under the source-size cap.
import { readFromBuffer } from "@/lib/excelHelper";
import { getPreviewType } from "./FileStorageSections";
import type { StoredFile } from "./FileStorageTabTypes";
import { useFileStorageTabStatePart1 } from "./useFileStorageTabStatePart1";

export function useFileStorageTabState() {
  const {
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
  } = useFileStorageTabStatePart1();
  const { currentFolderName, openPreview } = useFileStorageTabStatePart2({
    folders,
    previewBlobUrl,
    selectedFolderId,
    setPreview,
  });
  return {
    allFiles,
    closePreview,
    createFolderMutation,
    currentFolderName,
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
    openPreview,
    preview,
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

function useFileStorageTabStatePart2({
  folders,
  previewBlobUrl,
  selectedFolderId,
  setPreview,
}: Pick<
  Awaited<ReturnType<typeof useFileStorageTabStatePart1>>,
  "folders" | "previewBlobUrl" | "selectedFolderId" | "setPreview"
>) {
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
  return { currentFolderName, openPreview };
}
