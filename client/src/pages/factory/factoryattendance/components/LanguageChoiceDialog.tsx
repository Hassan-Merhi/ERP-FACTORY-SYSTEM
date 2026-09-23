import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface LanguageChoiceDialogProps {
  open: boolean;
  onClose: () => void;
  testId: string;
  /** Buttons are `${prefix}-english` and `${prefix}-arabic`. */
  buttonTestIdPrefix: string;
  isExport: boolean;
  onChoose: (lang: "en" | "ar") => void;
}

/** English/Arabic picker shown before an attendance print or Excel export. */
export function LanguageChoiceDialog({
  open,
  onClose,
  testId,
  buttonTestIdPrefix,
  isExport,
  onChoose,
}: LanguageChoiceDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-xs" data-testid={testId}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Languages className="h-4 w-4" />
            {isExport ? "Choose Export Language" : "Choose Print Language"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-2">
          <Button onClick={() => onChoose("en")} data-testid={`${buttonTestIdPrefix}-english`}>
            English
          </Button>
          <Button
            variant="outline"
            onClick={() => onChoose("ar")}
            data-testid={`${buttonTestIdPrefix}-arabic`}
            dir="rtl"
          >
            العربية
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
