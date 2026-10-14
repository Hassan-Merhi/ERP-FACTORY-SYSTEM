import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Plus,
  Trash2,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  Users,
  XCircle,
  Settings2,
  EyeOff,
  Eye,
  Loader2,
} from "lucide-react";
import { Recipient, ExportSettings, WaRecipient } from "./ExportCenterTypes";
import { apiRequest } from "@/lib/queryClient";
import { WhatsAppExportSection } from "./WhatsAppExportSection";

interface RecipientsTabProps {
  emailRecipients: Recipient[];
  waGroups: WaRecipient[];
  waRecipients: WaRecipient[];
  dailyWaGroup?: WaRecipient;
  npWaGroup?: WaRecipient;
  exportSettings?: ExportSettings;
  gmailUser: string;
  setGmailUser: (u: string) => void;
  gmailPassword: string;
  setGmailPassword: (p: string) => void;
  showPassword: boolean;
  setShowPassword: (v: boolean | ((v: boolean) => boolean)) => void;
  savingGmail: boolean;
  saveGmailSettings: () => void;
}

export function RecipientsTab({
  emailRecipients,
  waRecipients,
  dailyWaGroup,
  npWaGroup,
  exportSettings,
  gmailUser,
  setGmailUser,
  gmailPassword,
  setGmailPassword,
  showPassword,
  setShowPassword,
  savingGmail,
  saveGmailSettings,
}: RecipientsTabProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const addEmailRecipient = useMutation({
    mutationFn: (email: string) => apiRequest("POST", "/api/export/recipients", { email }),
    onSuccess: () => {
      setNewEmail("");
      qc.invalidateQueries({ queryKey: ["/api/export/recipients"] });
      toast({ title: "Recipient added" });
    },
    onError: (e: ClientErrorLike) => toast({ variant: "destructive", title: "Error", description: e.message }),
  });

  const removeEmailRecipient = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/export/recipients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/export/recipients"] });
      toast({ title: "Recipient removed" });
    },
  });

  return (
    <div className="space-y-6 mt-4">
      {/* Email Recipients */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold flex items-center gap-2">
            <Mail className="h-4 w-4" /> Email Recipients
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="Add email address..."
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newEmail) addEmailRecipient.mutate(newEmail);
            }}
            data-testid="input-new-recipient"
          />
          <Button
            onClick={() => newEmail && addEmailRecipient.mutate(newEmail)}
            disabled={!newEmail || addEmailRecipient.isPending}
            data-testid="button-add-recipient"
          >
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        {emailRecipients.length > 0 ? (
          <div className="rounded-md border divide-y">
            {emailRecipients.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 px-3 py-2"
                data-testid={`row-recipient-${r.id}`}
              >
                <span className="font-mono text-sm truncate">{r.email}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {new Date(r.created_at).toLocaleDateString()}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeEmailRecipient.mutate(r.id)}
                    data-testid={`button-remove-recipient-${r.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4 border rounded-md">
            No recipients yet. Add an email address above.
          </p>
        )}
      </div>

      <Separator />

      {/* WhatsApp Recipients Summary */}
      <div className="space-y-4">
        <p className="text-sm font-semibold flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-green-600" /> WhatsApp Recipients
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border p-3 space-y-1">
            <p className="font-medium text-muted-foreground">Daily Export Group</p>
            {dailyWaGroup ? (
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                {dailyWaGroup.name}
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                Not configured
              </p>
            )}
          </div>
          <div className="rounded-md border p-3 space-y-1">
            <p className="font-medium text-muted-foreground">Net Position Export Group</p>
            {npWaGroup ? (
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                {npWaGroup.name}
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                Not configured
              </p>
            )}
          </div>
        </div>
        {waRecipients.length > 0 && (
          <div className="rounded-md border divide-y">
            {waRecipients.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2" data-testid={`row-wa-recipient-${r.id}`}>
                {r.isGroup ? (
                  <Users className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-green-500" />
                )}
                <span className="text-sm font-medium truncate">{r.name}</span>
                {r.isGroup && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    Group
                  </Badge>
                )}
                {r.active ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 ml-auto shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Advanced Toggle */}
      <div className="space-y-4">
        <button
          className="flex items-center gap-2 text-sm font-semibold hover:underline"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <Settings2 className="h-4 w-4" />
          {showAdvanced ? "Hide Advanced Settings" : "Show Advanced Settings"}
        </button>

        {showAdvanced && (
          <div className="space-y-6 pt-2">
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">WhatsApp Export Master Settings</p>
                <p className="text-xs text-muted-foreground">Green API credentials and global toggle.</p>
              </div>
              <WhatsAppExportSection />
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Gmail Sender Credentials</p>
                <p className="text-xs text-muted-foreground">Used for all system emails.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Gmail Address</Label>
                  <Input
                    type="email"
                    placeholder={exportSettings?.gmailUser || "sender@gmail.com"}
                    value={gmailUser}
                    onChange={(e) => setGmailUser(e.target.value)}
                    data-testid="input-gmail-user"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">App Password</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="xxxx xxxx xxxx xxxx"
                      value={gmailPassword}
                      onChange={(e) => setGmailPassword(e.target.value)}
                      className="pr-10"
                      data-testid="input-gmail-password"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-0 top-0 h-full"
                      onClick={() => setShowPassword(!showPassword)}
                      type="button"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>
              <Button onClick={saveGmailSettings} disabled={savingGmail} data-testid="button-save-gmail">
                {savingGmail ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Save Credentials
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
