import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface UseGITContainersDataProps {
  refetch: () => void;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  setImportResult: (
    v: { updated: number; skipped: number; notFound: number; errors: string[]; importId: string | null } | null
  ) => void;
}

export function useGITContainersData({
  refetch,
  toast,
  setImportResult,
}: UseGITContainersDataProps) {
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/git/containers/import-excel", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Import failed" }));
        throw new Error(err.message || "Import failed");
      }
      return res.json() as Promise<{
        updated: number;
        skipped: number;
        notFound: number;
        errors: string[];
        importId: string | null;
      }>;
    },
    onSuccess: (result) => {
      setImportResult(result);
      refetch();
      toast({
        title: `Import complete — ${result.updated} container${result.updated !== 1 ? "s" : ""} updated`,
        description: result.errors.length > 0 ? `${result.errors.length} row(s) had issues — see details.` : undefined,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const undoImportMutation = useMutation({
    mutationFn: async (importId: string) => {
      const res = await apiRequest("POST", "/api/git/containers/import-excel/undo", { importId });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Undo failed" }));
        throw new Error(err.message || "Undo failed");
      }
      return res.json() as Promise<{ reverted: number }>;
    },
    onSuccess: (result) => {
      setImportResult(null);
      refetch();
      toast({ title: `Undo complete — ${result.reverted} container${result.reverted !== 1 ? "s" : ""} reverted` });
    },
    onError: (err: Error) => {
      toast({ title: "Undo failed", description: err.message, variant: "destructive" });
    },
  });

  return {
    importMutation,
    undoImportMutation,
  };
}
