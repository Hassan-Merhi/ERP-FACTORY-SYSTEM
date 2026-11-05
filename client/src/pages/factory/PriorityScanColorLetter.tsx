import { getPriorityScanLetter, getPriorityScanLetterInk } from "@shared/priorityScanColors";

/**
 * An approved priority color always displays its fixed assigned letter.
 * Legacy/unsupported saved colors keep their visible swatch without inventing a letter.
 */
export function PriorityScanColorLetter({
  color,
  size = "md",
}: {
  color: string;
  size?: "sm" | "md";
}) {
  const letter = getPriorityScanLetter(color);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-black/20 font-bold shadow-xs ${size === "sm" ? "h-6 w-6 text-xs" : "h-8 w-8 text-sm"}`}
      style={{ backgroundColor: color, color: letter ? getPriorityScanLetterInk(color) : undefined }}
      role="img"
      aria-label={letter ? `Priority color ${color.toUpperCase()}, letter ${letter}` : `Legacy priority color ${color}`}
      title={letter ? `${letter} · ${color.toUpperCase()}` : color}
    >
      {letter}
    </span>
  );
}
