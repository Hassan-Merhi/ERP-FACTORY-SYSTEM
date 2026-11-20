import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { CustomerOrder } from "./types";
import type { EditableShippingField } from "./InvoiceOrderRow";

/** Company-scoped reusable agents; never stored only in local component state. */
export function LoadingAgentCell({
  order,
  onSave,
}: {
  order: CustomerOrder;
  onSave: (orderId: number, field: EditableShippingField, value: string) => Promise<void>;
}) {
  const appMode = useAppMode();
  const api = getApiRequest(appMode);
  const { toast } = useToast();
  const access = useExistingRecordChangeAccess();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const key = companyQueryKey("/api/factory/loading-agents", order.companyId);
  const { data: agents = [] } = useQuery<string[]>({ queryKey: key });
  const createAgent = useMutation({
    mutationFn: async (value: string) => {
      const response = await api("POST", "/api/factory/loading-agents", { name: value });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Failed to save agent");
      }
      return (await response.json()) as { name: string };
    },
    onSuccess: async ({ name: saved }) => {
      await queryClient.invalidateQueries({ queryKey: key });
      setCreating(false);
      setName("");
      try {
        await onSave(order.id, "agentName", saved);
      } catch (error) {
        toast({ title: "Agent created but not assigned", description: String(error), variant: "destructive" });
      }
    },
    onError: (error: Error) => toast({ title: "Could not create agent", description: error.message, variant: "destructive" }),
  });

  return (
    <div className="min-w-[150px]" onClick={(event) => event.stopPropagation()}>
      {creating ? (
        <form className="flex items-center gap-1" onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) createAgent.mutate(name.trim());
        }}>
          <Input aria-label="New agent name" maxLength={200} autoFocus value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-28 text-xs" placeholder="Agent name" />
          <Button type="submit" size="sm" disabled={!name.trim() || createAgent.isPending}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </form>
      ) : (
        <Select value={order.agentName || "__none"} disabled={!access.allowed}
          onValueChange={(value) => {
            if (value === "__create") { setCreating(true); return; }
            void onSave(order.id, "agentName", value === "__none" ? "" : value).catch((error) =>
              toast({ title: "Could not assign agent", description: String(error), variant: "destructive" })
            );
          }}>
          <SelectTrigger className="h-8 min-w-[145px] text-xs" aria-label={`Agent for loading ${order.id}`}>
            <SelectValue placeholder="Select agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">No agent</SelectItem>
            {agents.map((agent) => <SelectItem key={agent} value={agent}>{agent}</SelectItem>)}
            <SelectItem value="__create">+ Add new agent</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
