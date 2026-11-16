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
import { PreviewModal, FileIcon, formatSize, visibleName } from "./FileStorageSections";
import { FolderList } from "./FolderList";
import { FileStorageDialogs } from "./FileStorageDialogs";
import { useFileStorageTabState } from "./useFileStorageTabState";

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
            <div className="relative max-sm:min-w-0 max-sm:flex-1 max-sm:basis-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search files..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-full sm:w-44 h-8 text-sm"
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
