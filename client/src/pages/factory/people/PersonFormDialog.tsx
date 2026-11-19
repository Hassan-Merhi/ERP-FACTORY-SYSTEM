/**
 * One add/edit dialog layout for Factory Workers and Employees: same width,
 * scrolling body split into titled sections, and the standard Cancel / Save
 * footer. Each page supplies its own fields and save handler.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PersonFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  onSave: () => void;
  saving: boolean;
  /** False hides Save (the user may look but not change the record). */
  canSave?: boolean;
  saveDisabled?: boolean;
  testIds: { dialog: string; cancel: string; save: string };
}

export function PersonFormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSave,
  saving,
  canSave = true,
  saveDisabled = false,
  testIds,
}: PersonFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid={testIds.dialog}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-1">{children}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid={testIds.cancel}>
            Cancel
          </Button>
          {canSave && (
            <Button onClick={onSave} disabled={saving || saveDisabled} data-testid={testIds.save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A titled group of form fields inside `PersonFormDialog`. */
export function PersonFormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h4>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}
