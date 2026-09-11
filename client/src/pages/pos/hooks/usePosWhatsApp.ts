import { getErrorDetails } from "@shared/errorUtils";
import { useEffect } from "react";
import type { Location } from "../pos-components/posTypes";
import { sendInvoicePdfWithRetry, sendStockPdfWithRetry } from "../utils/posPrintHelpers";

interface PosWhatsAppParams {
  pendingAutoSend: { voucherId: number; locationId: number } | null;
  setPendingAutoSend: (val: { voucherId: number; locationId: number } | null) => void;
  pendingStockSend: boolean;
  setPendingStockSend: (val: boolean) => void;
  activeLocation: Location | null;
  savedSale: { voucher?: { id?: number } } | null | undefined;
  setInvoiceWaStatus: (s: "idle" | "sending" | "sent" | "failed") => void;
  setStockWaStatus: (s: "idle" | "sending" | "sent" | "failed" | "not_configured") => void;
  setSendingInvoiceWhatsApp: (v: boolean) => void;
  setSendingWhatsApp: (v: boolean) => void;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
}

export function usePosWhatsApp({
  pendingAutoSend,
  setPendingAutoSend,
  pendingStockSend,
  setPendingStockSend,
  activeLocation,
  savedSale,
  setInvoiceWaStatus,
  setStockWaStatus,
  setSendingInvoiceWhatsApp,
  setSendingWhatsApp,
  toast,
}: PosWhatsAppParams) {
  // Deferred WhatsApp invoice auto-send after sale saved
  useEffect(() => {
    if (!pendingAutoSend) return;
    const data = pendingAutoSend;
    setPendingAutoSend(null);
    const doSend = async () => {
      setSendingInvoiceWhatsApp(true);
      setInvoiceWaStatus("sending");
      try {
        const result = await sendInvoicePdfWithRetry(data.voucherId, data.locationId, {
          onAttempt: (n) => {
            if (n > 1) toast({ title: "Retrying…", description: `WhatsApp invoice send attempt ${n}/3.` });
          },
        });
        if (!result.ok) {
          setInvoiceWaStatus("failed");
          toast({ title: "WhatsApp", description: result.message, variant: "destructive" });
        } else {
          setInvoiceWaStatus("sent");
        }
      } catch (e) {
        setInvoiceWaStatus("failed");
        toast({
          title: "WhatsApp",
          description: getErrorDetails(e).message || "Could not send invoice.",
          variant: "destructive",
        });
      } finally {
        setSendingInvoiceWhatsApp(false);
      }
    };
    doSend();
  }, [pendingAutoSend, setInvoiceWaStatus, setPendingAutoSend, setSendingInvoiceWhatsApp, toast]);

  // Deferred WhatsApp stock auto-send after sale saved
  useEffect(() => {
    if (!pendingStockSend || !activeLocation?.id) return;
    setPendingStockSend(false);
    setStockWaStatus("sending");
    const doSend = async () => {
      try {
        const result = await sendStockPdfWithRetry(activeLocation.id, {
          onAttempt: (n) => {
            if (n > 1) toast({ title: "Retrying…", description: `WhatsApp stock send attempt ${n}/3.` });
          },
        });
        if (!result.ok) throw new Error(result.message);
        setStockWaStatus("sent");
        toast({ title: "Stock sent", description: "Stock report sent to WhatsApp group." });
      } catch (e) {
        setStockWaStatus("failed");
        toast({
          title: "Stock send failed",
          description: getErrorDetails(e).message || "Could not send stock report.",
          variant: "destructive",
        });
      }
    };
    doSend();
  }, [activeLocation, pendingStockSend, setPendingStockSend, setStockWaStatus, toast]);

  // ISSUE 4: Real invoice WhatsApp send
  const handleSendInvoiceWhatsApp = async () => {
    const vId = savedSale?.voucher?.id;
    const locId = activeLocation?.id;
    if (!vId || !locId) {
      toast({ title: "Not ready", description: "No saved invoice to send.", variant: "destructive" });
      return;
    }
    setSendingInvoiceWhatsApp(true);
    setInvoiceWaStatus("sending");
    try {
      const result = await sendInvoicePdfWithRetry(vId, locId, {
        onAttempt: (n) => {
          if (n > 1) toast({ title: "Retrying…", description: `WhatsApp invoice send attempt ${n}/3.` });
        },
      });
      if (!result.ok) {
        setInvoiceWaStatus("failed");
        toast({ title: "Failed to send", description: result.message, variant: "destructive" });
      } else {
        setInvoiceWaStatus("sent");
        toast({ title: "Sent", description: "Invoice sent to WhatsApp group." });
      }
    } catch (e) {
      setInvoiceWaStatus("failed");
      toast({
        title: "Error",
        description: getErrorDetails(e).message || "Could not reach the server.",
        variant: "destructive",
      });
    } finally {
      setSendingInvoiceWhatsApp(false);
    }
  };

  // ISSUE 5: Real stock WhatsApp send
  const handleSendWhatsAppReport = async () => {
    if (!activeLocation?.id) {
      toast({ title: "No location", description: "No active location selected.", variant: "destructive" });
      return;
    }
    setSendingWhatsApp(true);
    setStockWaStatus("sending");
    try {
      const result = await sendStockPdfWithRetry(activeLocation.id, {
        onAttempt: (n) => {
          if (n > 1) toast({ title: "Retrying…", description: `WhatsApp stock send attempt ${n}/3.` });
        },
      });
      if (!result.ok) throw new Error(result.message);
      setStockWaStatus("sent");
      toast({ title: "Sent", description: "Stock report sent to WhatsApp group." });
    } catch (e) {
      setStockWaStatus("failed");
      toast({
        title: "Failed to send",
        description: getErrorDetails(e).message || "WhatsApp send failed.",
        variant: "destructive",
      });
    } finally {
      setSendingWhatsApp(false);
    }
  };

  return { handleSendInvoiceWhatsApp, handleSendWhatsAppReport };
}
