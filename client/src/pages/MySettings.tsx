import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { DateFormatSettingsCard } from "@/pages/settings/DateFormatSettingsCard";
import { FloatingWidgetsSettingsCard } from "@/pages/settings/FloatingWidgetsSettingsCard";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { ChristmasModePreferenceCard } from "@/pages/settings/ChristmasModePreferenceCard";
import { useCompany } from "@/contexts/CompanyContext";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateApplicationText, type ApplicationTranslationKey } from "@/i18n/applicationTranslations";

export default function MySettings() {
  const t =
    useOptionalApplicationLanguage()?.t ?? ((key: ApplicationTranslationKey) => translateApplicationText(key, "en"));
  const { toast } = useToast();
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
      <ChristmasModePreferenceCard />

      {["factory", "factory_v2"].includes(selectedCompany?.companyType ?? "") && (
        <Card data-testid="settings-factory-mhd-default">
          <CardHeader>
            <CardTitle className="text-base">{t("mhd.settingsTitle")}</CardTitle>
            <CardDescription>{t("mhd.settingsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={factoryMhd.mode}
              disabled={factoryMhd.saving}
              onValueChange={(value) => void factoryMhd.setMode(value as "standard" | "mhd")}
            >
              <SelectTrigger data-testid="select-factory-mhd-default">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">{t("mhd.standardView")}</SelectItem>
                <SelectItem value="mhd">{t("mhd.view")}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      <DateFormatSettingsCard />

      <FloatingWidgetsSettingsCard />

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
