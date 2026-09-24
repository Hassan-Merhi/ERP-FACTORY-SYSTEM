import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Phone,
  Pencil,
  Trash2,
  Copy,
  BookMarked,
  X,
  Check,
} from "lucide-react";

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
      className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export default function FactoryContacts() {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
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

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    return contacts.filter(
      (c) =>
        searchAny(search, c.name, c.role, c.notes) ||
        c.numbers.some((n) => searchAny(search, n.number, n.label))
    );
  }, [contacts, search]);

  const saveMutation = useMutation({
    mutationFn: async (data: typeof EMPTY_FORM) => {
      const url = editingContact
        ? `/api/factory/contacts/${editingContact.id}`
        : "/api/factory/contacts";
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
    setEditingContact(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (c: Contact) => {
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

  const addNumber = () =>
    setForm((f) => ({ ...f, numbers: [...f.numbers, { label: "", number: "" }] }));

  const removeNumber = (idx: number) =>
    setForm((f) => ({ ...f, numbers: f.numbers.filter((_, i) => i !== idx) }));

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    saveMutation.mutate({
      ...form,
      numbers: form.numbers.filter((n) => n.number.trim()),
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        title="Contacts"
        subtitle="Personal reference — names, numbers, and notes"
        showBackButton
      >
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" />
          Add Contact
        </Button>
      </PageHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {/* Search */}
        <div className="relative mb-4 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search name, role, number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 rounded border bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <BookMarked className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-muted-foreground text-sm">
              {search ? "No contacts match your search." : "No contacts yet. Add one to get started."}
            </p>
            {!search && (
              <Button size="sm" className="mt-4" onClick={openNew}>
                <Plus className="h-4 w-4 mr-1" />
                Add Contact
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Name</TableHead>
                  <TableHead className="w-[140px]">Role</TableHead>
                  <TableHead>Phone Numbers</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="w-[80px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow key={c.id} className="group">
                    <TableCell className="font-semibold align-top py-3">{c.name}</TableCell>
                    <TableCell className="align-top py-3">
                      {c.role ? (
                        <Badge variant="secondary" className="text-xs font-normal">
                          {c.role}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top py-3">
                      {c.numbers.length > 0 ? (
                        <div className="space-y-1">
                          {c.numbers.map((n, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="font-mono">{n.number}</span>
                              {n.label && (
                                <span className="text-xs text-muted-foreground">({n.label})</span>
                              )}
                              <CopyButton text={n.number} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top py-3 max-w-[260px]">
                      {c.notes ? (
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">
                          {c.notes}
                        </p>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => openEdit(c)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(c)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingContact ? "Edit Contact" : "Add Contact"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input
                placeholder="e.g. Ahmed Karimi"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Role / Purpose</Label>
              <Input
                placeholder="e.g. Electrician, Plumber, Driver…"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Phone Numbers</Label>
                <Button size="sm" variant="ghost" onClick={addNumber} type="button">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
              {form.numbers.map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    placeholder="Label (e.g. Mobile)"
                    value={n.label}
                    onChange={(e) => setNumber(i, "label", e.target.value)}
                    className="w-28 shrink-0 text-sm"
                  />
                  <Input
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
                      type="button"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                placeholder="Anything extra — hours, location, rates…"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : editingContact ? "Save Changes" : "Add Contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Remove <strong>{deleteTarget?.name}</strong> from your contacts? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
