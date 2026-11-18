import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** The phone/tablet sale-notes field (moved out of PosMobileLayout to keep that file under its size cap). */
export function PosMobileNotes({ notes, setNotes }: { notes: string; setNotes: (v: string) => void }) {
  return (
    <section className="px-3 pb-4 sm:px-4" aria-label="Sale notes">
      <Label htmlFor="input-mobile-notes" className="mb-1.5 block text-xs text-muted-foreground">
        Notes
      </Label>
      <Textarea
        id="input-mobile-notes"
        placeholder="Optional notes"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        className="min-h-24 resize-y text-base"
        data-testid="input-mobile-notes"
      />
    </section>
  );
}
