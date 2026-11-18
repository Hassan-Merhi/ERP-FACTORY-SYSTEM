// Extracted from ./FactorySettingsView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, Loader2, MessageCircle } from "lucide-react";
import type { useFactorySettingsModel } from "./useFactorySettingsModel";
import { useLocation } from "wouter";

export type Props = {
  model: ReturnType<typeof useFactorySettingsModel>;
};

export function useFactorySettingsViewState({ model }: Props) {
  const [, navigate] = useLocation();
  const {
    settings,
    isLoading,
    mutation,
    handleToggle,
    handleNumberChange,
    handleSave,
    isDirty,
    handleReset,
    handleEnableAll,
    prodWaGroupId,
    setProdWaGroupId,
    prodWaSearch,
    setProdWaSearch,
    prodWaPickerOpen,
    setProdWaPickerOpen,
    waChats,
    waChatsLoading,
    filteredWaChats,
    saveProdWaGroupMutation,
    weeklyWaGroupId,
    setWeeklyWaGroupId,
    weeklyWaSearch,
    setWeeklyWaSearch,
    weeklyWaPickerOpen,
    setWeeklyWaPickerOpen,
    weeklyWaChats,
    weeklyWaChatsLoading,
    filteredWeeklyWaChats,
    saveWeeklyWaGroupMutation,
    attendanceWaGroupId,
    setAttendanceWaGroupId,
    attendanceWaSearch,
    setAttendanceWaSearch,
    attendanceWaPickerOpen,
    setAttendanceWaPickerOpen,
    attendanceWaChats,
    attendanceWaChatsLoading,
    filteredAttendanceWaChats,
    saveAttendanceWaGroupMutation,
  } = model;
  return {
    attendanceWaChats,
    attendanceWaChatsLoading,
    attendanceWaGroupId,
    attendanceWaPickerOpen,
    attendanceWaSearch,
    filteredAttendanceWaChats,
    filteredWaChats,
    filteredWeeklyWaChats,
    handleEnableAll,
    handleNumberChange,
    handleReset,
    handleSave,
    handleToggle,
    isDirty,
    isLoading,
    model,
    mutation,
    navigate,
    prodWaGroupId,
    prodWaPickerOpen,
    prodWaSearch,
    saveAttendanceWaGroupMutation,
    saveProdWaGroupMutation,
    saveWeeklyWaGroupMutation,
    setAttendanceWaGroupId,
    setAttendanceWaPickerOpen,
    setAttendanceWaSearch,
    setProdWaGroupId,
    setProdWaPickerOpen,
    setProdWaSearch,
    setWeeklyWaGroupId,
    setWeeklyWaPickerOpen,
    setWeeklyWaSearch,
    settings,
    waChats,
    waChatsLoading,
    weeklyWaChats,
    weeklyWaChatsLoading,
    weeklyWaGroupId,
    weeklyWaPickerOpen,
    weeklyWaSearch,
  };
}

export function FactorySettingsViewCardSection({
  handleNumberChange,
  settings,
}: Pick<ReturnType<typeof useFactorySettingsViewState>, "handleNumberChange" | "settings">) {
  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle data-testid="text-section-cost">Cost Configuration</CardTitle>
        <CardDescription>Default cost parameters for profitability calculations</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="laborCostPerKg">Labor Cost per KG</Label>
            <Input
              id="laborCostPerKg"
              type="number"
              step="0.01"
              min="0"
              value={settings.laborCostPerKg}
              onChange={(event) => handleNumberChange("laborCostPerKg", event.target.value)}
              data-testid="input-laborCostPerKg"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="overheadPerKg">Overhead per KG</Label>
            <Input
              id="overheadPerKg"
              type="number"
              step="0.01"
              min="0"
              value={settings.overheadPerKg}
              onChange={(event) => handleNumberChange("overheadPerKg", event.target.value)}
              data-testid="input-overheadPerKg"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function FactorySettingsViewCardSection2({
  attendanceWaChats,
  attendanceWaChatsLoading,
  attendanceWaGroupId,
  attendanceWaPickerOpen,
  attendanceWaSearch,
  filteredAttendanceWaChats,
  saveAttendanceWaGroupMutation,
  setAttendanceWaGroupId,
  setAttendanceWaPickerOpen,
  setAttendanceWaSearch,
}: Pick<
  ReturnType<typeof useFactorySettingsViewState>,
  | "attendanceWaChats"
  | "attendanceWaChatsLoading"
  | "attendanceWaGroupId"
  | "attendanceWaPickerOpen"
  | "attendanceWaSearch"
  | "filteredAttendanceWaChats"
  | "saveAttendanceWaGroupMutation"
  | "setAttendanceWaGroupId"
  | "setAttendanceWaPickerOpen"
  | "setAttendanceWaSearch"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" />
          Attendance WhatsApp Group
        </CardTitle>
        <CardDescription>
          Select the WhatsApp group used by the Attendance page when you press "Send WhatsApp Image".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {attendanceWaGroupId && !attendanceWaPickerOpen && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium" data-testid="text-attendance-wa-group">
              {attendanceWaChats.find((chat) => chat.id === attendanceWaGroupId)?.name ?? attendanceWaGroupId}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttendanceWaPickerOpen(true)}
              data-testid="button-change-attendance-wa-group"
            >
              Change
            </Button>
          </div>
        )}
        {!attendanceWaGroupId && !attendanceWaPickerOpen && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttendanceWaPickerOpen(true)}
            data-testid="button-select-attendance-wa-group"
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            Select WhatsApp Group
          </Button>
        )}
        {attendanceWaPickerOpen && (
          <div className="space-y-2">
            <Input
              placeholder="Search WhatsApp groups…"
              value={attendanceWaSearch}
              onChange={(event) => setAttendanceWaSearch(event.target.value)}
              data-testid="input-attendance-wa-search"
            />
            <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
              {attendanceWaChatsLoading && (
                <p className="text-muted-foreground text-center py-4">
                  <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                  Loading WhatsApp groups…
                </p>
              )}
              {!attendanceWaChatsLoading && filteredAttendanceWaChats.length === 0 && (
                <p className="text-muted-foreground text-center py-4">No WhatsApp groups found</p>
              )}
              {filteredAttendanceWaChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => setAttendanceWaGroupId(chat.id)}
                  className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                    attendanceWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                  }`}
                  data-testid={`option-attendance-wa-chat-${chat.id}`}
                >
                  <div className="font-medium">{chat.name || chat.id}</div>
                  <div className="text-xs text-muted-foreground">{chat.id}</div>
                </button>
              ))}
            </div>
            {attendanceWaGroupId && (
              <p className="text-xs text-muted-foreground">
                Selected:{" "}
                <span className="font-medium">
                  {attendanceWaChats.find((chat) => chat.id === attendanceWaGroupId)?.name ?? attendanceWaGroupId}
                </span>
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveAttendanceWaGroupMutation.mutate(attendanceWaGroupId)}
                disabled={!attendanceWaGroupId || saveAttendanceWaGroupMutation.isPending}
                data-testid="button-save-attendance-wa-group"
              >
                {saveAttendanceWaGroupMutation.isPending ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <CheckCircle className="h-3 w-3 mr-1" />
                )}
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAttendanceWaPickerOpen(false);
                  setAttendanceWaSearch("");
                }}
                data-testid="button-cancel-attendance-wa-group"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
