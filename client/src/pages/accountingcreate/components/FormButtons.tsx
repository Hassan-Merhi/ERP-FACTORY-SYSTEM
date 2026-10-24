import { Button } from "@/components/ui/button";
import { Loader2, Plus } from "lucide-react";

export function FormButtons({
  onCancel,
  isPending,
  submitLabel = "Create",
}: {
  onCancel: () => void;
  isPending: boolean;
  submitLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/70 pt-5">
      <Button
        type="button"
        variant="outline"
        onClick={onCancel}
        disabled={isPending}
        data-testid="button-cancel"
        className="rounded-lg"
      >
        Clear fields
      </Button>
      <Button type="submit" disabled={isPending} data-testid="button-save" className="gap-2 rounded-lg px-5">
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
        {isPending ? "Creating..." : submitLabel}
      </Button>
    </div>
  );
}
