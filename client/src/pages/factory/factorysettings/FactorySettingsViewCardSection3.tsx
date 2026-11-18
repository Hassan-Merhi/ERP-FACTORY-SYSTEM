// Extracted from ./FactorySettingsView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2, MessageCircle } from "lucide-react";
import { useFactorySettingsViewState } from "./FactorySettingsViewCardSection2";

export function FactorySettingsViewCardSection3({
  filteredWeeklyWaChats,
  saveWeeklyWaGroupMutation,
  setWeeklyWaGroupId,
  setWeeklyWaPickerOpen,
  setWeeklyWaSearch,
  weeklyWaChats,
  weeklyWaChatsLoading,
  weeklyWaGroupId,
  weeklyWaPickerOpen,
  weeklyWaSearch,
}: Pick<
  ReturnType<typeof useFactorySettingsViewState>,
  | "filteredWeeklyWaChats"
  | "saveWeeklyWaGroupMutation"
  | "setWeeklyWaGroupId"
  | "setWeeklyWaPickerOpen"
  | "setWeeklyWaSearch"
  | "weeklyWaChats"
  | "weeklyWaChatsLoading"
  | "weeklyWaGroupId"
  | "weeklyWaPickerOpen"
  | "weeklyWaSearch"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" />
          Weekly Report WhatsApp Group
        </CardTitle>
        <CardDescription>
          Select the WhatsApp group that receives the Weekly Production Report Excel file when you press "Send" on the
          report panel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {weeklyWaGroupId && !weeklyWaPickerOpen && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium" data-testid="text-weekly-wa-group">
              {weeklyWaChats.find((chat) => chat.id === weeklyWaGroupId)?.name ?? weeklyWaGroupId}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWeeklyWaPickerOpen(true)}
              data-testid="button-change-weekly-wa-group"
            >
              Change
            </Button>
          </div>
        )}
        {!weeklyWaGroupId && !weeklyWaPickerOpen && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWeeklyWaPickerOpen(true)}
            data-testid="button-select-weekly-wa-group"
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            Select WhatsApp Group
          </Button>
        )}
        {weeklyWaPickerOpen && (
          <div className="space-y-2">
            <Input
              placeholder="Search chats…"
              value={weeklyWaSearch}
              onChange={(event) => setWeeklyWaSearch(event.target.value)}
              data-testid="input-weekly-wa-search"
            />
            <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
              {weeklyWaChatsLoading && (
                <p className="text-muted-foreground text-center py-4">
                  <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                  Loading chats…
                </p>
              )}
              {!weeklyWaChatsLoading && filteredWeeklyWaChats.length === 0 && (
                <p className="text-muted-foreground text-center py-4">No chats found</p>
              )}
              {filteredWeeklyWaChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => setWeeklyWaGroupId(chat.id)}
                  className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                    weeklyWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                  }`}
                  data-testid={`option-weekly-wa-chat-${chat.id}`}
                >
                  <div className="font-medium">{chat.name}</div>
                  <div className="text-xs text-muted-foreground">{chat.type}</div>
                </button>
              ))}
            </div>
            {weeklyWaGroupId && (
              <p className="text-xs text-muted-foreground">
                Selected:{" "}
                <span className="font-medium">
                  {weeklyWaChats.find((chat) => chat.id === weeklyWaGroupId)?.name ?? weeklyWaGroupId}
                </span>
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveWeeklyWaGroupMutation.mutate(weeklyWaGroupId)}
                disabled={!weeklyWaGroupId || saveWeeklyWaGroupMutation.isPending}
                data-testid="button-save-weekly-wa-group"
              >
                {saveWeeklyWaGroupMutation.isPending ? (
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
                  setWeeklyWaPickerOpen(false);
                  setWeeklyWaSearch("");
                }}
                data-testid="button-cancel-weekly-wa-group"
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

export function FactorySettingsViewCardSection4({
  filteredWaChats,
  prodWaGroupId,
  prodWaPickerOpen,
  prodWaSearch,
  saveProdWaGroupMutation,
  setProdWaGroupId,
  setProdWaPickerOpen,
  setProdWaSearch,
  waChats,
  waChatsLoading,
}: Pick<
  ReturnType<typeof useFactorySettingsViewState>,
  | "filteredWaChats"
  | "prodWaGroupId"
  | "prodWaPickerOpen"
  | "prodWaSearch"
  | "saveProdWaGroupMutation"
  | "setProdWaGroupId"
  | "setProdWaPickerOpen"
  | "setProdWaSearch"
  | "waChats"
  | "waChatsLoading"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" />
          Production WhatsApp Group
        </CardTitle>
        <CardDescription>
          Select the WhatsApp group that receives the Worker Matrix PDF when production is ended. This group is also
          used for manual sends from Stock Entry History.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {prodWaGroupId && !prodWaPickerOpen && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium" data-testid="text-prod-wa-group">
              {waChats.find((chat) => chat.id === prodWaGroupId)?.name ?? prodWaGroupId}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProdWaPickerOpen(true)}
              data-testid="button-change-prod-wa-group"
            >
              Change
            </Button>
          </div>
        )}
        {!prodWaGroupId && !prodWaPickerOpen && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setProdWaPickerOpen(true)}
            data-testid="button-select-prod-wa-group"
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            Select WhatsApp Group
          </Button>
        )}
        {prodWaPickerOpen && (
          <div className="space-y-2">
            <Input
              placeholder="Search chats…"
              value={prodWaSearch}
              onChange={(event) => setProdWaSearch(event.target.value)}
              data-testid="input-prod-wa-search"
            />
            <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
              {waChatsLoading && (
                <p className="text-muted-foreground text-center py-4">
                  <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                  Loading chats…
                </p>
              )}
              {!waChatsLoading && filteredWaChats.length === 0 && (
                <p className="text-muted-foreground text-center py-4">No chats found</p>
              )}
              {filteredWaChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => setProdWaGroupId(chat.id)}
                  className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                    prodWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                  }`}
                  data-testid={`option-prod-wa-chat-${chat.id}`}
                >
                  <div className="font-medium">{chat.name}</div>
                  <div className="text-xs text-muted-foreground">{chat.type}</div>
                </button>
              ))}
            </div>
            {prodWaGroupId && (
              <p className="text-xs text-muted-foreground">
                Selected:{" "}
                <span className="font-medium">
                  {waChats.find((chat) => chat.id === prodWaGroupId)?.name ?? prodWaGroupId}
                </span>
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveProdWaGroupMutation.mutate(prodWaGroupId)}
                disabled={!prodWaGroupId || saveProdWaGroupMutation.isPending}
                data-testid="button-save-prod-wa-group"
              >
                {saveProdWaGroupMutation.isPending ? (
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
                  setProdWaPickerOpen(false);
                  setProdWaSearch("");
                }}
                data-testid="button-cancel-prod-wa-group"
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
