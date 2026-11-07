import { Snowflake } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useChristmasMode } from "@/hooks/useChristmasMode";
import { useToast } from "@/hooks/use-toast";

/**
 * Visible in My Settings to accounts a Developer has explicitly allowlisted.
 * This personal preference never changes the Developer master switch or list.
 */
export function ChristmasModePreferenceCard() {
  const { toast } = useToast();
  const { settingQuery, updatePersonalPreference } = useChristmasMode();
  const setting = settingQuery.data;

  if (setting?.available !== true) return null;

  return (
    <Card data-testid="my-settings-christmas-mode">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Snowflake className="h-4 w-4 text-sky-500" aria-hidden="true" />
          Christmas Mode
        </CardTitle>
        <CardDescription>
          Your personal choice for festive snow, lights, Santa's sleigh and login decorations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Show Christmas decorations</p>
            <p className="text-xs text-muted-foreground">
              Turn off all Christmas effects just for your account, on every company and device.
            </p>
          </div>
          <Switch
            aria-label="Show Christmas Mode on my account"
            data-testid="switch-my-christmas-mode"
            checked={setting.preferenceEnabled === true}
            disabled={updatePersonalPreference.isPending}
            onCheckedChange={(enabled) =>
              updatePersonalPreference.mutate(enabled, {
                onSuccess: () =>
                  toast({
                    title: enabled ? "Christmas Mode turned on" : "Christmas Mode turned off",
                    description: enabled
                      ? "You'll see the festive effects when the Developer master switch is on."
                      : "Your account will no longer display Christmas decorations.",
                  }),
                onError: (error) =>
                  toast({
                    title: "Couldn't update Christmas Mode",
                    description: error.message,
                    variant: "destructive",
                  }),
              })
            }
          />
        </div>
        {setting.enabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="button-preview-christmas-santa"
            onClick={() => window.dispatchEvent(new Event("christmas:sleigh-preview"))}
          >
            Preview Santa now
          </Button>
        )}
        {setting.enabled && setting.visuals?.effects.gifts && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 ml-2"
            data-testid="button-preview-christmas-gift"
            onClick={() => window.dispatchEvent(new Event("christmas:gift-preview"))}
          >
            Preview a festive gift
          </Button>
        )}
        {!setting.enabled && setting.preferenceEnabled && (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            Your preference is on. Decorations will appear when the Developer activates Christmas Mode.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
