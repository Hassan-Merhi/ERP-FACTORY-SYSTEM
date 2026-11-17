/**
 * EmptyState — extracted sub-component.
 *
 * Extracted from BaleProducts.tsx during the Phase 4 god-file split.
 */
import { Plus, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState as PageEmptyState } from "@/components/ui/page-state";

export function EmptyState({ onCreateClick }: { onCreateClick?: () => void }) {
  return (
    <PageEmptyState
      icon={Package}
      title="No products found"
      description="Create your first product to get started"
      action={
        onCreateClick ? (
          <Button className="mt-2" onClick={onCreateClick}>
            <Plus className="h-4 w-4 mr-2" />
            Create Product
          </Button>
        ) : undefined
      }
    />
  );
}
