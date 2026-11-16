// Extracted from ./LabelBannersSettings.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ColorRow {
  id: number;
  slug: string;
  label: string;
  colorHex: string;
  sortOrder: number;
  isDefault: boolean;
  hasCustom: boolean;
  lastModified: number | null;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function useLabelBannersSettingsState() {
  const { toast } = useToast();
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const addFileInputRef = useRef<HTMLInputElement | null>(null);

  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [revertingSlot, setRevertingSlot] = useState<string | null>(null);

  // Inline edit state
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editColorHex, setEditColorHex] = useState("");

  // Add form state
  const [addOpen, setAddOpen] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addColorHex, setAddColorHex] = useState("#3B82F6");
  const [addFile, setAddFile] = useState<File | null>(null);
  const [addingColor, setAddingColor] = useState(false);

  const { data: rawColors, isLoading } = useQuery<ColorRow[]>({
    queryKey: ["/api/factory/label-design-colors"],
    queryFn: () =>
      fetch("/api/factory/label-design-colors", { credentials: "include" }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      }),
  });
  const colors: ColorRow[] = Array.isArray(rawColors) ? rawColors : [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/factory/label-design-colors"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/label-banners"] });
  };

  // ── Upload banner image ─────────────────────────────────────────────────────
  const uploadMutation = useMutation({
    mutationFn: async ({ slug, file }: { slug: string; file: File }) => {
      setUploadingSlot(slug);
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(`/api/factory/label-banners/${slug}`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Upload failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Banner image updated" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
    onSettled: () => setUploadingSlot(null),
  });

  // ── Revert to default ───────────────────────────────────────────────────────
  const revertMutation = useMutation({
    mutationFn: async (slug: string) => {
      setRevertingSlot(slug);
      const res = await fetch(`/api/factory/label-banners/${slug}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Revert failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Banner reverted to default" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Revert failed", description: e.message, variant: "destructive" }),
    onSettled: () => setRevertingSlot(null),
  });

  // ── Inline edit save ────────────────────────────────────────────────────────
  const editMutation = useMutation({
    mutationFn: async ({ slug, label, colorHex }: { slug: string; label: string; colorHex: string }) => {
      const res = await fetch(`/api/factory/label-design-colors/${slug}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, colorHex }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Update failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Color updated" });
      setEditingSlug(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  // ── Delete custom color ─────────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`/api/factory/label-design-colors/${slug}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Delete failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Color deleted" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Add new color ───────────────────────────────────────────────────────────
  const handleAddSubmit = async () => {
    if (!addLabel.trim()) return toast({ title: "Please enter a color name", variant: "destructive" });
    setAddingColor(true);
    try {
      const form = new FormData();
      form.append("label", addLabel.trim());
      form.append("colorHex", addColorHex);
      if (addFile) form.append("image", addFile);
      const res = await fetch("/api/factory/label-design-colors", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Failed to add color");
      toast({ title: "Color added" });
      setAddLabel("");
      setAddColorHex("#3B82F6");
      setAddFile(null);
      if (addFileInputRef.current) addFileInputRef.current.value = "";
      setAddOpen(false);
      invalidate();
    } catch (e) {
      toast({ title: "Failed to add color", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setAddingColor(false);
    }
  };

  const startEdit = (c: ColorRow) => {
    setEditingSlug(c.slug);
    setEditLabel(c.label);
    setEditColorHex(c.colorHex);
  };

  const slugPreview = slugify(addLabel);
  return {
    addColorHex,
    addFile,
    addFileInputRef,
    addLabel,
    addOpen,
    addingColor,
    colors,
    deleteMutation,
    editColorHex,
    editLabel,
    editMutation,
    editingSlug,
    fileInputRefs,
    handleAddSubmit,
    isLoading,
    revertMutation,
    revertingSlot,
    setAddColorHex,
    setAddFile,
    setAddLabel,
    setAddOpen,
    setEditColorHex,
    setEditLabel,
    setEditingSlug,
    slugPreview,
    startEdit,
    uploadMutation,
    uploadingSlot,
  };
}
