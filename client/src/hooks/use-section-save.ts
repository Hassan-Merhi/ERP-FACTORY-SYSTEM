import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

export interface UseSectionSaveOptions<T> {
  /** The values as last saved on the server (or the defaults while nothing is saved yet). */
  saved: T;
  /** Writes the draft. Throw (or reject) to report a failure. */
  save: (draft: T) => Promise<unknown>;
  /** Toast title after a successful save, e.g. "Receipt settings saved". */
  successTitle: string;
  successDescription?: string;
  /** Toast title when the save fails. */
  failureTitle?: string;
  /** Compares draft and saved values; defaults to a JSON comparison, enough for flat settings. */
  isEqual?: (a: T, b: T) => boolean;
}

export interface SectionSaveState<T> {
  draft: T;
  /** Replaces part of the draft. Nothing is written until `save` runs. */
  update: (patch: Partial<T>) => void;
  isDirty: boolean;
  isSaving: boolean;
  save: () => Promise<void>;
  /** Drops the unsaved edits and shows the saved values again. */
  reset: () => void;
}

const jsonEqual = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

function isHandledGlobally(error: unknown): boolean {
  return Boolean((error as { _handledGlobally?: boolean } | null)?._handledGlobally);
}

function errorText(error: unknown): string | undefined {
  if (error instanceof Error) return error.message || undefined;
  if (typeof error === "string") return error;
  return undefined;
}

/**
 * The one save model for Settings sections: edits stay a local draft, the section shows that it has
 * unsaved changes, and only its Save button writes them. Success and failure each raise one toast.
 * The draft follows the saved values until the user edits something, so a refetch never overwrites
 * an edit in progress, and a successful save hands the section back to the saved values.
 */
export function useSectionSave<T>({
  saved,
  save,
  successTitle,
  successDescription,
  failureTitle = "Save failed",
  isEqual = jsonEqual,
}: UseSectionSaveOptions<T>): SectionSaveState<T> {
  const { toast } = useToast();
  const [draft, setDraft] = useState<T>(saved);
  const [edited, setEdited] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const savedKey = JSON.stringify(saved);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const editedRef = useRef(edited);
  editedRef.current = edited;

  // Follow the server while the user has not edited anything. After a save the draft already
  // holds the saved values, so it is not reset to the pre-save snapshot while the refetch runs.
  useEffect(() => {
    if (!editedRef.current) setDraft(savedRef.current);
  }, [savedKey]);

  const update = useCallback((patch: Partial<T>) => {
    setEdited(true);
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setEdited(false);
    setDraft(savedRef.current);
  }, []);

  const isDirty = edited && !isEqual(draft, saved);

  const runSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await save(draft);
      setEdited(false);
      toast({ title: successTitle, description: successDescription });
    } catch (error) {
      if (!isHandledGlobally(error)) {
        toast({ title: failureTitle, description: errorText(error), variant: "destructive" });
      }
    } finally {
      setIsSaving(false);
    }
  }, [draft, failureTitle, save, successDescription, successTitle, toast]);

  return { draft, update, isDirty, isSaving, save: runSave, reset };
}
