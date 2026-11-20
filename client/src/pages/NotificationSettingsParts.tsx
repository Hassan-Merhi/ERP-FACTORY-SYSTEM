// Extracted from ./NotificationSettings.tsx
import { searchAny } from "@shared/searchNormalization";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { UserPlus } from "lucide-react";

export interface NotifRule {
  id: number;
  eventType: string;
  recipientUserId: string;
  isEnabled: boolean;
}

export interface UserItem {
  id: string;
  username: string;
}

export const GROUP_COLORS: Record<string, string> = {
  Loading: "text-blue-500",
  Invoice: "text-amber-500",
  Intercompany: "text-purple-500",
};

export function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export function UserPicker({
  users,
  onAdd,
  disabled,
  eventId,
}: {
  users: UserItem[];
  onAdd: (userId: string) => void;
  disabled: boolean;
  eventId: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = users.filter((u) => searchAny(search, u.username));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (u: UserItem) => {
    onAdd(u.id);
    setSearch("");
    setOpen(false);
  };

  if (users.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchField
            ref={inputRef}
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setSearch("");
              }
              if (e.key === "Enter" && filtered.length === 1) {
                handleSelect(filtered[0]);
              }
            }}
            placeholder="Search user to add…"
            className="h-8 text-sm"
            disabled={disabled}
            data-testid={`input-search-user-${eventId}`}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || filtered.length === 0 || !search.trim()}
          onClick={() => {
            if (filtered.length === 1) handleSelect(filtered[0]);
          }}
          className="h-8 px-3 gap-1.5 text-xs"
          data-testid={`button-add-user-${eventId}`}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {open && filtered.length > 0 && search.trim() !== "" && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover shadow-md overflow-hidden">
          {filtered.slice(0, 8).map((u) => (
            <button
              key={u.id}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover-elevate text-left"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(u);
              }}
              data-testid={`option-user-${u.id}`}
            >
              <span className="flex items-center justify-center h-6 w-6 rounded-full bg-muted text-[11px] font-semibold shrink-0">
                {initials(u.username)}
              </span>
              <span>{u.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
