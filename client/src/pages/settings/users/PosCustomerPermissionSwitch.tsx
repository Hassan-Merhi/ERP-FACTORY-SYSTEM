import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { posCustomerAccessText } from "@shared/posCustomerAccess";

export function PosCustomerPermissionSwitch({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
      <Switch
        checked={enabled}
        onCheckedChange={onChange}
        aria-label={posCustomerAccessText.switchTitle}
        data-testid="switch-pos-can-access-customers"
      />
      <div className="space-y-0.5">
        <Label className="text-xs cursor-pointer">{posCustomerAccessText.switchTitle}</Label>
        <p className="text-xs text-muted-foreground">{posCustomerAccessText.switchHelp}</p>
      </div>
    </div>
  );
}
