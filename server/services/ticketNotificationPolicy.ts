export const TICKET_REMINDER_HOURS = 24;

export type TicketEventType =
  | "ticket_created" | "ticket_seen" | "ticket_start" | "ticket_finalize"
  | "ticket_reopen" | "ticket_comment" | "ticket_attachment" | "ticket_overdue";

export type TicketDispatchEvent = {
  eventType: string;
  createdBy: string;
  assignedTo: string;
  actorId: string | null;
  participantIds: string[];
};

export function ticketEventRecipients(event: TicketDispatchEvent): string[] {
  let recipients: string[];
  switch (event.eventType) {
    case "ticket_created":
    case "ticket_reopen":
    case "ticket_overdue":
      recipients = [event.assignedTo];
      break;
    case "ticket_seen":
    case "ticket_start":
    case "ticket_finalize":
      recipients = [event.createdBy];
      break;
    case "ticket_comment":
    case "ticket_attachment":
      recipients = [event.createdBy,event.assignedTo,...event.participantIds];
      break;
    default:
      return [];
  }
  return [...new Set(recipients.filter(id=>Boolean(id) && id!==event.actorId))];
}

export function ticketEventCopy(eventType:string,ticketNumber:string) {
  const labels:Record<string,string>={
    ticket_created:"assigned to you",
    ticket_seen:"was seen",
    ticket_start:"is being worked on",
    ticket_finalize:"was finalized",
    ticket_reopen:"was reopened",
    ticket_comment:"received a new comment",
    ticket_attachment:"received new evidence",
    ticket_overdue:"is overdue",
  };
  const label=labels[eventType]??"was updated";
  return { eventCode:"TICKET_"+eventType.replace(/^ticket_/,"").toUpperCase(),
    title:`Ticket ${ticketNumber}`,
    message:`Ticket ${ticketNumber} ${label}. Open the ERP/Factory Ticket Management page to review.` };
}


/** Optional authenticated deep link; never construct from user-supplied URLs. */
export function ticketDestinationUrl(base:string|undefined,sourceMode:string,ticketId:number):string|null {
  if(!base || !Number.isSafeInteger(ticketId) || ticketId<=0)return null;
  try{
    const parsed=new URL(base);
    if(parsed.protocol!=="https:" || parsed.username || parsed.password)return null;
    const destination=new URL(sourceMode==="factory"?"/factory/tickets":"/tickets",parsed.origin);
    destination.searchParams.set("ticketId",String(ticketId));
    return destination.toString();
  }catch{return null;}
}
