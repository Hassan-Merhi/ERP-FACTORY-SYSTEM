// Extracted from ./FileStorageDialogs.tsx
import type { Dispatch, SetStateAction } from "react";

export interface FileFolder {
  id: number;
  name: string;
}

type MutationLike<TVariables> = {
  mutate: (variables: TVariables) => void;
  isPending: boolean;
};

export interface FileStorageDialogsProps {
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
