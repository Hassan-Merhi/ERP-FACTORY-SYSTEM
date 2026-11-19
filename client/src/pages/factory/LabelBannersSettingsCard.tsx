// Extracted from ./LabelBannersSettings.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImageIcon } from "lucide-react";

export function LabelBannersSettingsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          How this works
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-2">
        <p>
          Each color slot maps to a design option that can be assigned to a bale product. When printing an A4 label, the
          banner image for that color fills the top of the page.
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
  );
}
