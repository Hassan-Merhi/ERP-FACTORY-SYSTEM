import { FolderOpen, Folder, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

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

export function FolderList({
  selectedFolderId,
  setSelectedFolderId,
  allFiles,
  folders,
  foldersLoading,
  onRename,
  onDelete,
  onNewFolder,
}: {
  selectedFolderId: number | null | "unfiled";
  setSelectedFolderId: (id: number | null | "unfiled") => void;
  allFiles: StoredFile[];
  folders: FileFolder[];
  foldersLoading: boolean;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number, name: string, hasFiles: boolean) => void;
  onNewFolder: () => void;
}) {
  const fileCountForFolder = (id: number | null) =>
    allFiles.filter((f) => (id === null ? f.folderId == null : f.folderId === id)).length;

  return (
    <div className="w-full sm:w-52 shrink-0 flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1 mb-1">Folders</p>

      {/* Unfiled */}
      <button
        className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-left hover-elevate ${selectedFolderId === "unfiled" ? "bg-accent text-accent-foreground" : ""}`}
        onClick={() => setSelectedFolderId("unfiled")}
        data-testid="button-folder-unfiled"
      >
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">Unfiled</span>
        <Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">
          {fileCountForFolder(null)}
        </Badge>
      </button>

      {/* Created folders */}
      {foldersLoading ? (
        <div className="space-y-1 px-1">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        folders.map((folder) => (
          <div key={folder.id} className="group flex items-center gap-1 w-full">
            <button
              className={`flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5 rounded-md text-sm text-left hover-elevate ${selectedFolderId === folder.id ? "bg-accent text-accent-foreground" : ""}`}
              onClick={() => setSelectedFolderId(folder.id)}
              data-testid={`button-folder-${folder.id}`}
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{folder.name}</span>
              <Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">
                {fileCountForFolder(folder.id)}
              </Badge>
            </button>
            <div className="invisible group-hover:visible [@media(hover:none)]:visible flex items-center gap-0.5 shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => onRename(folder.id, folder.name)}
                data-testid={`button-rename-folder-${folder.id}`}
                title="Rename folder"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => onDelete(folder.id, folder.name, fileCountForFolder(folder.id) > 0)}
                data-testid={`button-delete-folder-${folder.id}`}
                title="Delete folder"
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          </div>
        ))
      )}

      <Button variant="outline" size="sm" className="mt-2 w-full" onClick={onNewFolder} data-testid="button-new-folder">
        <FolderPlus className="h-4 w-4 mr-2" />
        New Folder
      </Button>
    </div>
  );
}
