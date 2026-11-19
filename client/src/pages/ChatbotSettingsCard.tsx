// Extracted from ./ChatbotSettings.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/page-state";
import { Loader2, Check, GitBranch, Eye, EyeOff } from "lucide-react";
import { useChatbotSettingsState } from "./useChatbotSettingsState";

export function ChatbotSettingsCard({
  githubLoading,
  githubMutation,
  githubRepoUrl,
  githubSettings,
  githubToken,
  setGithubRepoUrl,
  setGithubToken,
  setShowToken,
  showToken,
}: Pick<
  ReturnType<typeof useChatbotSettingsState>,
  | "githubLoading"
  | "githubMutation"
  | "githubRepoUrl"
  | "githubSettings"
  | "githubToken"
  | "setGithubRepoUrl"
  | "setGithubToken"
  | "setShowToken"
  | "showToken"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <GitBranch className="h-5 w-5" />
          GitHub Integration
        </CardTitle>
        <CardDescription>
          Store your repository URL and a GitHub token separately — the token is never returned to the browser and is
          composed server-side when pushing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {githubLoading ? (
          <LoadingState />
        ) : (
          <>
            {githubSettings?.configured && (
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <Check className="h-4 w-4 text-green-500 shrink-0" />
                <span className="font-mono text-muted-foreground truncate max-w-sm">{githubSettings.repoUrl}</span>
                <Badge
                  variant="outline"
                  className={
                    githubSettings.hasToken
                      ? "bg-green-500/10 text-green-600 border-green-500/30"
                      : "bg-orange-500/10 text-orange-600 border-orange-500/30"
                  }
                >
                  {githubSettings.hasToken ? "Token configured" : "No token"}
                </Badge>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Repository URL</label>
              <input
                type="text"
                className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-1 focus:ring-ring"
                placeholder={
                  githubSettings?.configured ? "Enter new URL to replace…" : "https://github.com/user/repo.git"
                }
                value={githubRepoUrl}
                onChange={(e) => setGithubRepoUrl(e.target.value)}
                data-testid="input-github-repo-url"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Personal Access Token
                {githubSettings?.hasToken && (
                  <span className="ml-2 text-green-600">(currently set — enter new to replace)</span>
                )}
              </label>
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  className="w-full h-9 rounded-md border border-border bg-background px-3 pr-9 text-sm font-mono focus:outline-hidden focus:ring-1 focus:ring-ring"
                  placeholder={githubSettings?.hasToken ? "Enter new token to replace…" : "ghp_xxxxxxxxxxxx"}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  data-testid="input-github-token"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowToken((v) => !v)}
                  tabIndex={-1}
                >
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <Button
              size="sm"
              onClick={() =>
                githubMutation.mutate({ repoUrl: githubRepoUrl || undefined, token: githubToken || undefined })
              }
              disabled={githubMutation.isPending || (!githubRepoUrl.trim() && !githubToken.trim())}
              data-testid="button-save-github"
            >
              {githubMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Check className="h-3.5 w-3.5 mr-1" />
              )}
              Save Settings
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
