import { z } from "zod";

/** Shared API validation contract. Company, creator and permissions are resolved by the server. */
export const ticketCreateSchema = z.object({
  title: z.string().trim().min(3).max(240),
  description: z.string().trim().min(3).max(10000),
  category: z.string().trim().min(2).max(80),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  sourceMode: z.enum(["erp", "factory"]),
  assignedTo: z.string().min(1).max(100),
  reportedUserId: z.string().max(100).nullable().optional(),
  voucherId: z.number().int().positive().optional(),
}).strict();

export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;
