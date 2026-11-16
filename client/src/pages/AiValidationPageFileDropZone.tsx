// Extracted from ./AiValidationPage.tsx to keep that module under the source-size cap.
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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

export interface ValidationResult {
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

export function SummaryCard({ label, value, variant = "default" }: SummaryCardProps) {
  const colors: Record<string, string> = {
    default: "text-foreground",
    good: "text-green-600 dark:text-green-400",
    bad: "text-destructive",
    warn: "text-amber-600 dark:text-amber-400",
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-4">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${colors[variant]}`}>{value}</span>
    </div>
  );
}
