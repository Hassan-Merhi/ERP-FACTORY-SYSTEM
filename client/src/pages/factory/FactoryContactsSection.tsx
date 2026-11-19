// Extracted from ./FactoryContacts.tsx to keep that module under the source-size cap.
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { TableViewOptions } from "@/components/TableViewOptions";
import { PaginationBar } from "@/components/PaginationBar";
import { Button } from "@/components/ui/button";
import { BookMarked, Filter, Plus, RefreshCw, UsersRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONTACT_COLUMNS, useFactoryContactsState, type Contact, type ContactFilter } from "./useFactoryContactsState";
import { FactoryContactsSectionContent } from "./FactoryContactsSectionContent";

export function FactoryContactsSection({
  canCreateContact,
  contactFilter,
  filtered,
  isLoading,
  openEdit,
  openNew,
  orderedContacts,
  pageSize,
  pages,
  prefs,
  queryClient,
  recordChanges,
  safePage,
  search,
  setContactFilter,
  setDeleteTarget,
  setPage,
  setPrefs,
  setSearch,
  show,
  summaryCards,
  visibility,
  visibleContacts,
}: Pick<
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
>) {
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="px-4 pt-5 sm:px-6">
        <PageHeader
          title="Contacts"
          subtitle="Personal reference — names, numbers, and notes"
          icon={<UsersRound className="h-5 w-5 text-indigo-600 dark:text-violet-300" />}
          showBackButton
        >
          <RowsExportMenu
            title="Contacts"
            rows={orderedContacts}
            columns={[
              { header: "Name", value: (c) => c.name },
              ...(show("role") ? [{ header: "Role", value: (c: Contact) => c.role }] : []),
              {
                header: "Phone Numbers",
                value: (c) => c.numbers.map((n) => (n.label ? `${n.number} (${n.label})` : n.number)).join("\n"),
              },
              ...(show("notes") ? [{ header: "Notes", value: (c: Contact) => c.notes }] : []),
            ]}
            resource="factory.employees"
            data-testid="button-export-contacts"
          />
          {canCreateContact && (
            <Button
              size="sm"
              onClick={openNew}
              data-testid="button-add-contact"
              className="gap-2 rounded-lg border border-indigo-500/40 bg-gradient-to-r from-indigo-600 to-violet-600 font-semibold text-white shadow-md shadow-indigo-600/20 hover:from-indigo-700 hover:to-violet-700 dark:border-violet-400/40"
            >
              <Plus className="h-4 w-4" />
              Add Contact
            </Button>
          )}
        </PageHeader>
      </div>

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Contact overview">
          {summaryCards.map(({ label, value, icon: Icon, tone, iconTone }) => (
            <div
              key={label}
              className={`flex min-w-0 items-center gap-3 rounded-2xl border p-3 shadow-sm sm:p-4 ${tone}`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl sm:h-12 sm:w-12 ${iconTone}`}
              >
                <Icon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 sm:text-sm">{label}</p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight text-slate-950 dark:text-white">
                  {isLoading ? "—" : value.toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>

        <DataTableToolbar
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="Search name, role, number…"
          className="mb-0 gap-3 rounded-xl border border-slate-200/90 bg-white/80 p-3 shadow-sm dark:border-indigo-400/15 dark:bg-card/80"
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2 rounded-lg dark:border-indigo-400/30 dark:bg-muted"
                  >
                    <Filter className="h-4 w-4" aria-hidden="true" />
                    Filters{contactFilter !== "all" ? " • 1" : ""}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuLabel>Show contacts</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={contactFilter}
                    onValueChange={(value) => {
                      setContactFilter(value as ContactFilter);
                      setPage(1);
                    }}
                  >
                    <DropdownMenuRadioItem value="all">All contacts</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="has-phone">With phone number</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="has-notes">With notes</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="missing-phone">Without phone number</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="missing-notes">Without notes</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <TableViewOptions
                columns={CONTACT_COLUMNS}
                visibility={visibility}
                density={prefs.density}
                onVisibilityChange={(key, value) => setPrefs({ columns: { ...visibility, [key]: value } })}
                onDensityChange={(value) => setPrefs({ density: value })}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Refresh contacts"
                title="Refresh contacts"
                className="h-9 w-9 rounded-lg dark:border-indigo-400/30 dark:bg-muted"
                onClick={() => void queryClient.invalidateQueries({ queryKey: ["/api/factory/contacts"] })}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              </Button>
            </>
          }
        />

        {isLoading ? (
          <div className="space-y-2" aria-label="Loading contacts">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-xl border border-slate-200 bg-white/70 dark:border-indigo-400/15 dark:bg-muted"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white/80 px-4 py-20 text-center dark:border-indigo-400/20 dark:bg-card">
            <BookMarked className="mb-4 h-12 w-12 text-indigo-300 dark:text-indigo-400/50" />
            <p className="text-sm text-muted-foreground">
              {search || contactFilter !== "all"
                ? "No contacts match your search or filters."
                : "No contacts yet. Add one to get started."}
            </p>
            {!search && contactFilter === "all" ? (
              canCreateContact && (
                <Button size="sm" className="mt-4" onClick={openNew}>
                  <Plus className="me-1 h-4 w-4" /> Add Contact
                </Button>
              )
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setSearch("");
                  setContactFilter("all");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <FactoryContactsSectionContent
            openEdit={openEdit}
            prefs={prefs}
            recordChanges={recordChanges}
            setDeleteTarget={setDeleteTarget}
            setPage={setPage}
            setPrefs={setPrefs}
            show={show}
            visibleContacts={visibleContacts}
          />
        )}

        <PaginationBar
          page={safePage}
          totalPages={pages}
          total={filtered.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPrefs({ pageSize: size });
            setPage(1);
          }}
          noun="contacts"
        />
      </div>
    </div>
  );
}
