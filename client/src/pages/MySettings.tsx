import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { KeyRound, CalendarDays, LayoutPanelLeft } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { PageHeader } from "@/components/PageHeader";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";

type DateFormatType = "MM/DD/YYYY" | "DD/MM/YYYY";

export default function MySettings() {
  const { t } = useApplicationLanguage();
  const { toast } = useToast();
  const { dateFormat } = useDateFormat();
  const { prefs, updatePref, isPending: prefsPending } = useUserPreferences();
  const factoryMhd = useFactoryMhdView();
  const { selectedCompany } = useCompany();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  const changePasswordMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/me/password", {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to change password");
      }
      return res.json();
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setClientError(null);
      toast({ title: "Password changed", description: "Your password has been updated successfully." });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      setClientError(error.message);
    },
  });

  const updateDateFormatMutation = useMutation({
    mutationFn: async (newFormat: DateFormatType) => {
      const res = await apiRequest("PUT", "/api/user-preferences", { dateFormat: newFormat });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update date format");
      }
      return res.json();
    },
    onSuccess: (_data, newFormat) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-preferences"] });
      toast({ title: "Date format updated", description: `Dates will now display as ${newFormat}.` });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setClientError(null);

    if (!currentPassword) {
      setClientError("Current password is required.");
      return;
    }
    if (!newPassword) {
      setClientError("New password is required.");
      return;
    }
    if (newPassword.trim().length < 6) {
      setClientError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setClientError("New password and confirmation do not match.");
      return;
    }

    changePasswordMutation.mutate();
  };

  return (
    <div className="p-6 max-w-md mx-auto space-y-6">
      <PageHeader title="My Settings" />

      {["factory", "factory_v2"].includes(selectedCompany?.companyType ?? "") && <Card data-testid="settings-factory-mhd-default">
        <CardHeader>
          <CardTitle className="text-base">{t("mhd.settingsTitle")}</CardTitle>
          <CardDescription>{t("mhd.settingsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={factoryMhd.mode} disabled={factoryMhd.saving} onValueChange={(value) => void factoryMhd.setMode(value as "standard" | "mhd")}>
            <SelectTrigger data-testid="select-factory-mhd-default"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t("mhd.standardView")}</SelectItem>
              <SelectItem value="mhd">{t("mhd.view")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4" />
            Date Format
          </CardTitle>
          <CardDescription>Choose how dates are displayed across your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Label htmlFor="select-date-format">Display format</Label>
            <Select
              value={dateFormat}
              onValueChange={(val) => updateDateFormatMutation.mutate(val as DateFormatType)}
              disabled={updateDateFormatMutation.isPending}
            >
              <SelectTrigger id="select-date-format" data-testid="select-date-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MM/DD/YYYY" data-testid="option-date-format-mmddyyyy">
                  MM/DD/YYYY
                </SelectItem>
                <SelectItem value="DD/MM/YYYY" data-testid="option-date-format-ddmmyyyy">
                  DD/MM/YYYY
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutPanelLeft className="h-4 w-4" />
            Floating Widgets
          </CardTitle>
          <CardDescription>Show or hide the floating tools that appear on every page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium leading-none">AI Agent Chatbot</p>
              <p className="text-xs text-muted-foreground mt-1">The floating chat bubble in the bottom-right corner.</p>
            </div>
            <Switch
              checked={prefs?.showChatWidget !== false}
              disabled={prefsPending}
              onCheckedChange={(val) => {
                updatePref({ showChatWidget: val });
                toast({
                  title: val ? "Chatbot enabled" : "Chatbot hidden",
                  description: val ? "The AI chat widget is now visible." : "The AI chat widget has been hidden.",
                });
              }}
              data-testid="switch-show-chat-widget"
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium leading-none">Notebook</p>
              <p className="text-xs text-muted-foreground mt-1">
                The floating notepad panel on the side of the screen.
              </p>
            </div>
            <Switch
              checked={prefs?.showNotesPanel !== false}
              disabled={prefsPending}
              onCheckedChange={(val) => {
                updatePref({ showNotesPanel: val });
                toast({
                  title: val ? "Notebook enabled" : "Notebook hidden",
                  description: val ? "The notebook panel is now visible." : "The notebook panel has been hidden.",
                });
              }}
              data-testid="switch-show-notes-panel"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update your login password. You must enter your current password to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="input-current-password">Current Password</Label>
              <Input
                id="input-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="input-current-password"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="input-new-password">New Password</Label>
              <Input
                id="input-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                data-testid="input-new-password"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="input-confirm-password">Confirm New Password</Label>
              <Input
                id="input-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                data-testid="input-confirm-password"
              />
            </div>

            {clientError && (
              <p className="text-sm text-destructive" data-testid="text-password-error">
                {clientError}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={changePasswordMutation.isPending}
              data-testid="button-change-password"
            >
              {changePasswordMutation.isPending ? "Saving…" : "Change Password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
