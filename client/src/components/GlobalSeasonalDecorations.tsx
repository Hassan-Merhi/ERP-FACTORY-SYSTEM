/**
 * Developer-controlled, per-user seasonal ambiance across authenticated ERP,
 * Factory, Properties, Supplier Partner and Retail workspaces.
 * The decorations are decorative only: they never intercept user input.
 */
import { useEffect } from "react";
import { Gift, Snowflake, Sparkles, Star, TreePine } from "lucide-react";
import "@/styles/christmas-decorations.css";

export function GlobalSeasonalDecorations({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    const root = document.documentElement;
    if (enabled) root.dataset.christmasMode = "on";
    else delete root.dataset.christmasMode;
    return () => {
      delete root.dataset.christmasMode;
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="seasonal-atmosphere" aria-hidden="true" data-testid="christmas-atmosphere">
      <div className="seasonal-atmosphere-sprig seasonal-atmosphere-sprig-left">
        <TreePine className="seasonal-atmosphere-tree" />
        <Star className="seasonal-atmosphere-star" />
        <span className="seasonal-atmosphere-berry" />
      </div>
      <div className="seasonal-atmosphere-sprig seasonal-atmosphere-sprig-right">
        <Gift className="seasonal-atmosphere-gift" />
        <Sparkles className="seasonal-atmosphere-star" />
        <span className="seasonal-atmosphere-berry" />
      </div>
      <div className="seasonal-atmosphere-flurry">
        <Snowflake className="seasonal-atmosphere-flurry-icon" />
      </div>
    </div>
  );
}
