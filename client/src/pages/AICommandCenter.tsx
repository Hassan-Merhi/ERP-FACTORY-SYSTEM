import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, Loader2, Upload, Zap, Lightbulb } from "lucide-react";
import { useAICommandCenterState } from "./useAICommandCenterState";
import { AICommandCenterSection } from "./AICommandCenterSection";

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AICommandCenter() {
  const {
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
  } = useAICommandCenterState();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 bg-background sm:px-6 sm:pt-4">
        <PageHeader
          title="AI Command Center"
          subtitle="Plan tasks, review drafts, and approve actions"
          icon={<Bot className="h-5 w-5 text-primary" />}
        />
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
          <AICommandCenterSection
            activeTask={activeTask}
            activeTaskId={activeTaskId}
            allTasks={allTasks}
            approvals={approvals}
            approveAction={approveAction}
            cancelTask={cancelTask}
            completedSteps={completedSteps}
            plan={plan}
            progress={progress}
            rejectAction={rejectAction}
            runTask={runTask}
            setActiveTaskId={setActiveTaskId}
            setTab={setTab}
            statusCfg={statusCfg}
            steps={steps}
            tab={tab}
            tasksQuery={tasksQuery}
          />
        </div>
      </div>
    </div>
  );
}
