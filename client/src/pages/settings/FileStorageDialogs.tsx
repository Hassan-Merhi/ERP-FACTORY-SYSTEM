import type { Dispatch, SetStateAction } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface FileFolder {
  id: number;
  name: string;
}

type MutationLike<TVariables> = {
  mutate: (variables: TVariables) => void;
  isPending: boolean;
};

interface FileStorageDialogsProps {
  newFolderOpen: boolean;
  setNewFolderOpen: Dispatch<SetStateAction<boolean>>;
  newFolderName: string;
  setNewFolderName: Dispatch<SetStateAction<string>>;
  createFolderMutation: MutationLike<string>;
  renameFolderOpen: boolean;
  setRenameFolderOpen: Dispatch<SetStateAction<boolean>>;
  renameFolderName: string;
  setRenameFolderName: Dispatch<SetStateAction<string>>;
  renameFolderId: number | null;
  renameFolderMutation: MutationLike<{ id: number; name: string }>;
  deleteFolderId: number | null;
  setDeleteFolderId: Dispatch<SetStateAction<number | null>>;
  deleteFolderName: string;
  deleteFolderHasFiles: boolean;
  deleteFolderMutation: MutationLike<number>;
  renameFileOpen: boolean;
  setRenameFileOpen: Dispatch<SetStateAction<boolean>>;
  renameFileName: string;
  setRenameFileName: Dispatch<SetStateAction<string>>;
  renameFileId: number | null;
  renameFileMutation: MutationLike<{ id: number; displayName: string }>;
  moveFileOpen: boolean;
  setMoveFileOpen: Dispatch<SetStateAction<boolean>>;
  moveFileId: number | null;
  moveFolderTarget: string;
  setMoveFolderTarget: Dispatch<SetStateAction<string>>;
  folders: FileFolder[];
  moveFileMutation: MutationLike<{ id: number; folderId: number | null }>;
  deleteFileId: number | null;
  setDeleteFileId: Dispatch<SetStateAction<number | null>>;
  deleteFileName: string;
  deleteFileMutation: MutationLike<number>;
}

export function FileStorageDialogs({
  newFolderOpen,
  setNewFolderOpen,
  newFolderName,
  setNewFolderName,
  createFolderMutation,
  renameFolderOpen,
  setRenameFolderOpen,
  renameFolderName,
  setRenameFolderName,
  renameFolderId,
  renameFolderMutation,
  deleteFolderId,
  setDeleteFolderId,
  deleteFolderName,
  deleteFolderHasFiles,
  deleteFolderMutation,
  renameFileOpen,
  setRenameFileOpen,
  renameFileName,
  setRenameFileName,
  renameFileId,
  renameFileMutation,
  moveFileOpen,
  setMoveFileOpen,
  moveFileId,
  moveFolderTarget,
  setMoveFolderTarget,
  folders,
  moveFileMutation,
  deleteFileId,
  setDeleteFileId,
  deleteFileName,
  deleteFileMutation,
}: FileStorageDialogsProps) {
  return (
    <>
      {/* ── New Folder Dialog ────────────────────────────────────────────────── */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newFolderName.trim()) createFolderMutation.mutate(newFolderName.trim());
            }}
            autoFocus
            data-testid="input-new-folder-name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newFolderName.trim() || createFolderMutation.isPending}
              onClick={() => createFolderMutation.mutate(newFolderName.trim())}
              data-testid="button-create-folder-confirm"
            >
              {createFolderMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename Folder Dialog ─────────────────────────────────────────────── */}
      <Dialog open={renameFolderOpen} onOpenChange={setRenameFolderOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Folder</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Folder name"
            value={renameFolderName}
            onChange={(e) => setRenameFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameFolderName.trim() && renameFolderId)
                renameFolderMutation.mutate({ id: renameFolderId, name: renameFolderName.trim() });
            }}
            autoFocus
            data-testid="input-rename-folder"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!renameFolderName.trim() || renameFolderMutation.isPending}
              onClick={() => {
                if (renameFolderId) renameFolderMutation.mutate({ id: renameFolderId, name: renameFolderName.trim() });
              }}
              data-testid="button-rename-folder-confirm"
            >
              {renameFolderMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Folder Dialog ─────────────────────────────────────────────── */}
      <AlertDialog
        open={deleteFolderId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder "{deleteFolderName}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFolderHasFiles
                ? "This folder still has files. Move or delete them before removing the folder."
                : "This folder will be permanently deleted. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!deleteFolderHasFiles && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground"
                onClick={() => {
                  if (deleteFolderId) deleteFolderMutation.mutate(deleteFolderId);
                }}
                data-testid="button-confirm-delete-folder"
              >
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Rename File Dialog ───────────────────────────────────────────────── */}
      <Dialog open={renameFileOpen} onOpenChange={setRenameFileOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Display name"
            value={renameFileName}
            onChange={(e) => setRenameFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameFileName.trim() && renameFileId)
                renameFileMutation.mutate({ id: renameFileId, displayName: renameFileName.trim() });
            }}
            autoFocus
            data-testid="input-rename-file"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFileOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!renameFileName.trim() || renameFileMutation.isPending}
              onClick={() => {
                if (renameFileId) renameFileMutation.mutate({ id: renameFileId, displayName: renameFileName.trim() });
              }}
              data-testid="button-rename-file-confirm"
            >
              {renameFileMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Move File Dialog ─────────────────────────────────────────────────── */}
      <Dialog open={moveFileOpen} onOpenChange={setMoveFileOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Move File</DialogTitle>
          </DialogHeader>
          <Select value={moveFolderTarget} onValueChange={setMoveFolderTarget}>
            <SelectTrigger data-testid="select-move-destination">
              <SelectValue placeholder="Select folder..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unfiled">Unfiled</SelectItem>
              {folders.map((f: FileFolder) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveFileOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={moveFileMutation.isPending}
              onClick={() => {
                if (!moveFileId) return;
                const folderId = moveFolderTarget === "unfiled" ? null : parseInt(moveFolderTarget);
                moveFileMutation.mutate({ id: moveFileId, folderId });
              }}
              data-testid="button-move-file-confirm"
            >
              {moveFileMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete File Dialog ───────────────────────────────────────────────── */}
      <AlertDialog
        open={deleteFileId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFileId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteFileName}" will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (deleteFileId) deleteFileMutation.mutate(deleteFileId);
              }}
              data-testid="button-confirm-delete-file"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
