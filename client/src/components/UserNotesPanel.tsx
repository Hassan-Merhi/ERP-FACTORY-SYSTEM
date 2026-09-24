import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NotebookPen, Save, Check } from "lucide-react";

const NOTES_KEY = "/api/user/notes";
const DEBOUNCE_MS = 1200;
const POS_KEY = "user-notes-btn-pos";

interface NotesData {
  content: string;
  updatedAt: string | null;
}

function getSavedPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.x === "number" && typeof p.y === "number") return p;
    }
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
  return { x: 20, y: window.innerHeight - 120 };
}

/** Opens the notes panel from other surfaces (the ERP phone workspace menu). */
export const USER_NOTES_OPEN_EVENT = "user-notes:open";

export function UserNotesPanel() {
  const [open, setOpen] = useState(false);

  // While mounted (the user has notes enabled), advertise the panel and accept open requests.
  useEffect(() => {
    const root = document.documentElement;
    const openPanel = () => setOpen(true);
    root.dataset.userNotes = "available";
    window.addEventListener(USER_NOTES_OPEN_EVENT, openPanel);
    return () => {
      delete root.dataset.userNotes;
      window.removeEventListener(USER_NOTES_OPEN_EVENT, openPanel);
    };
  }, []);
  const [draft, setDraft] = useState<string | null>(null);
  const [savedRecently, setSavedRecently] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>(getSavedPos);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragState = useRef<{ startMouseX: number; startMouseY: number; startBtnX: number; startBtnY: number } | null>(
    null
  );
  const didDrag = useRef(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const { data, isLoading } = useQuery<NotesData>({
    queryKey: [NOTES_KEY],
    enabled: open,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (data && draft === null) setDraft(data.content);
  }, [data, draft]);

  const saveMutation = useMutation({
    mutationFn: (content: string) => apiRequest("PUT", NOTES_KEY, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [NOTES_KEY] });
      setSavedRecently(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedRecently(false), 2000);
    },
  });

  const scheduleSave = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => saveMutation.mutate(value), DEBOUNCE_MS);
    },
    [saveMutation]
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setDraft(value);
    scheduleSave(value);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (draft !== null && draft !== (data?.content ?? "")) saveMutation.mutate(draft);
      setDraft(null);
    }
  }

  function clamp(val: number, min: number, max: number) {
    return Math.max(min, Math.min(max, val));
  }

  function onMouseDown(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    didDrag.current = false;
    dragState.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startBtnX: pos.x,
      startBtnY: pos.y,
    };

    function onMouseMove(ev: MouseEvent) {
      if (!dragState.current) return;
      const dx = ev.clientX - dragState.current.startMouseX;
      const dy = ev.clientY - dragState.current.startMouseY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      if (!didDrag.current) return;

      const newX = clamp(dragState.current.startBtnX + dx, 0, window.innerWidth - 48);
      const newY = clamp(dragState.current.startBtnY + dy, 0, window.innerHeight - 48);
      setPos({ x: newX, y: newY });
    }

    function onMouseUp() {
      if (dragState.current && didDrag.current) {
        setPos((p) => {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
          return p;
        });
      }
      dragState.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function handleClick() {
    if (!didDrag.current) setOpen(true);
  }

  function formatUpdated(iso: string | null | undefined): string {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return `Saved ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    } catch {
      return "";
    }
  }

  const displayContent = draft ?? data?.content ?? "";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={btnRef}
            onMouseDown={onMouseDown}
            onClick={handleClick}
            data-testid="button-open-user-notes"
            aria-label="My notes"
            style={{ left: pos.x, top: pos.y }}
            className="group fixed z-50 flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-md px-3 py-2 opacity-30 hover:opacity-100 transition-all duration-300 ease-in-out overflow-hidden max-w-[2.25rem] hover:max-w-[120px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring select-none cursor-grab active:cursor-grabbing"
          >
            <NotebookPen className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-100">
              My Notes
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">My notes — drag to move</TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="flex flex-col w-full sm:max-w-md p-0" data-testid="panel-user-notes">
          <SheetHeader className="px-5 pt-5 pb-3 border-b flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="flex items-center gap-2 text-base">
                <NotebookPen className="h-4 w-4 text-muted-foreground" />
                My Notes
              </SheetTitle>
              <div className="flex items-center gap-2">
                {saveMutation.isPending && <span className="text-xs text-muted-foreground">Saving…</span>}
                {savedRecently && !saveMutation.isPending && (
                  <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <Check className="h-3.5 w-3.5" />
                    Saved
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (debounceRef.current) clearTimeout(debounceRef.current);
                    saveMutation.mutate(displayContent);
                  }}
                  disabled={saveMutation.isPending}
                  data-testid="button-save-notes"
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  Save
                </Button>
              </div>
            </div>
            {data?.updatedAt && !savedRecently && (
              <p className="text-xs text-muted-foreground mt-0.5">{formatUpdated(data.updatedAt)}</p>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-hidden p-4">
            {isLoading ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              <Textarea
                value={displayContent}
                onChange={handleChange}
                placeholder="Type anything here — just for you. Auto-saves as you type."
                className="h-full resize-none text-sm leading-relaxed border-0 focus-visible:ring-0 p-0"
                data-testid="textarea-user-notes"
                autoFocus={open}
              />
            )}
          </div>

          <div className="px-5 pb-4 pt-2 border-t flex-shrink-0">
            <p className="text-xs text-muted-foreground">Only you can see these notes.</p>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
