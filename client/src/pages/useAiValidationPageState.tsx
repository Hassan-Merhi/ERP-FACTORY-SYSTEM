// Extracted from ./AiValidationPage.tsx to keep that module under the source-size cap.
import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { FileSpreadsheet, Upload, X } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValidationItem {
  row?: number;
  value?: string;
  message: string;
  detail?: string;
}

interface SuggestedFix {
  original: string;
  suggested: string;
  reason: string;
}

interface ValidationSummary {
  message?: string;
  codeColumn?: string;
  nameColumn?: string;
  totalChecked?: number;
  found?: number;
  missing?: number;
  duplicateInFile?: number;
  closeMatches?: number;
  duplicateGroups?: number;
  duplicateItems?: number;
}

interface ValidationResult {
  validationType: string;
  file1Name: string | null;
  file2Name: string | null;
  summary: ValidationSummary;
  errors: ValidationItem[];
  warnings: ValidationItem[];
  suggestedFixes: SuggestedFix[];
  cleanedExcel: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const VALIDATION_TYPES = [
  { value: "item_code_check", label: "Item Code Check", twoFiles: false, implemented: true },
  { value: "duplicate_name_check", label: "Duplicate Name Check", twoFiles: false, implemented: true },
  { value: "statement_compare", label: "Statement Compare", twoFiles: true, implemented: false },
  { value: "po_compare", label: "PO Compare", twoFiles: true, implemented: false },
  { value: "amount_total_check", label: "Amount Total Check", twoFiles: false, implemented: false },
  { value: "currency_conversion_check", label: "Currency Conversion Check", twoFiles: false, implemented: false },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FileDropZoneProps {
  label: string;
  file: File | null;
  onFile: (f: File | null) => void;
  testId: string;
}

export function FileDropZone({ label, file, onFile, testId }: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    },
    [onFile]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  };

  return (
    <div
      data-testid={testId}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={[
        "flex flex-col items-center justify-center gap-2 p-6 rounded-md border-2 border-dashed cursor-pointer transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={handleChange}
        data-testid={`${testId}-input`}
      />
      {file ? (
        <div className="flex items-center gap-2 w-full">
          <FileSpreadsheet className="w-5 h-5 text-primary shrink-0" />
          <span className="text-sm font-medium truncate flex-1">{file.name}</span>
          <Button
            size="icon"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            data-testid={`${testId}-clear`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <>
          <Upload className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">.xlsx, .xls, .csv</p>
        </>
      )}
    </div>
  );
}

export interface SummaryCardProps {
  label: string;
  value: number | string;
  variant?: "default" | "good" | "bad" | "warn";
}

export function useAiValidationPageState() {
  const { toast } = useToast();
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [validationType, setValidationType] = useState<string>("");
  const [result, setResult] = useState<ValidationResult | null>(null);

  const selectedType = VALIDATION_TYPES.find((t) => t.value === validationType);
  const needsTwoFiles = selectedType?.twoFiles ?? false;

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!file1) throw new Error("Please upload a file");
      if (!validationType) throw new Error("Please select a validation type");

      // Fetch CSRF token before multipart upload
      const csrfRes = await fetch("/api/csrf-token", { credentials: "include" });
      const csrfData = await csrfRes.json().catch(() => ({}));
      const csrfToken = typeof csrfData?.csrfToken === "string" ? csrfData.csrfToken : null;

      const form = new FormData();
      form.append("file1", file1);
      if (file2 && needsTwoFiles) form.append("file2", file2);
      form.append("validationType", validationType);

      const res = await fetch("/api/ai-validation/run", {
        method: "POST",
        body: form,
        credentials: "include",
        headers: {
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Validation failed" }));
        throw new Error(err.message || "Validation failed");
      }
      return res.json() as Promise<ValidationResult>;
    },
    onSuccess: (data) => {
      setResult(data);
    },
    onError: (err: Error) => {
      toast({ title: "Validation failed", description: err.message, variant: "destructive" });
    },
  });

  const downloadCleaned = () => {
    if (!result?.cleanedExcel) return;
    const bytes = Uint8Array.from(atob(result.cleanedExcel), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(blob, exportFileName(`validation ${result.validationType}`, "xlsx"));
  };

  // Build summary cards for the result
  const summaryCards = (): SummaryCardProps[] => {
    if (!result) return [];
    const s = result.summary;
    const cards: SummaryCardProps[] = [];

    if (typeof s.totalChecked === "number") cards.push({ label: "Total Rows", value: s.totalChecked });
    if (typeof s.found === "number")
      cards.push({ label: "Found", value: s.found, variant: s.found > 0 ? "good" : "default" });
    if (typeof s.missing === "number")
      cards.push({ label: "Missing", value: s.missing, variant: s.missing > 0 ? "bad" : "good" });
    if (typeof s.duplicateInFile === "number")
      cards.push({
        label: "Duplicates (file)",
        value: s.duplicateInFile,
        variant: s.duplicateInFile > 0 ? "bad" : "good",
      });
    if (typeof s.closeMatches === "number")
      cards.push({ label: "Close Matches", value: s.closeMatches, variant: s.closeMatches > 0 ? "warn" : "good" });
    if (typeof s.duplicateGroups === "number")
      cards.push({
        label: "Duplicate Groups",
        value: s.duplicateGroups,
        variant: s.duplicateGroups > 0 ? "warn" : "good",
      });
    if (typeof s.duplicateItems === "number")
      cards.push({ label: "Affected Rows", value: s.duplicateItems, variant: s.duplicateItems > 0 ? "warn" : "good" });

    return cards;
  };
  return {
    downloadCleaned,
    file1,
    file2,
    needsTwoFiles,
    result,
    runMutation,
    setFile1,
    setFile2,
    setValidationType,
    summaryCards,
    validationType,
  };
}
