// Extracted from ./FactoryContactsSection.tsx
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowUpDown, Pencil, Phone, Trash2 } from "lucide-react";
import { CopyButton, roleAccent, useFactoryContactsState } from "./useFactoryContactsState";

export function FactoryContactsSectionContent({
  openEdit,
  prefs,
  recordChanges,
  setDeleteTarget,
  setPage,
  setPrefs,
  show,
  visibleContacts,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryContactsState>,
    | "canCreateContact"
    | "contactFilter"
    | "filtered"
    | "isLoading"
    | "openEdit"
    | "openNew"
    | "orderedContacts"
    | "pageSize"
    | "pages"
    | "prefs"
    | "queryClient"
    | "recordChanges"
    | "safePage"
    | "search"
    | "setContactFilter"
    | "setDeleteTarget"
    | "setPage"
    | "setPrefs"
    | "setSearch"
    | "show"
    | "summaryCards"
    | "visibility"
    | "visibleContacts"
  >,
  "openEdit" | "prefs" | "recordChanges" | "setDeleteTarget" | "setPage" | "setPrefs" | "show" | "visibleContacts"
>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 p-1 shadow-lg shadow-slate-200/30 dark:border-indigo-400/25 dark:bg-card/95 dark:shadow-black/20 sm:p-1.5">
      <Table
        mobileLayout="cards"
        density={prefs.density}
        data-testid="factory-contacts-table"
        wrapperClassName="rounded-xl border-0 dark:border-0"
      >
        <TableHeader className="bg-indigo-50 dark:bg-muted">
          <TableRow className="border-indigo-200 bg-indigo-50 hover:bg-indigo-50 dark:border-indigo-400/25 dark:bg-muted dark:hover:bg-muted">
            <TableHead className="w-[180px] text-indigo-900 dark:text-indigo-100">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-sm text-start hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-white"
                onClick={() => {
                  setPrefs({ sortDir: prefs.sortDir === "desc" ? "asc" : "desc" });
                  setPage(1);
                }}
                aria-label={`Sort by name ${prefs.sortDir === "desc" ? "ascending" : "descending"}`}
                title="Sort by name"
              >
                Name <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TableHead>
            {show("role") && <TableHead className="w-[140px] text-indigo-900 dark:text-indigo-100">Role</TableHead>}
            <TableHead className="text-indigo-900 dark:text-indigo-100">Phone Numbers</TableHead>
            {show("notes") && <TableHead className="text-indigo-900 dark:text-indigo-100">Notes</TableHead>}
            <TableHead className="w-[95px] text-right text-indigo-900 dark:text-indigo-100">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleContacts.map((c) => (
            <TableRow
              key={c.id}
              className="group border-slate-200/80 odd:bg-white even:bg-slate-50/80 hover:bg-indigo-50/70 dark:border-indigo-400/15 dark:odd:bg-card dark:even:bg-muted/30 dark:hover:bg-indigo-500/15"
            >
              <TableCell className="align-top font-semibold text-slate-900 dark:text-slate-100">{c.name}</TableCell>
              {show("role") && (
                <TableCell className="align-top">
                  {c.role ? (
                    <span
                      className={`inline-flex max-w-full items-center rounded-md border px-2 py-1 text-[11px] font-semibold leading-tight ${roleAccent(c.role)}`}
                    >
                      {c.role}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="align-top">
                {c.numbers.length > 0 ? (
                  <div className="space-y-0.5">
                    {c.numbers.map((n, i) => (
                      <div key={i} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                        <Phone
                          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                        <span className="font-mono font-medium text-slate-800 dark:text-slate-100">{n.number}</span>
                        {n.label && <span className="text-xs text-muted-foreground">({n.label})</span>}
                        <CopyButton text={n.number} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              {show("notes") && (
                <TableCell className="align-top sm:max-w-[260px]">
                  {c.notes ? (
                    <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                      {c.notes}
                    </p>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="align-top text-right">
                {recordChanges.allowed && (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 rounded-lg text-indigo-600 hover:bg-indigo-100 hover:text-indigo-800 dark:text-blue-300 dark:hover:bg-blue-400/15"
                      aria-label={`Edit ${c.name}`}
                      data-testid={`button-edit-contact-${c.id}`}
                      onClick={() => openEdit(c)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-500/15"
                      aria-label={`Delete ${c.name}`}
                      data-testid={`button-delete-contact-${c.id}`}
                      onClick={() => setDeleteTarget(c)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
