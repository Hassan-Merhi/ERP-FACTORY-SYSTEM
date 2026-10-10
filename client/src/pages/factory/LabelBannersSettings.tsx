import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, Upload, RotateCcw, ImageIcon, CheckCircle, Plus, Pencil, Trash2, X, Check } from "lucide-react";

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

export default function LabelBannersSettings() {
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

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title="Label Banner Images"
        subtitle="Manage the colored header banners printed on A4 bale labels. Add custom colors, upload your own images, or revert to defaults."
        showBackButton
      />

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}

      {!isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {colors.map((c) => {
            const isUploading = uploadingSlot === c.slug;
            const isReverting = revertingSlot === c.slug;
            const isBusy = isUploading || isReverting || uploadMutation.isPending || revertMutation.isPending;
            const isEditing = editingSlug === c.slug;
            const ts = c.lastModified ?? 0;

            return (
              <Card key={c.slug} data-testid={`card-banner-${c.slug}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 flex-wrap justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0 border border-border"
                        style={{ background: c.colorHex }}
                      />
                      {isEditing ? (
                        <Input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="h-7 text-sm font-semibold"
                          data-testid={`input-edit-label-${c.slug}`}
                        />
                      ) : (
                        <CardTitle className="text-sm truncate">{c.label}</CardTitle>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {c.hasCustom && !isEditing && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium flex items-center gap-1">
                          <CheckCircle className="h-3 w-3" />
                          Custom
                        </span>
                      )}
                      {isEditing ? (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() =>
                              editMutation.mutate({ slug: c.slug, label: editLabel, colorHex: editColorHex })
                            }
                            disabled={editMutation.isPending}
                            data-testid={`button-save-edit-${c.slug}`}
                          >
                            {editMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setEditingSlug(null)}
                            data-testid={`button-cancel-edit-${c.slug}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => startEdit(c)}
                            data-testid={`button-edit-${c.slug}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {!c.isDefault && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive"
                              onClick={() => deleteMutation.mutate(c.slug)}
                              disabled={deleteMutation.isPending}
                              data-testid={`button-delete-${c.slug}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {isEditing ? (
                    <div className="flex items-center gap-2 mt-1">
                      <Label className="text-xs text-muted-foreground shrink-0">Color</Label>
                      <input
                        type="color"
                        value={editColorHex}
                        onChange={(e) => setEditColorHex(e.target.value)}
                        className="h-7 w-12 rounded-sm cursor-pointer border border-border bg-transparent p-0.5"
                        data-testid={`input-edit-hex-${c.slug}`}
                      />
                      <span className="text-xs text-muted-foreground font-mono">{editColorHex}</span>
                    </div>
                  ) : (
                    <CardDescription className="text-xs">
                      {c.isDefault ? "Built-in color" : "Custom color"} · <span className="font-mono">{c.slug}</span>
                    </CardDescription>
                  )}
                </CardHeader>

                <CardContent className="space-y-3">
                  <div className="relative rounded-md overflow-hidden border bg-muted h-20 flex items-center justify-center">
                    {/* Use small WebP preview for screen display when no custom image is uploaded.
                        Custom images use the original URL with stable ?t= cache key (now immutable-cached). */}
                    <img
                      key={ts}
                      src={ts > 0 ? `/labels/hmd-${c.slug}.jpg?t=${ts}` : `/labels/previews/hmd-${c.slug}-preview.webp`}
                      alt={`${c.label} banner`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                      data-testid={`img-banner-preview-${c.slug}`}
                    />
                    {(isUploading || isReverting) && (
                      <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <input
                      ref={(el) => {
                        fileInputRefs.current[c.slug] = el;
                      }}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadMutation.mutate({ slug: c.slug, file });
                        e.target.value = "";
                      }}
                      data-testid={`input-banner-file-${c.slug}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => fileInputRefs.current[c.slug]?.click()}
                      data-testid={`button-upload-banner-${c.slug}`}
                    >
                      {isUploading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {isUploading ? "Uploading…" : "Upload"}
                    </Button>
                    {c.hasCustom && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() => revertMutation.mutate(c.slug)}
                        data-testid={`button-revert-banner-${c.slug}`}
                      >
                        {isReverting ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Revert
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">JPG, PNG or WEBP · max 5 MB</p>
                </CardContent>
              </Card>
            );
          })}

          {/* Add New Color card */}
          {!addOpen ? (
            <Card
              className="border-dashed flex items-center justify-center cursor-pointer hover-elevate min-h-[220px]"
              onClick={() => setAddOpen(true)}
              data-testid="card-add-color"
            >
              <div className="flex flex-col items-center gap-2 text-muted-foreground p-6">
                <Plus className="h-8 w-8" />
                <span className="text-sm font-medium">Add Color</span>
              </div>
            </Card>
          ) : (
            <Card data-testid="card-add-color-form">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between flex-wrap gap-1">
                  Add New Color
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setAddOpen(false);
                      setAddLabel("");
                      setAddFile(null);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input
                    placeholder="e.g. Blue Ocean"
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    data-testid="input-add-color-label"
                  />
                  {addLabel && (
                    <p className="text-xs text-muted-foreground">
                      Slug: <span className="font-mono">{slugPreview || "…"}</span>
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Dot Color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={addColorHex}
                      onChange={(e) => setAddColorHex(e.target.value)}
                      className="h-8 w-14 rounded-sm cursor-pointer border border-border bg-transparent p-0.5"
                      data-testid="input-add-color-hex"
                    />
                    <span className="text-xs text-muted-foreground font-mono">{addColorHex}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">
                    Banner Image <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <input
                    ref={addFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => setAddFile(e.target.files?.[0] ?? null)}
                    data-testid="input-add-color-file"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addFileInputRef.current?.click()}
                    data-testid="button-add-color-choose-file"
                  >
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {addFile ? addFile.name : "Choose image"}
                  </Button>
                  {addFile && (
                    <button
                      type="button"
                      className="ml-2 text-xs text-muted-foreground underline"
                      onClick={() => {
                        setAddFile(null);
                        if (addFileInputRef.current) addFileInputRef.current.value = "";
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>

                <Button
                  size="sm"
                  className="w-full"
                  disabled={addingColor || !addLabel.trim()}
                  onClick={handleAddSubmit}
                  data-testid="button-add-color-submit"
                >
                  {addingColor ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {addingColor ? "Adding…" : "Add Color"}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            How this works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Each color slot maps to a design option that can be assigned to a bale product. When printing an A4 label,
            the banner image for that color fills the top of the page.
          </p>
          <p>
            Built-in colors (purple, green, gold, white, red) cannot be deleted, but you can upload a custom banner for
            any of them. Custom colors you add here appear in the design picker on all product forms.
          </p>
          <p>
            Recommended banner size: <strong>1240 × 350 px</strong> · JPG gives the best file size for photos.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
