// Extracted from ./StockReportSection.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { SettingsMessageResult } from "./settingsTypes";
import { scheduleLabel, type Company, type Recipient, type StockSettings } from "./StockReportSectionHelpers";

export function useStockReportSectionState() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: expanded,
  });

  const { data: recipients = [] } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const { data: cfg } = useQuery<StockSettings>({
    queryKey: ["/api/whatsapp/stock-settings"],
    enabled: expanded,
  });

  const groups = recipients.filter((r) => r.isGroup && r.active);

  // Local state for all editable fields
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [recipientId, setRecipientId] = useState<number | null>(null);
  const [frequency, setFrequency] = useState<string | null>(null);
  const [sendHour, setSendHour] = useState<number | null>(null);
  const [sendDayOfWeek, setSendDayOfWeek] = useState<number | null>(null);

  // Resolved values (local state overrides server state)
  const rCompanyId = companyId ?? cfg?.companyId ?? null;
  const rRecipientId = recipientId ?? cfg?.recipientId ?? null;
  const rFrequency = frequency ?? cfg?.frequency ?? "daily";
  const rSendHour = sendHour ?? cfg?.sendHour ?? 18;
  const rSendDayOfWeek = sendDayOfWeek ?? cfg?.sendDayOfWeek ?? 1;

  const buildPayload = (patch?: Partial<StockSettings>) => ({
    companyId: rCompanyId,
    recipientId: rRecipientId,
    frequency: rFrequency,
    sendHour: rSendHour,
    sendDayOfWeek: rSendDayOfWeek,
    autoSend: cfg?.autoSend ?? false,
    enabled: cfg?.enabled ?? false,
    ...patch,
  });

  const saveSettings = useMutation({
    mutationFn: (patch?: Partial<StockSettings>) =>
      apiRequest("PUT", "/api/whatsapp/stock-settings", buildPayload(patch)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/stock-settings"] });
      toast({ title: "Stock report settings saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const sendNow = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/whatsapp/send-stock-report", {
        companyId: rCompanyId,
        recipientId: rRecipientId,
      }),
    onSuccess: (data: unknown) => {
      const message = (data as SettingsMessageResult | null)?.message;
      toast({ title: "Reports sent", description: message || "Done" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const canSend = !!(rCompanyId && rRecipientId);
  const label = scheduleLabel(cfg);
  return {
    setExpanded,
    expanded,
    companies,
    cfg,
    groups,
    setCompanyId,
    setRecipientId,
    setFrequency,
    setSendHour,
    setSendDayOfWeek,
    rCompanyId,
    rRecipientId,
    rFrequency,
    rSendHour,
    rSendDayOfWeek,
    saveSettings,
    sendNow,
    canSend,
    label,
  };
}
