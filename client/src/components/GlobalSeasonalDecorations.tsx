/**
 * Developer-controlled, per-user seasonal ambiance across authenticated ERP,
 * Factory, Properties, Supplier Partner and Retail workspaces.
 * The decorations are decorative only: they never intercept user input.
 */
import { useEffect } from "react";
import { Gift, Snowflake, Sparkles, Star, TreePine } from "lucide-react";
import "@/styles/christmas-decorations.css";

export function GlobalSeasonalDecorations({
  enabled,
  garlands = true,
  snowCaps = true,
  intensity = "balanced",
}: {
  enabled: boolean;
  garlands?: boolean;
  snowCaps?: boolean;
  intensity?: "subtle" | "balanced" | "full";
}) {
  useEffect(() => {
    const root = document.documentElement;
    if (enabled) {
      root.dataset.christmasMode = "on";
      root.dataset.christmasGarlands = garlands ? "on" : "off";
      root.dataset.christmasSnowcaps = snowCaps ? "on" : "off";
      root.dataset.christmasIntensity = intensity;
    } else {
      delete root.dataset.christmasMode;
      delete root.dataset.christmasGarlands;
      delete root.dataset.christmasSnowcaps;
      delete root.dataset.christmasIntensity;
    }
    return () => {
      delete root.dataset.christmasMode;
      delete root.dataset.christmasGarlands;
      delete root.dataset.christmasSnowcaps;
      delete root.dataset.christmasIntensity;
    };
  }, [enabled, garlands, snowCaps, intensity]);

  if (!enabled || !garlands) return null;

  return (
    <div className="seasonal-atmosphere" aria-hidden="true" data-testid="christmas-atmosphere">
      <div className="seasonal-garland-band" aria-hidden="true">
        <span className="seasonal-garland-bow" />
        <span className="seasonal-garland-ornament seasonal-ornament-red" />
        <span className="seasonal-garland-ornament seasonal-ornament-gold" />
        <span className="seasonal-garland-ornament seasonal-ornament-green" />
      </div>
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
