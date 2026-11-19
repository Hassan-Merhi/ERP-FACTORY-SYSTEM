// Extracted from ./GITContainers.tsx: sends the server-generated container report to WhatsApp.
import { apiRequest } from "@/lib/queryClient";
import type { useGITContainersState } from "./useGITContainersState";

export async function sendGitContainersToWhatsApp({
  setWaSending,
  toast,
}: {
  setWaSending: ReturnType<typeof useGITContainersState>["setWaSending"];
  toast: ReturnType<typeof useGITContainersState>["toast"];
}) {
  setWaSending(true);
  try {
    // Send no image payload — the server generates the PDF report itself,
    // avoiding the 2 MB Express JSON body limit that a base64 screenshot would exceed.
    await apiRequest("POST", "/api/git/send-containers-whatsapp", {});
    toast({ title: "Sent", description: "Container report sent to WhatsApp group." });
  } catch (error: unknown) {
    toast({
      title: "Failed to send",
      description: error instanceof Error ? error.message : "Unable to send the container report.",
      variant: "destructive",
    });
  } finally {
    setWaSending(false);
  }
}
