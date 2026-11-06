import { Sparkles, TreePine } from "lucide-react";

/**
 * Small tree ornament for workspace sidebar headers.
 * Hidden by default, purely decorative, and controlled by the global
 * [data-christmas-mode="on"] attribute set by GlobalSeasonalDecorations.
 */
export function SeasonalBrandAccent() {
  return (
    <span data-seasonal-brand-accent="" aria-hidden="true">
      <Sparkles className="seasonal-brand-sparkle" />
      <TreePine className="seasonal-brand-tree" />
    </span>
  );
}
