import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Ticket = { id:number;ticketNumber:string;title:string;description:string;status:string;priority:string;assignedTo:string;createdBy:string };
type Detail = { ticket:Ticket; records:{id:number;recordType:string;displayReference:string}[];
  capabilities:{seen:boolean;start:boolean;finalize:boolean;reopen:boolean} };
type Comment = {id:number;authorId:string;body:string;createdAt:string};
type Attachment = {id:number;fileName:string;mimeType:string;sizeBytes:number;createdAt:string;uploadedBy:string};
type TicketEvent = {id:number;actorId:string;eventType:string;reason:string|null;createdAt:string};
type Conversation = {comments:Comment[];attachments:Attachment[];events:TicketEvent[]};

async function readJson<T>(url:string):Promise<T> {
  const res=await fetch(url,{credentials:"include",cache:"no-store"});
  if(!res.ok) throw new Error(res.status===403||res.status===404?"You cannot access this ticket.":"Could not load ticket.");
  return res.json() as Promise<T>;
}
async function uploadFile(ticketId:number,file:File) {
  if(file.size>5*1024*1024 || file.size===0) throw new Error("File must be between 1 byte and 5 MB.");
  const data=new FormData();data.append("file",file,file.name);
  // The application's global API fetch wrapper supplies X-CSRF-Token for multipart writes.
  const response=await fetch(`/api/tickets/${ticketId}/attachments`,{
    method:"POST",body:data,credentials:"include",
  });
  if(!response.ok) {
    const info=await response.json().catch(()=>({message:"Upload failed"}));
    throw new Error(info.message||"Upload failed");
  }
}
export async function uploadInitialTicketEvidence(ticketId:number,file:File) {
  await uploadFile(ticketId,file);
}

