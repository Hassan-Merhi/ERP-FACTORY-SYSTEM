import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Preferences={email:string;whatsappNumber:string;emailEnabled:boolean;whatsappEnabled:boolean};
async function loadSettings():Promise<Preferences>{
  const res=await fetch("/api/tickets/notification-settings",{credentials:"include",cache:"no-store"});
  if(!res.ok)throw new Error("Could not load notification settings");
  return res.json() as Promise<Preferences>;
}

export default function TicketNotificationSettings({onClose}:{onClose:()=>void}){
  const {selectedCompany}=useCompany();
  const qc=useQueryClient();
  const [draft,setDraft]=useState<Preferences|null>(null);
  const [error,setError]=useState("");
  const query=useQuery({queryKey:["ticket-notification-settings",selectedCompany?.id],queryFn:loadSettings,
    enabled:!!selectedCompany?.id});
  const current=draft??query.data;
  const save=useMutation({
    mutationFn:async(input:Preferences)=>{
      const res=await apiRequest("PUT","/api/tickets/notification-settings",input);
      if(!res.ok)throw new Error("Could not save notification settings");
    },
    onSuccess:async()=>{
      await qc.invalidateQueries({queryKey:["ticket-notification-settings",selectedCompany?.id]});
      setDraft(null);setError("");onClose();
    },
    onError:(e:Error)=>setError(e.message),
  });
  const update=(patch:Partial<Preferences>)=>setDraft(previous=>({...((previous??query.data) as Preferences),...patch}));
  return <section className="mx-auto max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Ticket notification settings</h2><Button variant="outline" onClick={onClose}>Close</Button></div>
    <p className="text-sm text-muted-foreground">In-app ticket notifications are always enabled. External messages contain only a ticket reference and require sign-in to view details.</p>
    {query.isLoading&&<p role="status">Loading settings...</p>}
    {query.isError&&<p role="alert" className="text-destructive">Could not load settings.</p>}
    {current&&<form className="space-y-4" onSubmit={e=>{e.preventDefault();setError("");save.mutate(current);}}>
      <label className="block space-y-1 text-sm font-medium">Email address
        <Input type="email" maxLength={254} value={current.email} onChange={e=>update({email:e.target.value})}
          placeholder="employee@example.com"/>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={current.emailEnabled} onChange={e=>update({emailEnabled:e.target.checked})}
          className="mt-1" />
        Send ticket alerts to this email address.
      </label>
      <label className="block space-y-1 text-sm font-medium">WhatsApp phone number (with country code)
        <Input type="tel" autoComplete="tel" maxLength={21} value={current.whatsappNumber}
          onChange={e=>update({whatsappNumber:e.target.value})} placeholder="+96170123456"/>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={current.whatsappEnabled} onChange={e=>update({whatsappEnabled:e.target.checked})}
          className="mt-1" />
        I consent to receiving ticket notifications through WhatsApp at this number.
      </label>
      <p className="text-xs text-muted-foreground">Email requires a configured ticket SMTP account. WhatsApp requires the connected Green API instance and your opt-in. Delivery may be unavailable when providers are not configured.</p>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={save.isPending}>{save.isPending?"Saving...":"Save notification preferences"}</Button>
    </form>}
  </section>;
}
