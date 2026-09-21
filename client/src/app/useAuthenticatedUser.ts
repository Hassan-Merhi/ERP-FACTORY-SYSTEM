import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { clearBiometricCredentials } from "@/lib/biometricCredentials";

/**
 * Manages the authenticated user session:
 *   - /api/auth/me query with runtime response validation
 *   - transient auth transport failures stay in a recoverable loading/error state
 *   - only a confirmed 401 resolves the user to null and permits a login redirect
 *   - handleLogout — clears cache, clears biometric credentials, redirects
 */
export function useAuthenticatedUser() {
  // authenticatedUserQueryOptions() owns the login-route guard
  // (window.location.pathname === "/login"; enabled: !isLoginRoute).
  // Keep the direct useQuery(authenticatedUserQueryOptions()) wiring here so
  // all authenticated-user consumers share the typed query contract.
  const { data: user, isLoading, error } = useQuery(authenticatedUserQueryOptions());

  const handleLogout = async (): Promise<void> => {
    try {
      await apiRequest("POST", "/api/auth/logout", {});
      queryClient.clear();
      try {
        await clearBiometricCredentials();
      } catch {
        // Biometric support is optional and must not block logout.
      }
      window.location.href = "/login";
    } catch (logoutError: unknown) {
      console.error("Logout failed:", logoutError);
    }
  };

  return { user, isLoading, error, handleLogout };
}
