import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { cn } from "@/lib/utils";

export interface SectionSaveBarProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  /** Drops the unsaved edits. */
  onReset: () => void;
  /** Disables Save for a reason other than "nothing changed" (for example no edit permission). */
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * Footer of a Settings section (or card): says whether there are unsaved changes and holds
 * Discard + Save changes, bottom-right. Pair it with `useSectionSave`, which keeps the draft and
 * raises the success / failure toast.
 */
export function SectionSaveBar({
  isDirty,
  isSaving,
  onSave,
  onReset,
  disabled = false,
  className,
  "data-testid": testId = "section-save-bar",
}: SectionSaveBarProps) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 border-t pt-3", className)}
      data-testid={testId}
      data-dirty={isDirty ? "true" : "false"}
    >
      <p className="mr-auto text-xs text-muted-foreground" role="status" data-testid={`${testId}-status`}>
        {isDirty ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
            <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
            Unsaved changes
          </span>
        ) : null}
      </p>
      {isDirty && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={isSaving}
          data-testid={`${testId}-discard`}
        >
          Discard
        </Button>
      )}
      <FormSubmitButton
        type="button"
        size="sm"
        onClick={onSave}
        pending={isSaving}
        disabled={!isDirty || disabled}
        data-testid={`${testId}-save`}
      >
        Save changes
      </FormSubmitButton>
    </div>
  );
}
