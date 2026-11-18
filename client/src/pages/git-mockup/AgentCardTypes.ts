// Extracted from ./AgentCard.tsx to keep that module under the source-size cap.

export interface AdjEntry {
  id: number;
  description: string;
  amount: number;
  type: string;
}

export type PrepaidDesignation = { containerId: number };
