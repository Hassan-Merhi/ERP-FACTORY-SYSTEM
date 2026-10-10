import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarDays } from "lucide-react";
import { format, parse, isValid } from "date-fns";
import { dispatchDateJump } from "@/hooks/use-date-jump";

function parseFlexibleDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  // YYYY-MM-DD
  let d = parse(s, "yyyy-MM-dd", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  // DD/MM/YYYY
  d = parse(s, "dd/MM/yyyy", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  // D/M/YYYY
  d = parse(s, "d/M/yyyy", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  // DD-MM-YYYY
  d = parse(s, "dd-MM-yyyy", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  // DDMMYYYY (no separator — fast keyboard entry)
  if (/^\d{8}$/.test(s)) {
    d = parse(s, "ddMMyyyy", new Date());
    if (isValid(d) && d.getFullYear() > 1900) return d;
  }

  // DD/MM/YY
  d = parse(s, "dd/MM/yy", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  // D/M/YY
  d = parse(s, "d/M/yy", new Date());
  if (isValid(d) && d.getFullYear() > 1900) return d;

  return null;
}

export function DateJumpDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed = parseFlexibleDate(value);
  const isoDate = parsed ? format(parsed, "yyyy-MM-dd") : null;
  const displayDate = parsed ? format(parsed, "dd MMM yyyy") : null;

  const handleConfirm = useCallback(() => {
    if (!isoDate) return;
    dispatchDateJump(isoDate);
    setOpen(false);
    setValue("");
  }, [isoDate]);

  const handleOpen = useCallback(() => {
    setValue("");
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        handleOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleOpen]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setValue("");
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            Go to Date
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col gap-1.5">
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="DD/MM/YYYY or DDMMYYYY"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
                if (e.key === "Escape") {
                  setOpen(false);
                  setValue("");
                }
              }}
              data-testid="input-date-jump"
              className="text-base"
            />
            <p className="text-xs text-muted-foreground min-h-5">
              {displayDate ? (
                <span className="text-foreground font-medium">{displayDate}</span>
              ) : value.trim() ? (
                <span className="text-destructive">Unrecognised date — try DD/MM/YYYY</span>
              ) : (
                "Type a date and press Enter"
              )}
            </p>
          </div>

          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={!isoDate} onClick={handleConfirm} data-testid="button-date-jump-go">
              Go
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
