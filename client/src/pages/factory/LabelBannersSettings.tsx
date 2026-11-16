import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, ImageIcon } from "lucide-react";
import { useLabelBannersSettingsState } from "./useLabelBannersSettingsState";
import { LabelBannersSettingsSection } from "./LabelBannersSettingsSection";

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
        <LabelBannersSettingsSection
          addColorHex={addColorHex}
          addFile={addFile}
          addFileInputRef={addFileInputRef}
          addLabel={addLabel}
          addOpen={addOpen}
          addingColor={addingColor}
          colors={colors}
          deleteMutation={deleteMutation}
          editColorHex={editColorHex}
          editLabel={editLabel}
          editMutation={editMutation}
          editingSlug={editingSlug}
          fileInputRefs={fileInputRefs}
          handleAddSubmit={handleAddSubmit}
          revertMutation={revertMutation}
          revertingSlot={revertingSlot}
          setAddColorHex={setAddColorHex}
          setAddFile={setAddFile}
          setAddLabel={setAddLabel}
          setAddOpen={setAddOpen}
          setEditColorHex={setEditColorHex}
          setEditLabel={setEditLabel}
          setEditingSlug={setEditingSlug}
          slugPreview={slugPreview}
          startEdit={startEdit}
          uploadMutation={uploadMutation}
          uploadingSlot={uploadingSlot}
        />
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
