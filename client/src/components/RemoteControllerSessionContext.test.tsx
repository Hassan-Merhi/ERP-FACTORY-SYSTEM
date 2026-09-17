import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteControllerSessionProvider, useRemoteControllerSession } from "./RemoteControllerSessionContext";
import * as portal from "./remote-control-panel-portal";

function TargetProbe() {
  const { target } = useRemoteControllerSession();
  return <output data-testid="remote-watch-target">{target ? `${target.userId}:${target.username}` : "none"}</output>;
}

function createWatchPortal(userId: string, username: string, tabId = "tab-1") {
  const portalRoot = document.createElement("div");
  portalRoot.setAttribute("data-radix-portal", "");
  const dialog = document.createElement("section");
  dialog.setAttribute("data-testid", "dialog-watch-user");
  dialog.dataset.watchedUserId = userId;
  // A watch target is tab-scoped: without the tab the dialog names, the
  // provider has no addressable target and deliberately reports none.
  dialog.dataset.watchedTabId = tabId;
  const usernameNode = document.createElement("span");
  usernameNode.dataset.watchUsername = username;
  dialog.appendChild(usernameNode);
  portalRoot.appendChild(dialog);
  return { portalRoot, dialog, usernameNode };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessions: [] }),
    })
  );
});

describe("RemoteControllerSessionProvider watch-target discovery", () => {
  it("ignores unrelated ERP subtree mutations and discovers target changes inside a Radix portal", async () => {
    const noiseRoot = document.createElement("div");
    document.body.appendChild(noiseRoot);
    const findDialog = vi.spyOn(portal, "findRemoteSupportWatchDialog");

    render(
      <RemoteControllerSessionProvider>
        <TargetProbe />
      </RemoteControllerSessionProvider>
    );

    expect(screen.getByTestId("remote-watch-target")).toHaveTextContent("none");
    findDialog.mockClear();

    await act(async () => {
      noiseRoot.appendChild(document.createElement("button"));
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    // The long-lived observer is shallow; ordinary render churn beneath the
    // application root does not trigger a whole-document watch-dialog query.
    expect(findDialog).not.toHaveBeenCalled();

    const { portalRoot, dialog, usernameNode } = createWatchPortal("employee-42", "Amina");
    await act(async () => {
      document.body.appendChild(portalRoot);
    });

    await waitFor(() => expect(screen.getByTestId("remote-watch-target")).toHaveTextContent("employee-42:Amina"));

    await act(async () => {
      // The two updates arrive as a single UI transition. The observer coalesces
      // the burst before asking the document for the final watch target.
      dialog.dataset.watchedUserId = "employee-43";
      usernameNode.dataset.watchUsername = "Layla";
    });

    await waitFor(() => expect(screen.getByTestId("remote-watch-target")).toHaveTextContent("employee-43:Layla"));
  });
});
