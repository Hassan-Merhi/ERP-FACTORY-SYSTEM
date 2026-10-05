import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell } from "@/components/ui/table";

interface OtwContainerActionsProps {
  containerId: number;
  hasChanges: (id: number) => boolean;
  saveTracking: (id: number) => Promise<void>;
  savingIds: Set<number>;
}

export function OtwContainerActions({
  containerId,
  hasChanges,
  saveTracking,
  savingIds,
}: OtwContainerActionsProps) {
  return (
    <TableCell>
      <div className="flex items-center gap-1">
        {hasChanges(containerId) && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => saveTracking(containerId)}
            disabled={savingIds.has(containerId)}
            data-testid={`button-save-${containerId}`}
          >
            {savingIds.has(containerId) ? (
              <span className="animate-spin">...</span>
            ) : (
              <Check className="h-4 w-4 text-green-600" />
            )}
          </Button>
        )}
      </div>
    </TableCell>
  );
}
