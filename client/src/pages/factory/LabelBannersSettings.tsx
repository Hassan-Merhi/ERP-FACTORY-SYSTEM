import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, Upload, RotateCcw, CheckCircle, Plus, Pencil, Trash2, X, Check } from "lucide-react";
import { confirmAction } from "@/components/ConfirmHost";
import { LabelBannersSettingsCardAddColorForm, useLabelBannersSettingsState } from "./useLabelBannersSettingsState";
import { LabelBannersSettingsCard } from "./LabelBannersSettingsCard";

export default function LabelBannersSettings() {
  const {
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
  } = useLabelBannersSettingsState();

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
                              onClick={async () => {
                                const confirmed = await confirmAction({
                                  title: "Delete this label banner?",
                                  confirmText: "Delete",
                                  tone: "destructive",
                                });
                                if (confirmed) deleteMutation.mutate(c.slug);
                              }}
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
            <LabelBannersSettingsCardAddColorForm
              addColorHex={addColorHex}
              addFile={addFile}
              addFileInputRef={addFileInputRef}
              addLabel={addLabel}
              addingColor={addingColor}
              handleAddSubmit={handleAddSubmit}
              setAddColorHex={setAddColorHex}
              setAddFile={setAddFile}
              setAddLabel={setAddLabel}
              setAddOpen={setAddOpen}
              slugPreview={slugPreview}
            />
          )}
        </div>
      )}

      <LabelBannersSettingsCard />
    </div>
  );
}
