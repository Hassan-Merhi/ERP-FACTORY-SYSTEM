// Extracted from ./InlineCells.tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { gitTrackingPatchUrl } from "./gitTrackingPatchUrl";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";

// Shared mutation hook — invalidates the full containers list on success
export function useInlinePatch(containerId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiRequest("PATCH", gitTrackingPatchUrl(containerId), patch),
    onSuccess: () => invalidateApiFamily(qc, "/api/git/containers"),
  });
}

export function InlineTextCell({
  id,
  field,
  value,
  mono,
  width,
  uppercase,
}: {
  id: number;
  field: string;
  value: string | null | undefined;
  mono?: boolean;
  width?: string;
  uppercase?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");
  const mutation = useInlinePatch(id);
  function save() {
    mutation.mutate({ [field]: val || null });
    setEditing(false);
  }
  if (editing)
    return (
      <input
        type="text"
        autoFocus
        value={val}
        onChange={(e) => setVal(uppercase ? e.target.value.toUpperCase() : e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setVal(value ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: width ?? "110px" }}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
    );
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setVal(value ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      className={cn(
        "cursor-text underline decoration-dashed underline-offset-2 decoration-muted-foreground/40",
        mono && "font-mono"
      )}
    >
      {value ? uppercase ? value.toUpperCase() : value : <span className="text-muted-foreground/50 text-xs">—</span>}
    </span>
  );
}

function getLocalDateYmd() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function InlineBoolCell({ id, field, value }: { id: number; field: string; value: boolean | null | undefined }) {
  const mutation = useInlinePatch(id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const nextValue = !value;
        const patch: Record<string, unknown> = { [field]: nextValue };

        // On the tracking table, the Docs checkmark records when the docs were sent.
        // Use the user's local calendar date so the saved day matches the day they clicked it.
        if (field === "docReceived") {
          patch.docsSentDate = nextValue ? getLocalDateYmd() : null;
        }

        mutation.mutate(patch);
      }}
      title={field === "docReceived" ? "Toggle docs and set Docs Sent date automatically" : "Click to toggle"}
      className="flex items-center justify-center"
    >
      {value ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-red-500" />
      )}
    </button>
  );
}
