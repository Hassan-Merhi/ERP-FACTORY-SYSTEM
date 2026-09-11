import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
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
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { z } from "zod";
import { ExternalLink, Plus, Pencil, Trash2, Sheet } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import type { AuthMe } from "@shared/apiTypes";

interface LiveSpreadsheet {
  id: number;
  name: string;
  url: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Must be a valid URL (e.g. https://docs.google.com/...)"),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof formSchema>;

function SheetFormDialog({
  open,
  onClose,
  existing,
  isAdmin: _isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  existing?: LiveSpreadsheet | null;
  isAdmin: boolean;
}) {
  const { toast } = useToast();
  const isEdit = !!existing;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: existing?.name ?? "",
      url: existing?.url ?? "",
      description: existing?.description ?? "",
      isActive: existing?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      if (isEdit) {
        return apiRequest("PATCH", `/api/live-spreadsheets/${existing!.id}`, values);
      }
      return apiRequest("POST", "/api/live-spreadsheets", values);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/live-spreadsheets"] });
      toast({ title: isEdit ? "Updated" : "Added", description: isEdit ? "Sheet link updated." : "Sheet link added." });
      onClose();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const onSubmit = (values: FormValues) => mutation.mutate(values);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Sheet Link" : "Add Sheet Link"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Weekly Sales Tracker" {...field} data-testid="input-sheet-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Google Sheet URL</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://docs.google.com/spreadsheets/..."
                      {...field}
                      data-testid="input-sheet-url"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description <span className="text-muted-foreground text-xs">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What is this sheet used for?"
                      rows={2}
                      {...field}
                      data-testid="input-sheet-description"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {isEdit && (
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="switch-sheet-active"
                      />
                    </FormControl>
                    <Label>Active (visible to all users)</Label>
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-save-sheet">
                {mutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function LiveSheets() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<LiveSpreadsheet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LiveSpreadsheet | null>(null);

  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdmin = me?.role === "Admin" || me?.role === "Owner" || me?.role === "Developer";

  const { data: sheets = [], isLoading } = useQuery<LiveSpreadsheet[]>({
    queryKey: ["/api/live-spreadsheets"],
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/live-spreadsheets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/live-spreadsheets"] });
      toast({ title: "Deleted", description: "Sheet link removed." });
      setDeleteTarget(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const openAdd = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };
  const openEdit = (s: LiveSpreadsheet) => {
    setEditTarget(s);
    setDialogOpen(true);
  };
  const closeDialog = () => {
    setDialogOpen(false);
    setEditTarget(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <PageHeader title="Live Sheets" subtitle="Shared Google Sheets — click Open to view or edit the live file" />
        </div>
        {isAdmin && (
          <Button onClick={openAdd} data-testid="button-add-sheet">
            <Plus className="w-4 h-4 mr-2" />
            Add Sheet
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : sheets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Sheet className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No live sheets yet</p>
            {isAdmin && (
              <p className="text-sm mt-1">
                Click <strong>Add Sheet</strong> to add a Google Sheet link
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sheets.map((sheet) => (
            <Card key={sheet.id} data-testid={`card-sheet-${sheet.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold truncate" data-testid={`text-sheet-name-${sheet.id}`}>
                        {sheet.name}
                      </span>
                      {isAdmin && !sheet.isActive && (
                        <Badge variant="secondary" className="text-xs">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    {sheet.description && (
                      <p className="text-sm text-muted-foreground" data-testid={`text-sheet-desc-${sheet.id}`}>
                        {sheet.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isAdmin && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEdit(sheet)}
                          data-testid={`button-edit-sheet-${sheet.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteTarget(sheet)}
                          data-testid={`button-delete-sheet-${sheet.id}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </>
                    )}
                    <a
                      href={sheet.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`link-open-sheet-${sheet.id}`}
                    >
                      <Button size="sm" className="gap-2">
                        <ExternalLink className="w-4 h-4" />
                        Open
                      </Button>
                    </a>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SheetFormDialog open={dialogOpen} onClose={closeDialog} existing={editTarget} isAdmin={isAdmin} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove sheet link?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong> from the system. The actual Google Sheet will not
              be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete-sheet"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
