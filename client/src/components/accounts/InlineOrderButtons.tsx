import type { DragEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface InlineOrderActions {
  canArrange: boolean;
  arranging: boolean;
  isSaving: boolean;
  swap: (key: string, targetKey: string) => void;
  move: (key: string, targetKey: string) => void;
}

export function InlineOrderButtons({
  label,
  nodeKey,
  siblingKeys,
  actions,
}: {
  label: string;
  nodeKey: string | null;
  siblingKeys: string[];
  actions?: InlineOrderActions;
}) {
  if (!nodeKey || !actions?.arranging || !actions.canArrange) return null;
  const index = siblingKeys.indexOf(nodeKey);
  if (index < 0) return null;
  return (
    <span className="inline-flex items-center shrink-0" onClick={(event) => event.stopPropagation()}>
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        disabled={actions.isSaving || index === 0}
        aria-label={`Move ${label} up`}
        onClick={() => actions.swap(nodeKey, siblingKeys[index - 1])}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        disabled={actions.isSaving || index === siblingKeys.length - 1}
        aria-label={`Move ${label} down`}
        onClick={() => actions.swap(nodeKey, siblingKeys[index + 1])}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

/** Native drag/drop without changing a ledger account's accounting parent. */
export function inlineDrag(nodeKey: string | null, actions?: InlineOrderActions) {
  const enabled = !!nodeKey && !!actions?.canArrange && !!actions?.arranging;
  return {
    draggable: enabled,
    onDragStart: (event: DragEvent) => {
      if (!enabled || !nodeKey) return;
      event.dataTransfer.setData("text/plain", nodeKey);
      event.dataTransfer.effectAllowed = "move";
      event.stopPropagation();
    },
    onDragOver: (event: DragEvent) => {
      if (enabled) event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      if (!enabled || !nodeKey) return;
      event.preventDefault();
      event.stopPropagation();
      const from = event.dataTransfer.getData("text/plain");
      if (from && from !== nodeKey) actions?.move(from, nodeKey);
    },
  };
}
