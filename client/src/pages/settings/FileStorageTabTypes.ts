// Extracted from ./FileStorageTab.tsx to keep that module under the source-size cap.

// ── Types ────────────────────────────────────────────────────────────────────
export interface FileFolder {
  id: number;
  name: string;
  companyId: number;
  createdAt: string;
}

export interface StoredFile {
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

export interface PreviewState {
  file: StoredFile;
  type: PreviewType;
  blobUrl?: string;
  text?: string;
  rows?: unknown[][];
  loading: boolean;
  error?: boolean;
}
