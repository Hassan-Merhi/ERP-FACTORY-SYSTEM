import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronRight,
  Upload,
  Zap,
  AlertTriangle,
  CheckCheck,
  Ban,
  RotateCcw,
  Eye,
  ShieldCheck,
  ShieldX,
  History,
  ListTodo,
  Lightbulb,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type StepStatus = "pending" | "running" | "completed" | "failed" | "waiting_approval" | "skipped";
type TaskStatus = "planned" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

interface PlanStep {
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

interface AgentTask {
  id: number;
  taskType: string;
  userInstruction: string;
  status: TaskStatus;
  planJson: { taskType: string; description: string; steps: PlanStep[] } | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentTaskDetail extends AgentTask {
  approvals: Approval[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<
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

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatTaskType(t: string) {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepRow({ step }: { step: PlanStep }) {
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
          <Eye className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
        )}
      </div>

      {open && hasResult && (
        <div className="mx-3 mb-2 rounded-md bg-muted/50 p-2.5 text-xs font-mono overflow-auto max-h-48">
          {step.error ? (
            <span className="text-red-500">{step.error}</span>
          ) : (
            <pre className="whitespace-pre-wrap break-words">{JSON.stringify(step.result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
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
                <pre className="whitespace-pre-wrap break-words">{JSON.stringify(preview, null, 2)}</pre>
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

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AICommandCenter() {
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
      const s = (q.state.data as AgentTaskDetail | undefined)?.status;
      return s === "running" || s === "waiting_for_approval" ? 2000 : false;
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b bg-background flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10">
          <Bot className="h-4.5 w-4.5 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold leading-tight">AI Command Center</h1>
          <p className="text-xs text-muted-foreground">Plan tasks, review drafts, and approve actions</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-0 h-full divide-y lg:divide-y-0 lg:divide-x">
          {/* ── Left panel — instruction + quick tips ── */}
          <div className="lg:col-span-2 p-5 flex flex-col gap-4 bg-muted/20">
            {/* Instruction box */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  New Instruction
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  placeholder={`Describe what you want the AI to do…\ne.g. Find all items with low stock and prepare a list\ne.g. Check if supplier ACME has unpaid balances\n\n${typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘+Return" : "Ctrl+Enter"} to submit`}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={5}
                  data-testid="textarea-instruction"
                  className="resize-none text-sm"
                />

                {/* File upload */}
                <div
                  className="border-2 border-dashed rounded-md px-4 py-3 text-center cursor-pointer hover-elevate transition-colors"
                  onClick={() => fileRef.current?.click()}
                  data-testid="area-file-upload"
                >
                  <Upload className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                  {uploadedFile ? (
                    <p className="text-xs text-foreground font-medium truncate">{uploadedFile.name}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Attach an Excel file (optional)</p>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)}
                    data-testid="input-file-upload"
                  />
                </div>

                <Button
                  className="w-full gap-2"
                  onClick={handleSubmit}
                  disabled={!instruction.trim() || createTask.isPending}
                  data-testid="button-submit-instruction"
                >
                  {createTask.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Generating plan…
                    </>
                  ) : (
                    <>
                      <Bot className="h-4 w-4" /> Generate Plan
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Quick examples */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-amber-500" />
                  Example Instructions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {[
                    "Show me all items with stock below reorder level",
                    "Find supplier ACME and check their balance",
                    "Validate item codes: ITM001, ITM002, ITM999",
                    "Get today's sales summary and top items",
                    "Prepare a payment voucher draft for $5,000",
                    "Check pricing health — any items selling below cost?",
                  ].map((ex) => (
                    <button
                      key={ex}
                      className="w-full text-left text-xs text-muted-foreground py-1.5 px-2.5 rounded-md hover-elevate transition-colors leading-tight"
                      onClick={() => setInstruction(ex)}
                      data-testid={`button-example-${ex.slice(0, 20).replace(/\s/g, "-").toLowerCase()}`}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Right panel — task detail + history ── */}
          <div className="lg:col-span-3 p-5 overflow-auto">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-4">
                <TabsTrigger value="task" data-testid="tab-task">
                  Active Task
                  {activeTask && (
                    <Badge variant="secondary" className="ml-2 text-[10px] px-1.5">
                      {activeTask.status.replace(/_/g, " ")}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="approvals" data-testid="tab-approvals">
                  Approvals
                  {approvals.length > 0 && (
                    <Badge variant="default" className="ml-2 text-[10px] px-1.5 bg-amber-500 hover:bg-amber-500">
                      {approvals.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-history">
                  <History className="h-3.5 w-3.5 mr-1.5" />
                  History
                </TabsTrigger>
              </TabsList>

              {/* ── Active Task tab ────────────────────────────────────────── */}
              <TabsContent value="task" className="space-y-4 mt-0">
                {!activeTask && (
                  <div className="text-center py-16 text-muted-foreground">
                    <Bot className="h-10 w-10 mx-auto mb-3 opacity-25" />
                    <p className="text-sm font-medium">No active task</p>
                    <p className="text-xs mt-1">Write an instruction on the left to get started</p>
                  </div>
                )}

                {activeTask && (
                  <Card data-testid="card-active-task">
                    <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <Badge variant="secondary" className="text-xs">
                            {formatTaskType(activeTask.taskType)}
                          </Badge>
                          {statusCfg && (
                            <Badge variant={statusCfg.variant} className="text-xs gap-1">
                              {statusCfg.icon}
                              {statusCfg.label}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground leading-snug line-clamp-2">
                          {activeTask.userInstruction}
                        </p>
                        {plan?.description && (
                          <p className="text-xs text-muted-foreground/70 mt-1 italic">{plan.description}</p>
                        )}
                      </div>

                      <div className="flex gap-2 shrink-0">
                        {(activeTask.status === "planned" || activeTask.status === "running") && (
                          <Button
                            size="sm"
                            onClick={() => runTask.mutate(activeTask.id)}
                            disabled={runTask.isPending}
                            data-testid="button-run-task"
                            className="gap-1.5"
                          >
                            {runTask.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            Run
                          </Button>
                        )}
                        {!["completed", "failed", "cancelled"].includes(activeTask.status) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => cancelTask.mutate(activeTask.id)}
                            disabled={cancelTask.isPending}
                            data-testid="button-cancel-task"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </CardHeader>

                    {/* Progress bar */}
                    {steps.length > 0 && (
                      <div className="px-6 pb-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">
                            {completedSteps} / {steps.length} steps
                          </span>
                          <span className="text-xs text-muted-foreground">{progress}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-500"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Steps */}
                    {steps.length > 0 && (
                      <CardContent className="pt-2">
                        <div className="space-y-0.5">
                          {steps.map((step) => (
                            <StepRow key={step.id} step={step} />
                          ))}
                        </div>
                      </CardContent>
                    )}

                    {/* Error */}
                    {activeTask.errorMessage && (
                      <CardContent className="pt-0">
                        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3">
                          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                          <p className="text-xs text-destructive">{activeTask.errorMessage}</p>
                        </div>
                      </CardContent>
                    )}
                  </Card>
                )}

                {/* Completed — show result summary */}
                {activeTask?.status === "completed" && (
                  <div className="flex items-center justify-between rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900/40 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CheckCheck className="h-4 w-4 text-green-600" />
                      <span className="text-sm font-medium text-green-800 dark:text-green-300">
                        Task completed successfully
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setActiveTaskId(null)}
                      data-testid="button-clear-task"
                      className="text-xs gap-1 text-muted-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      New task
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* ── Approvals tab ──────────────────────────────────────────── */}
              <TabsContent value="approvals" className="space-y-3 mt-0">
                {approvals.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <ShieldCheck className="h-10 w-10 mx-auto mb-3 opacity-25" />
                    <p className="text-sm font-medium">No pending approvals</p>
                    <p className="text-xs mt-1">When the AI prepares a draft action, it will appear here</p>
                  </div>
                )}
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    onApprove={(id) => approveAction.mutate(id)}
                    onReject={(id) => rejectAction.mutate(id)}
                    approvePending={approveAction.isPending}
                    rejectPending={rejectAction.isPending}
                  />
                ))}
              </TabsContent>

              {/* ── History tab ────────────────────────────────────────────── */}
              <TabsContent value="history" className="mt-0">
                {tasksQuery.isLoading && (
                  <div className="flex justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!tasksQuery.isLoading && allTasks.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <History className="h-10 w-10 mx-auto mb-3 opacity-25" />
                    <p className="text-sm font-medium">No tasks yet</p>
                  </div>
                )}
                {allTasks.length > 0 && (
                  <div className="space-y-1.5">
                    {allTasks.map((task) => {
                      const cfg = STATUS_CONFIG[task.status];
                      const isActive = task.id === activeTaskId;
                      return (
                        <button
                          key={task.id}
                          className={`w-full text-left rounded-md px-3 py-2.5 hover-elevate transition-colors flex items-start gap-3 ${
                            isActive ? "bg-primary/5 ring-1 ring-primary/20" : ""
                          }`}
                          onClick={() => {
                            setActiveTaskId(task.id);
                            setTab("task");
                          }}
                          data-testid={`button-task-history-${task.id}`}
                        >
                          <div className="mt-0.5 shrink-0">{cfg.icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium">{formatTaskType(task.taskType)}</span>
                              <Badge variant={cfg.variant} className="text-[10px] px-1.5 gap-1">
                                {cfg.label}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.userInstruction}</p>
                          </div>
                          <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(task.createdAt)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            </Tabs>

            {/* Safety notice */}
            <Separator className="mt-6 mb-3" />
            <div className="flex items-start gap-2 text-muted-foreground/60">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed">
                The AI never posts vouchers, stock adjustments, purchase orders, or price changes without your explicit
                approval. All write actions appear as draft previews in the <strong>Approvals</strong> tab before
                anything is recorded.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