export default function TicketConversation({ticketId,companyId,onBack,userNames,onChanged}:{
  ticketId:number;companyId:number|undefined;onBack:()=>void;userNames:Map<string,string>;onChanged:()=>void;
}) {
  const qc=useQueryClient();
  const [body,setBody]=useState("");
  const [resolutionNote,setResolutionNote]=useState("");
  const [reopenReason,setReopenReason]=useState("");
  const [error,setError]=useState("");
  const cameraInput=useRef<HTMLInputElement>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const detail=useQuery({queryKey:["ticket-detail",companyId,ticketId],queryFn:()=>readJson<Detail>(`/api/tickets/${ticketId}`)});
  const conversation=useQuery({queryKey:["ticket-conversation",companyId,ticketId],queryFn:()=>readJson<Conversation>(`/api/tickets/${ticketId}/conversation`)});
  const refresh=async()=>{
    await Promise.all([
      qc.invalidateQueries({queryKey:["ticket-detail",companyId,ticketId]}),
      qc.invalidateQueries({queryKey:["ticket-conversation",companyId,ticketId]}),
      qc.invalidateQueries({queryKey:["tickets",companyId]}),
    ]);
    onChanged();
  };
  const action=useMutation({
    mutationFn:async({kind,note}:{kind:"seen"|"start"|"finalize"|"reopen";note?:string})=>{
      const data=kind==="finalize"?{resolutionNote:note}:kind==="reopen"?{reason:note}:{};
      const response=await apiRequest("POST",`/api/tickets/${ticketId}/${kind}`,data);
      return response.json();
    },
    onSuccess:()=>{setError("");setResolutionNote("");setReopenReason("");void refresh();},
    onError:(e:Error)=>setError(e.message),
  });
  const comment=useMutation({
    mutationFn:async()=>{
      const response=await apiRequest("POST",`/api/tickets/${ticketId}/comments`,{body:body.trim()});
      return response.json();
    },
    onSuccess:()=>{setBody("");setError("");void refresh();},
    onError:(e:Error)=>setError(e.message),
  });
  const upload=useMutation({
    mutationFn:(file:File)=>uploadFile(ticketId,file),
    onSuccess:()=>{setError("");void refresh();},
    onError:(e:Error)=>setError(e.message),
  });
  const current=detail.data;
  // Seen receipt only when the assigned employee opens an Open ticket.
  useEffect(()=>{
    if(current?.capabilities.seen && current.ticket.status==="open" && !action.isPending) action.mutate({kind:"seen"});
  // Deliberately keyed to the server-provided status rather than mutate identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[current?.ticket.status,current?.capabilities.seen,ticketId]);
  const takeFile=(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];
    if(file) upload.mutate(file);
    event.target.value="";
  };
  const submitComment=(e:FormEvent)=>{e.preventDefault();if(body.trim())comment.mutate();};
  return <section className="mx-auto max-w-4xl space-y-4">
    <Button variant="outline" onClick={onBack}>Back to tickets</Button>
    {detail.isLoading&&<p role="status">Loading ticket...</p>}
    {detail.isError&&<p role="alert" className="text-destructive">{(detail.error as Error).message}</p>}
    {current&&<>
      <article className="rounded-xl border bg-card p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">{current.ticket.ticketNumber}</p>
        <h2 className="mt-1 text-xl font-semibold">{current.ticket.title}</h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{current.ticket.description}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <span className="rounded bg-muted px-2 py-1">Status: {current.ticket.status}</span>
          <span className="rounded bg-muted px-2 py-1">Priority: {current.ticket.priority}</span>
          <span className="rounded bg-muted px-2 py-1">Assigned: {userNames.get(current.ticket.assignedTo)??"Employee"}</span>
        </div>
        {current.records.map(record=><p key={record.id} className="mt-2 text-sm">Linked {record.recordType}: {record.displayReference}</p>)}
      </article>
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <h3 className="font-semibold">Progress and correction</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {current.capabilities.start&&<Button variant="outline" disabled={action.isPending} onClick={()=>action.mutate({kind:"start"})}>Start working</Button>}
        </div>
        {current.capabilities.finalize&&<form className="mt-4 space-y-2" onSubmit={e=>{e.preventDefault();action.mutate({kind:"finalize",note:resolutionNote});}}>
          <label className="block text-sm font-medium" htmlFor="ticket-resolution">Correction / resolution explanation</label>
          <Textarea id="ticket-resolution" required maxLength={10000} minLength={1} rows={3} value={resolutionNote} onChange={e=>setResolutionNote(e.target.value)} placeholder="Explain exactly what was corrected. Attach evidence below if applicable."/>
          <Button disabled={action.isPending||!resolutionNote.trim()} type="submit">Finalize ticket</Button>
        </form>}
        {current.capabilities.reopen&&<form className="mt-4 space-y-2" onSubmit={e=>{e.preventDefault();action.mutate({kind:"reopen",note:reopenReason});}}>
          <label className="block text-sm font-medium" htmlFor="ticket-reopen">Reason to reopen</label>
          <Textarea id="ticket-reopen" required maxLength={10000} value={reopenReason} onChange={e=>setReopenReason(e.target.value)} rows={2}/>
          <Button disabled={action.isPending||!reopenReason.trim()} variant="outline" type="submit">Reopen ticket</Button>
        </form>}
        {current.ticket.status==="finalized"&&<p className="mt-2 text-sm text-muted-foreground">Finalized. The creator or an authorized administrator can reopen with a reason.</p>}
      </div>
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <h3 className="font-semibold">Photos and evidence</h3>
        <p className="mt-1 text-xs text-muted-foreground">Private attachments. JPEG, PNG, WebP or PDF, maximum 5 MB each.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Capture ticket photo" onChange={takeFile}/>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" aria-label="Upload ticket evidence" onChange={takeFile}/>
          <Button type="button" variant="outline" disabled={upload.isPending} onClick={()=>cameraInput.current?.click()}>Take photo</Button>
          <Button type="button" variant="outline" disabled={upload.isPending} onClick={()=>fileInput.current?.click()}>Upload file</Button>
        </div>
        {upload.isPending&&<p role="status" className="mt-2 text-sm">Uploading evidence...</p>}
        {conversation.isLoading&&<p role="status" className="mt-2 text-sm">Loading evidence...</p>}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {conversation.data?.attachments.map(a=><div key={a.id} className="min-w-0 rounded-lg border p-3">
            {a.mimeType.startsWith("image/")&&<img src={`/api/tickets/${ticketId}/attachments/${a.id}`} alt={a.fileName} loading="lazy" className="mb-2 max-h-48 w-full rounded object-contain"/>}
            <a href={`/api/tickets/${ticketId}/attachments/${a.id}`} target="_blank" rel="noreferrer" className="break-all text-sm underline">{a.fileName}</a>
            <p className="text-xs text-muted-foreground">{(a.sizeBytes/1024).toFixed(0)} KB · {userNames.get(a.uploadedBy)??"Employee"}</p>
          </div>)}
        </div>
      </div>
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <h3 className="font-semibold">Case history</h3>
        <ol className="mt-3 space-y-2 text-sm">
          {conversation.data?.events.map(event=><li key={event.id} className="rounded-md border-l-2 pl-3">
            <span className="font-medium">{event.eventType.replaceAll("_"," ")}</span>
            <span className="ml-2 text-xs text-muted-foreground">{userNames.get(event.actorId)??"Employee"} · {new Date(event.createdAt).toLocaleString()}</span>
            {event.reason&&<p className="mt-1 whitespace-pre-wrap break-words text-xs">{event.reason}</p>}
          </li>)}
        </ol>
      </div>
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <h3 className="font-semibold">Case conversation</h3>
        <div className="mt-3 space-y-3">
          {conversation.data?.comments.map(c=><div key={c.id} className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">{userNames.get(c.authorId)??"Employee"} · {new Date(c.createdAt).toLocaleString()}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.body}</p>
          </div>)}
          {conversation.data?.comments.length===0&&<p className="text-sm text-muted-foreground">No comments yet.</p>}
        </div>
        <form onSubmit={submitComment} className="mt-4 space-y-2">
          <label htmlFor="ticket-comment" className="block text-sm font-medium">Add a comment or correction update</label>
          <Textarea id="ticket-comment" rows={3} maxLength={10000} value={body} onChange={e=>setBody(e.target.value)} placeholder="What have you checked or corrected?"/>
          <Button disabled={comment.isPending||!body.trim()} type="submit">Post comment</Button>
        </form>
      </div>
    </>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
