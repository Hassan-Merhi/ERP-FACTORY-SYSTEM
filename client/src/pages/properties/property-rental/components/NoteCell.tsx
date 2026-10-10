import type { ClientErrorLike } from "@/lib/clientError";
/**
 * NoteCell — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Pencil, Check, X } from "lucide-react";
import { useApiBase } from "../shared";

export // ── Inline Note Cell ─────────────────────────────────────
function NoteCell({ contractId, note, testId }: { contractId: number; note: string | null; testId: string }) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setValue(note ?? "");
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing, note]);

  const save = useMutation({
    mutationFn: () => apiRequest("PATCH", `${apiBase}/contracts/${contractId}/note`, { notes: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      setEditing(false);
      toast({ title: "Note saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (editing) {
    return (
      <div className="flex flex-col gap-1 min-w-[160px]" onClick={(e) => e.stopPropagation()}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground resize-none focus:outline-hidden focus:ring-1 focus:ring-ring"
          placeholder="Add a note…"
          data-testid={`${testId}-note-input`}
        />
        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            data-testid={`${testId}-note-save`}
          >
            <Check className="h-3 w-3 mr-1" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => setEditing(false)}
            data-testid={`${testId}-note-cancel`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="group flex items-start gap-1 cursor-pointer min-w-[100px] max-w-[220px]"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      data-testid={`${testId}-note-display`}
    >
      {note ? (
        <span className="text-xs text-foreground leading-snug line-clamp-2 whitespace-pre-wrap">{note}</span>
      ) : (
        <span className="text-xs text-muted-foreground italic">Add note…</span>
      )}
      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-0.5 transition-opacity" />
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────
