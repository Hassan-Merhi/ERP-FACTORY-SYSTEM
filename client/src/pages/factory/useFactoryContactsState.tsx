// Extracted from ./FactoryContacts.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useSingleFlightAction } from "@/hooks/use-single-flight-action";
import type { TableColumnOption } from "@/components/TableViewOptions";
import { useTablePrefs } from "@/hooks/use-table-prefs";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { Check, Copy, NotebookText, PhoneCall, Tags, UsersRound } from "lucide-react";

interface PhoneEntry {
  label: string;
  number: string;
}

export interface Contact {
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

export const CONTACT_COLUMNS: TableColumnOption[] = [
  { key: "name", label: "Name", required: true },
  { key: "role", label: "Role" },
  { key: "phones", label: "Phone Numbers", required: true },
  { key: "notes", label: "Notes" },
  { key: "actions", label: "Actions", required: true },
];

export type ContactFilter = "all" | "has-phone" | "has-notes" | "missing-phone" | "missing-notes";

export function roleAccent(role: string): string {
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

export function CopyButton({ text }: { text: string }) {
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

export function useFactoryContactsState() {
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
    queryKey: companyQueryKey("/api/factory/contacts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Delete failed", description: "Could not delete contact", variant: "destructive" });
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
  return {
    addNumber,
    canCreateContact,
    orderedContacts,
    contactFilter,
    deleteMutation,
    deleteTarget,
    dialogOpen,
    editingContact,
    filtered,
    form,
    formId,
    handleSubmit,
    isLoading,
    openEdit,
    openNew,
    pageSize,
    pages,
    prefs,
    queryClient,
    recordChanges,
    removeNumber,
    safePage,
    saveMutation,
    saving,
    search,
    setContactFilter,
    setDeleteTarget,
    setDialogOpen,
    setForm,
    setNumber,
    setPage,
    setPrefs,
    setSearch,
    show,
    summaryCards,
    visibility,
    visibleContacts,
  };
}
