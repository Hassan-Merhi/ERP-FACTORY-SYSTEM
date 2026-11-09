/**
 * EmptyState — extracted sub-component.
 *
 * Extracted from BaleProducts.tsx during the Phase 4 god-file split.
 */
import { Plus, Package } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({ onCreateClick }: { onCreateClick?: () => void }) {
  return (
    <div className="text-center py-12">
      <Package className="mx-auto h-12 w-12 text-muted-foreground" />
      <h3 className="mt-4 text-lg font-semibold">No products found</h3>
      <p className="text-muted-foreground mt-2">Create your first product to get started</p>
      {onCreateClick && (
        <Button className="mt-4" onClick={onCreateClick}>
          <Plus className="h-4 w-4 mr-2" />
          Create Product
        </Button>
      )}
    </div>
  );
}
