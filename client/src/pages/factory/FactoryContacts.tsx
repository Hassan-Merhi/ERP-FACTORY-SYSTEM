import { searchAny } from "@shared/searchNormalization";
import { useId, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { useSingleFlightAction } from "@/hooks/use-single-flight-action";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { TableViewOptions, type TableColumnOption } from "@/components/TableViewOptions";
import { PaginationBar } from "@/components/PaginationBar";
import { useTablePrefs } from "@/hooks/use-table-prefs";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Phone,
  Pencil,
  Trash2,
  Copy,
  BookMarked,
  X,
  Check,
  UsersRound,
  NotebookText,
  Tags,
  RefreshCw,
  Filter,
  ArrowUpDown,
  PhoneCall,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface PhoneEntry {
  label: string;
  number: string;
}

interface Contact {
  id: number;
  companyId: number;
  name: string;
  role: string | null;
  numbers: PhoneEntry[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_FORM = {
  name: "",
  role: "",
  numbers: [{ label: "Mobile", number: "" }] as PhoneEntry[],
  notes: "",
};

const CONTACT_COLUMNS: TableColumnOption[] = [
  { key: "name", label: "Name", required: true },
  { key: "role", label: "Role" },
  { key: "phones", label: "Phone Numbers", required: true },
  { key: "notes", label: "Notes" },
  { key: "actions", label: "Actions", required: true },
];

type ContactFilter = "all" | "has-phone" | "has-notes" | "missing-phone" | "missing-notes";

function roleAccent(role: string): string {
  const value = role.toLowerCase();
  if (/strapping|rolls/.test(value))
    return "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-400/35 dark:bg-violet-500/15 dark:text-violet-200";
  if (/forklift|electric|maintenance/.test(value))
    return "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-200";
  if (/bank|account/.test(value))
    return "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-200";
  if (/fire|extinguish/.test(value))
    return "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-400/35 dark:bg-rose-500/15 dark:text-rose-200";
  if (/attorney|legal/.test(value))
    return "border-teal-300 bg-teal-100 text-teal-800 dark:border-teal-400/35 dark:bg-teal-500/15 dark:text-teal-200";
  return "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-400/35 dark:bg-blue-500/15 dark:text-blue-200";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      type="button"
      aria-label={copied ? "Phone number copied" : "Copy phone number"}
      className="ms-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-indigo-100 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-400 dark:hover:bg-indigo-400/20 dark:hover:text-indigo-200"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export default function FactoryContacts() {
  const formId = useId();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateContact = recordChanges.canCreate("POST", "/api/factory/contacts");
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { execute: executeSave, pending: saving } = useSingleFlightAction();
  const { selectedCompany } = useCompany();
  const { prefs, setPrefs } = useTablePrefs("factory-contacts", { companyId: selectedCompany?.id });

  const pageSize = prefs.pageSize ?? 25;
  const visibility = prefs.columns ?? {};
  const show = (key: string) => visibility[key] !== false;

  const [search, setSearch] = useState("");
  const [contactFilter, setContactFilter] = useState<ContactFilter>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ["/api/factory/contacts"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/contacts");
      return res.json();
    },
  });

  const filtered = useMemo(
    () =>
      contacts.filter((c) => {
        const matchesSearch =
          !search.trim() ||
          searchAny(search, c.name, c.role, c.notes) ||
          c.numbers.some((n) => searchAny(search, n.number, n.label));
        const hasPhone = c.numbers.some((n) => n.number.trim().length > 0);
        const hasNotes = Boolean(c.notes?.trim());
        const matchesFilter =
          contactFilter === "all" ||
          (contactFilter === "has-phone" && hasPhone) ||
          (contactFilter === "has-notes" && hasNotes) ||
          (contactFilter === "missing-phone" && !hasPhone) ||
          (contactFilter === "missing-notes" && !hasNotes);
        return matchesSearch && matchesFilter;
      }),
    [contacts, search, contactFilter]
  );

  // Counts always use actual contact records, not demo values or current page size.
  const summaryCards = [
    {
      label: "Total Contacts",
      value: contacts.length,
      icon: UsersRound,
      tone: "border-blue-200 bg-gradient-to-br from-blue-50 via-white to-indigo-50 dark:border-blue-400/30 dark:from-blue-900/60 dark:via-blue-950/65 dark:to-slate-950",
      iconTone: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
    },
    {
      label: "With Phone Number",
      value: contacts.filter((c) => c.numbers.some((n) => n.number.trim())).length,
      icon: PhoneCall,
      tone: "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:border-emerald-400/30 dark:from-emerald-900/50 dark:via-emerald-950/65 dark:to-slate-950",
      iconTone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    },
    {
      label: "With Notes",
      value: contacts.filter((c) => Boolean(c.notes?.trim())).length,
      icon: NotebookText,
      tone: "border-amber-200 bg-gradient-to-br from-amber-50 via-white to-orange-50 dark:border-amber-400/30 dark:from-amber-900/50 dark:via-amber-950/65 dark:to-slate-950",
      iconTone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
    },
    {
      label: "Unique Roles",
      value: new Set(contacts.map((c) => c.role?.trim().toLocaleLowerCase()).filter(Boolean)).size,
      icon: Tags,
      tone: "border-violet-200 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50 dark:border-violet-400/30 dark:from-violet-900/50 dark:via-violet-950/65 dark:to-slate-950",
      iconTone: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
    },
  ];
  const orderedContacts = [...filtered].sort(
    (a, b) => a.name.localeCompare(b.name) * (prefs.sortDir === "desc" ? -1 : 1)
  );
  const {
    page: safePage,
    setPage,
    totalPages: pages,
    paginate,
  } = useClientTablePagination(orderedContacts.length, pageSize);
  const visibleContacts = paginate(orderedContacts);

  const saveMutation = useMutation({
    mutationFn: async (data: typeof EMPTY_FORM) => {
      if (editingContact && !recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const url = editingContact ? `/api/factory/contacts/${editingContact.id}` : "/api/factory/contacts";
      const method = editingContact ? "PATCH" : "POST";
      const res = await modeApiRequest(method, url, data);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/contacts"] });
      toast({ title: editingContact ? "Contact updated" : "Contact added" });
      setDialogOpen(false);
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await modeApiRequest("DELETE", `/api/factory/contacts/${id}`);
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/contacts"] });
      toast({ title: "Contact deleted" });
      setDeleteTarget(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Could not delete contact", variant: "destructive" });
    },
  });

  const openNew = () => {
    saveMutation.reset();
    setEditingContact(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (c: Contact) => {
    saveMutation.reset();
    setEditingContact(c);
    setForm({
      name: c.name,
      role: c.role ?? "",
      numbers: c.numbers.length > 0 ? c.numbers : [{ label: "Mobile", number: "" }],
      notes: c.notes ?? "",
    });
    setDialogOpen(true);
  };

  const setNumber = (idx: number, field: "label" | "number", value: string) => {
    setForm((f) => {
      const nums = [...f.numbers];
      nums[idx] = { ...nums[idx], [field]: value };
      return { ...f, numbers: nums };
    });
  };

  const addNumber = () => setForm((f) => ({ ...f, numbers: [...f.numbers, { label: "", number: "" }] }));

  const removeNumber = (idx: number) => setForm((f) => ({ ...f, numbers: f.numbers.filter((_, i) => i !== idx) }));

  const handleSubmit = () => {
    if (saveMutation.isPending || saving) return;
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    void executeSave(() =>
      saveMutation.mutateAsync({
        ...form,
        numbers: form.numbers.filter((n) => n.number.trim()),
      })
    ).catch(() => {
      // Existing mutation.onError provides feedback.
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-br from-indigo-100/75 via-blue-50/30 to-transparent dark:from-blue-700/15 dark:via-indigo-800/10 dark:to-transparent"
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pt-5 sm:px-6">
          <PageHeader
            title="Contacts"
            subtitle="Personal reference — names, numbers, and notes"
            icon={<UsersRound className="h-5 w-5 text-indigo-600 dark:text-violet-300" />}
            showBackButton
          >
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
                    {show("role") && (
                      <TableHead className="w-[140px] text-indigo-900 dark:text-indigo-100">Role</TableHead>
                    )}
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
                      <TableCell className="align-top font-semibold text-slate-900 dark:text-slate-100">
                        {c.name}
                      </TableCell>
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
                                <span className="font-mono font-medium text-slate-800 dark:text-slate-100">
                                  {n.number}
                                </span>
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

      {/* Add / Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(nextOpen) => {
          if (saveMutation.isPending || saving) return;
          setDialogOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-md" aria-busy={saveMutation.isPending || saving}>
          <DialogHeader>
            <DialogTitle>{editingContact ? "Edit Contact" : "Add Contact"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name *</Label>
              <Input
                id={`${formId}-name`}
                placeholder="e.g. Ahmed Karimi"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-role`}>Role / Purpose</Label>
              <Input
                id={`${formId}-role`}
                placeholder="e.g. Electrician, Plumber, Driver…"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              />
            </div>

            <div className="space-y-2" role="group" aria-label="Phone Numbers">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Phone Numbers</span>
                <Button size="sm" variant="ghost" onClick={addNumber} type="button">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
              {form.numbers.map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Phone ${i + 1} label`}
                    placeholder="Label (e.g. Mobile)"
                    value={n.label}
                    onChange={(e) => setNumber(i, "label", e.target.value)}
                    className="w-28 shrink-0 text-sm"
                  />
                  <Input
                    aria-label={`Phone ${i + 1} number`}
                    placeholder="Number"
                    value={n.number}
                    onChange={(e) => setNumber(i, "number", e.target.value)}
                    className="font-mono text-sm"
                  />
                  {form.numbers.length > 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-muted-foreground"
                      onClick={() => removeNumber(i)}
                      aria-label={`Remove phone ${i + 1}`}
                      type="button"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-notes`}>Notes</Label>
              <Textarea
                id={`${formId}-notes`}
                placeholder="Anything extra — hours, location, rates…"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
              />
            </div>
          </div>

          {saveMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              Contact could not be saved. Please review the fields and try again.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saveMutation.isPending || saving}>
              Cancel
            </Button>
            <FormSubmitButton
              type="button"
              onClick={handleSubmit}
              pending={saveMutation.isPending || saving}
              pendingLabel="Saving…"
            >
              {editingContact ? "Save Changes" : "Add Contact"}
            </FormSubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleteTarget(null);
        }}
        title="Delete Contact"
        tone="destructive"
        description={
          <>
            Remove <strong>{deleteTarget?.name}</strong> from your contacts? This cannot be undone.
          </>
        }
        confirmText="Delete"
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteTarget) await deleteMutation.mutateAsync(deleteTarget.id);
        }}
      />
    </div>
  );
}
