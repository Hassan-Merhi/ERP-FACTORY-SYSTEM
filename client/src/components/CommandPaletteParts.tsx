// Extracted from ./CommandPalette.tsx
import { CommandItem } from "@/components/ui/command";
import type { NavItem, NavSection } from "@/components/sidebar/sidebarPrimitives";
import { DESCRIPTIONS, type PageEntry } from "./CommandPaletteDESCRIPTIONS";

function navItemToEntry(item: NavItem): PageEntry {
  return {
    label: item.title,
    description: DESCRIPTIONS[item.url],
    path: item.url,
    icon: item.icon,
  };
}

export function buildEntries(
  sections: NavSection[],
  extras: PageEntry[] = [],
  extraNavItems: NavItem[] = []
): PageEntry[] {
  const seen = new Set<string>();
  const out: PageEntry[] = [];
  for (const e of extras) {
    if (!seen.has(e.path)) {
      seen.add(e.path);
      out.push(e);
    }
  }
  for (const item of extraNavItems) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      out.push(navItemToEntry(item));
    }
  }
  for (const section of sections) {
    for (const item of section.items) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        out.push(navItemToEntry(item));
      }
    }
  }
  return out;
}

export function PaletteItem({ page, onSelect }: { page: PageEntry; onSelect: (path: string) => void }) {
  const Icon = page.icon;
  return (
    <CommandItem
      key={page.path}
      value={`${page.label} ${page.description ?? ""}`}
      onSelect={() => onSelect(page.path)}
      data-testid={`command-item-${page.path.replace(/\//g, "-").replace(/^-/, "") || "home"}`}
    >
      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
      <div className="flex flex-col">
        <span>{page.label}</span>
        {page.description && <span className="text-xs text-muted-foreground">{page.description}</span>}
      </div>
    </CommandItem>
  );
}
