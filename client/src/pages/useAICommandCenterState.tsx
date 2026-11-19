// Extracted from ./AICommandCenter.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Ban,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  ListTodo,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { StepStatus, TaskStatus, PlanStep, AgentTask, AgentTaskDetail } from "./ApprovalCard";
export { ApprovalCard } from "./ApprovalCard";

// ── Helpers ───────────────────────────────────────────────────────────────────
export const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }
> = {
  planned: { label: "Planned", variant: "secondary", icon: <ListTodo className="h-3 w-3" /> },
  running: { label: "Running", variant: "default", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  waiting_for_approval: { label: "Needs Approval", variant: "default", icon: <ShieldCheck className="h-3 w-3" /> },
  completed: { label: "Completed", variant: "secondary", icon: <CheckCheck className="h-3 w-3" /> },
  failed: { label: "Failed", variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
  cancelled: { label: "Cancelled", variant: "outline", icon: <Ban className="h-3 w-3" /> },
};

const STEP_ICON: Record<StepStatus, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-muted-foreground" />,
  running: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
  completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  waiting_approval: <ShieldCheck className="h-4 w-4 text-amber-500" />,
  skipped: <ChevronRight className="h-4 w-4 text-muted-foreground" />,
};

export function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatTaskType(t: string) {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Sub-components ────────────────────────────────────────────────────────────

export function StepRow({ step }: { step: PlanStep }) {
  const [open, setOpen] = useState(false);
  const hasResult = step.result != null || Boolean(step.error);

  return (
    <div className="group">
      <div
        className="flex items-start gap-3 py-2.5 px-3 rounded-md hover-elevate cursor-default"
        onClick={() => hasResult && setOpen((o) => !o)}
        data-testid={`step-row-${step.id}`}
      >
        <div className="mt-0.5 shrink-0">{STEP_ICON[step.status]}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight truncate">{step.name}</p>
          <p className="text-xs text-muted-foreground truncate">{step.tool}</p>
        </div>
        {step.status === "failed" && step.error && (
          <p className="text-xs text-red-500 max-w-[180px] truncate">{step.error}</p>
        )}
        {hasResult && (
          <Eye className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity shrink-0 mt-0.5" />
        )}
      </div>

      {open && hasResult && (
        <div className="mx-3 mb-2 rounded-md bg-muted/50 p-2.5 text-xs font-mono overflow-auto max-h-48">
          {step.error ? (
            <span className="text-red-500">{step.error}</span>
          ) : (
            <pre className="whitespace-pre-wrap wrap-break-word">{JSON.stringify(step.result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function useAICommandCenterState() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [instruction, setInstruction] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [tab, setTab] = useState("task");

  // ── Queries ─────────────────────────────────────────────────────────────
  const tasksQuery = useQuery<AgentTask[]>({
    queryKey: ["/api/ai-agent/tasks"],
  });

  const taskDetailQuery = useQuery<AgentTaskDetail>({
    queryKey: ["/api/ai-agent/tasks", activeTaskId],
    enabled: !!activeTaskId,
    refetchInterval: (q) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      const s = (q.state.data as AgentTaskDetail | undefined)?.status;
      return s === "running" || s === "waiting_for_approval" ? 2_000 : false;
    },
  });

  const activeTask = taskDetailQuery.data;

  // Auto-switch tab to approvals when task is waiting
  useEffect(() => {
    if (activeTask?.status === "waiting_for_approval") setTab("approvals");
  }, [activeTask?.status]);

  // ── Mutations ────────────────────────────────────────────────────────────
  const createTask = useMutation({
    mutationFn: async (data: { instruction: string }) => {
      const res = await apiRequest("POST", "/api/ai-agent/tasks", data);
      return (await res.json()) as { id: number; plan?: { steps?: unknown[] } };
    },
    onSuccess: (task) => {
      setActiveTaskId(task.id);
      setInstruction("");
      setUploadedFile(null);
      setTab("task");
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks"] });
      toast({ title: "Task created", description: `Plan ready — ${task.plan?.steps?.length ?? 0} step(s) generated` });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to create task", description: e.message, variant: "destructive" }),
  });

  const runTask = useMutation({
    mutationFn: (taskId: number) => apiRequest("POST", `/api/ai-agent/tasks/${taskId}/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks", activeTaskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  const cancelTask = useMutation({
    mutationFn: (taskId: number) => apiRequest("DELETE", `/api/ai-agent/tasks/${taskId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks", activeTaskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks"] });
    },
  });

  const approveAction = useMutation({
    mutationFn: (approvalId: number) => apiRequest("POST", `/api/ai-agent/approvals/${approvalId}/approve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks", activeTaskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks"] });
      toast({ title: "Approved", description: "Action approved and continuing task" });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Approval failed", description: e.message, variant: "destructive" }),
  });

  const rejectAction = useMutation({
    mutationFn: (approvalId: number) => apiRequest("POST", `/api/ai-agent/approvals/${approvalId}/reject`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks", activeTaskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-agent/tasks"] });
      toast({ title: "Rejected", description: "Action rejected. Task cancelled." });
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    createTask.mutate({ instruction: trimmed });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
  };

  const plan = activeTask?.planJson;
  const steps = plan?.steps ?? [];
  const approvals = (activeTask?.approvals ?? []).filter((a) => a.status === "pending");
  const allTasks = tasksQuery.data ?? [];
  const statusCfg = activeTask ? STATUS_CONFIG[activeTask.status] : null;

  const completedSteps = steps.filter((s) => s.status === "completed").length;
  const progress = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;
  return {
    activeTask,
    activeTaskId,
    allTasks,
    approvals,
    approveAction,
    cancelTask,
    completedSteps,
    createTask,
    fileRef,
    handleKeyDown,
    handleSubmit,
    instruction,
    plan,
    progress,
    rejectAction,
    runTask,
    setActiveTaskId,
    setInstruction,
    setTab,
    setUploadedFile,
    statusCfg,
    steps,
    tab,
    tasksQuery,
    uploadedFile,
  };
}
