// Extracted from ./gitAgentRoutes.ts

/** Shape of a git_agent_adjustments row as selected by the queries below. */
export type GitAgentAdjustmentRow = {
  id: number;
  agent_name?: string;
  description: string | null;
  amount: string;
  type: string;
  created_at: string | Date;
};

/** DTO returned to the client for one adjustment. */
export type GitAgentAdjustment = {
  id: number;
  description: string | null;
  amount: number;
  type: string;
  createdAt: string | Date;
};
