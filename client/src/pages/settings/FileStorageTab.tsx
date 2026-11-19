import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Upload, Loader2, ChevronRight } from "lucide-react";
import { PreviewModal } from "./FileStorageSections";
import { FolderList } from "./FolderList";
import { FileStorageDialogs } from "./FileStorageDialogs";
import { useFileStorageTabState } from "./useFileStorageTabState";
import { FileStorageTabContent } from "./FileStorageTabContent";

// ── Main Component ────────────────────────────────────────────────────────────
export function FileStorageTab() {
  const {
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
  } = useFileStorageTabState();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Upload className="h-5 w-5" />
        <h2 className="text-2xl font-semibold">File Storage</h2>
      </div>

      <div className="flex flex-col gap-4 sm:min-h-[600px] sm:flex-row">
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
            <SearchField
              placeholder="Search files..."
              value={search}
              onValueChange={setSearch}
              wrapperClassName="max-sm:flex-1 max-sm:basis-full sm:w-44"
              className="h-8 text-sm"
              data-testid="input-file-search"
            />
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
          <FileStorageTabContent
            filesLoading={filesLoading}
            folderFiles={folderFiles}
            formatDisplayDate={formatDisplayDate}
            handleDownload={handleDownload}
            openPreview={openPreview}
            search={search}
            setDeleteFileId={setDeleteFileId}
            setDeleteFileName={setDeleteFileName}
            setMoveFileId={setMoveFileId}
            setMoveFileOpen={setMoveFileOpen}
            setMoveFolderTarget={setMoveFolderTarget}
            setRenameFileId={setRenameFileId}
            setRenameFileName={setRenameFileName}
            setRenameFileOpen={setRenameFileOpen}
          />
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
