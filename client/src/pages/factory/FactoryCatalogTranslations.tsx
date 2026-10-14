import { Languages } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FactoryCatalogTranslationEditor } from "@/components/FactoryCatalogTranslationEditor";

/**
 * Arabic names for existing bale products and categories, picked from a list.
 * Bale Products edits the same fields inline; this page reaches records that
 * are not on screen there.
 */
export default function FactoryCatalogTranslations() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Catalog translations"
        subtitle="Edit the Arabic text of bale products and categories. English names and commercial fields are untouched."
        icon={<Languages className="h-5 w-5" />}
      >
        <FactoryCatalogTranslationEditor />
      </PageHeader>
    </div>
  );
}
