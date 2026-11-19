// Extracted from ./useAICommandCenterState.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, Loader2, ShieldCheck, ShieldX } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
export type StepStatus = "pending" | "running" | "completed" | "failed" | "waiting_approval" | "skipped";

export type TaskStatus = "planned" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

export interface PlanStep {
  id: string;
  name: string;
  tool: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
  status: StepStatus;
  result?: unknown;
  error?: string;
  approvalId?: number;
  startedAt?: string;
  completedAt?: string;
}

interface Approval {
  id: number;
  taskId: number;
  actionType: string;
  actionLabel: string;
  previewJson: unknown;
  payloadJson: unknown;
  status: string;
  createdAt: string;
}

export interface AgentTask {
  id: number;
  taskType: string;
  userInstruction: string;
  status: TaskStatus;
  planJson: { taskType: string; description: string; steps: PlanStep[] } | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskDetail extends AgentTask {
  approvals: Approval[];
}

export function ApprovalCard({
  approval,
  onApprove,
  onReject,
  approvePending,
  rejectPending,
}: {
  approval: Approval;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  approvePending: boolean;
  rejectPending: boolean;
}) {
  const [showFull, setShowFull] = useState(false);
  const preview = approval.previewJson;

  return (
    <Card data-testid={`card-approval-${approval.id}`}>
      <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold leading-tight">{approval.actionLabel}</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">{approval.actionType.replace(/_/g, " ")}</p>
        </div>
        <Badge variant="outline" className="text-xs text-amber-600 border-amber-400/50 shrink-0">
          Needs Approval
        </Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        {preview != null ? (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2 gap-1.5 text-muted-foreground"
              onClick={() => setShowFull((o) => !o)}
              data-testid={`button-toggle-preview-${approval.id}`}
            >
              <Eye className="h-3 w-3" />
              {showFull ? "Hide" : "Show"} preview
            </Button>

            {showFull && (
              <div className="mt-2 rounded-md border bg-muted/30 p-3 text-xs font-mono overflow-auto max-h-64">
                <pre className="whitespace-pre-wrap wrap-break-word">{JSON.stringify(preview, null, 2)}</pre>
              </div>
            )}
          </div>
        ) : null}

        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() => onApprove(approval.id)}
            disabled={approvePending || rejectPending}
            data-testid={`button-approve-${approval.id}`}
            className="gap-1.5"
          >
            {approvePending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onReject(approval.id)}
            disabled={approvePending || rejectPending}
            data-testid={`button-reject-${approval.id}`}
            className="gap-1.5"
          >
            {rejectPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldX className="h-3.5 w-3.5" />}
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
