// Extracted from ./AICommandCenter.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Ban, Bot, CheckCheck, History, Loader2, Play, RotateCcw, ShieldCheck } from "lucide-react";
import {
  ApprovalCard,
  STATUS_CONFIG,
  StepRow,
  formatTaskType,
  timeAgo,
  useAICommandCenterState,
} from "./useAICommandCenterState";

export function AICommandCenterSection({
  activeTask,
  activeTaskId,
  allTasks,
  approvals,
  approveAction,
  cancelTask,
  completedSteps,
  plan,
  progress,
  rejectAction,
  runTask,
  setActiveTaskId,
  setTab,
  statusCfg,
  steps,
  tab,
  tasksQuery,
}: Pick<
  ReturnType<typeof useAICommandCenterState>,
  | "activeTask"
  | "activeTaskId"
  | "allTasks"
  | "approvals"
  | "approveAction"
  | "cancelTask"
  | "completedSteps"
  | "plan"
  | "progress"
  | "rejectAction"
  | "runTask"
  | "setActiveTaskId"
  | "setTab"
  | "statusCfg"
  | "steps"
  | "tab"
  | "tasksQuery"
>) {
  return (
    <div className="lg:col-span-3 p-5 overflow-auto">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="task" data-testid="tab-task">
            Active Task
            {activeTask && (
              <Badge variant="secondary" className="ml-2 text-[11px] px-1.5">
                {activeTask.status.replace(/_/g, " ")}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approvals" data-testid="tab-approvals">
            Approvals
            {approvals.length > 0 && (
              <Badge variant="default" className="ml-2 text-[11px] px-1.5 bg-amber-500 hover:bg-amber-500">
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
                        <Badge variant={cfg.variant} className="text-[11px] px-1.5 gap-1">
                          {cfg.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.userInstruction}</p>
                    </div>
                    <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(task.createdAt)}</span>
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
          approval. All write actions appear as draft previews in the <strong>Approvals</strong> tab before anything is
          recorded.
        </p>
      </div>
    </div>
  );
}
