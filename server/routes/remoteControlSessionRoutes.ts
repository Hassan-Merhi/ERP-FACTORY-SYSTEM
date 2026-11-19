import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { getSessionCompanyId } from "../lib/requestContext";
import {
  getRemoteMouseAuthorization,
  publishRemoteMouseCommandResult,
  subscribeRemoteMouseResults,
} from "../services/remoteControlCommandService";
import {
  getActiveRemoteControlSession,
  getRemoteControlSession,
  isRemoteControlControllerRole,
  listActiveRemoteControlSessionsForController,
  listRemoteControlTabs,
  registerRemoteControlTab,
  stopRemoteControlSession,
  subscribeRemoteControlTarget,
} from "../services/remoteControlSessionService";
import { getRemoteKeyboardAuthorization } from "../services/remoteKeyboardCommandService";
import { writeRemoteSupportAudit } from "../services/remoteSupportAuditService";
import { enqueueRemoteSupportCommandAudit } from "../services/remoteSupportCommandAuditQueue";
import { isRemoteSupportEnabled } from "../services/remoteSupportRuntime";
import {
  STATUS_REFRESH_MS,
  COMMAND_HEARTBEAT_MS,
  viewPermission,
  mousePermission,
  sessionUserId,
  sessionUsername,
  sessionRole,
  requireController,
  serializeSession,
  serializeMouseAuthorization,
  serializeKeyboardAuthorization,
  serializeMouseCommandResult,
  openEventStream,
  writeEvent,
  writeHeartbeat,
  handleSessionError,
} from "./remoteControlSessionHelpers";
import { registerRemoteControlSessionRoutesPart1 } from "./registerRemoteControlSessionRoutesPart1";

export function registerRemoteControlSessionRoutes(app: Express): void {
  app.get("/api/screen-feed/control/tabs/:userId", requireAuth, viewPermission, (req, res) => {
    if (!requireController(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ tabs: listRemoteControlTabs(req.params.userId) });
  });

  app.post("/api/screen-feed/control/tab-heartbeat", requireLogin, (req, res) => {
    try {
      const session = registerRemoteControlTab({
        userId: sessionUserId(req),
        username: sessionUsername(req),
        tabId: req.body?.tabId,
        companyId: getSessionCompanyId(req),
        route: req.body?.route,
      });
      res.setHeader("Cache-Control", "no-store");
      if (!session) {
        res.status(204).end();
        return;
      }
      res.json({ session: serializeSession(session) });
    } catch (error) {
      handleSessionError(error, res);
    }
  });

  app.get("/api/screen-feed/control/status", requireLogin, (req, res) => {
    const userId = sessionUserId(req);
    const tabId = typeof req.query.tabId === "string" ? req.query.tabId : "";
    if (!tabId) return res.status(400).json({ message: "A browser tab identifier is required." });

    try {
      registerRemoteControlTab({
        userId,
        username: sessionUsername(req),
        tabId,
        companyId: getSessionCompanyId(req),
        route: typeof req.query.route === "string" ? req.query.route : "/",
      });
    } catch (error) {
      return handleSessionError(error, res);
    }

    openEventStream(res);
    let closed = false;
    const sendStatus = () => {
      writeEvent(res, "control", {
        enabled: isRemoteSupportEnabled("remoteControl"),
        session: serializeSession(getActiveRemoteControlSession(userId, tabId)),
      });
    };
    const unsubscribe = subscribeRemoteControlTarget(userId, sendStatus);
    const refreshId = setInterval(sendStatus, STATUS_REFRESH_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(refreshId);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
    sendStatus();
  });

  app.get("/api/screen-feed/control/sessions/controller-active", requireAuth, viewPermission, (req, res) => {
    if (!requireController(req, res)) return;
    const controllerUserId = sessionUserId(req);
    const sessions = listActiveRemoteControlSessionsForController(controllerUserId)
      .filter((session) => session.companyId === getSessionCompanyId(req))
      .map((session) => {
        const keyboardAuthorization = getRemoteKeyboardAuthorization(session.id, controllerUserId);
        const refreshedSession = getRemoteControlSession(session.id) ?? session;
        return {
          ...serializeSession(refreshedSession)!,
          mouseAuthorization: serializeMouseAuthorization(getRemoteMouseAuthorization(session.id, controllerUserId)),
          keyboardAuthorization: serializeKeyboardAuthorization(keyboardAuthorization),
        };
      });
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions });
  });

  registerRemoteControlSessionRoutesPart1(app);

  app.get("/api/screen-feed/control/sessions/:sessionId/results", requireAuth, mousePermission, (req, res) => {
    if (!requireController(req, res)) return;
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeRemoteMouseResults({
        sessionId: req.params.sessionId,
        controllerUserId: sessionUserId(req),
        listener: (result) => writeEvent(res, "result", serializeMouseCommandResult(result)),
      });
    } catch (error) {
      return handleSessionError(error, res);
    }
    openEventStream(res);
    let closed = false;
    const heartbeatId = setInterval(() => writeHeartbeat(res), COMMAND_HEARTBEAT_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatId);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
    writeEvent(res, "ready", { sessionId: req.params.sessionId });
  });

  app.post("/api/screen-feed/control/sessions/:sessionId/commands/:commandId/result", requireLogin, (req, res) => {
    try {
      const result = publishRemoteMouseCommandResult({
        sessionId: req.params.sessionId,
        commandId: req.params.commandId,
        targetUserId: sessionUserId(req),
        targetTabId: req.body?.tabId,
        status: req.body?.status,
        reason: req.body?.reason,
      });
      const session = getRemoteControlSession(req.params.sessionId);
      if (session) {
        // The acknowledgement path is the employee tab's inner loop: one call
        // per executed command. Awaiting an insert here made every command
        // round trip pay for a write twice, so the row is batched instead.
        enqueueRemoteSupportCommandAudit({
          event: result.status === "blocked" ? "command_blocked" : "mouse_result",
          session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: {
            capability: "mouse",
            status: result.status,
            reason: result.reason,
            route: session.targetRoute,
          },
        });
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ result: serializeMouseCommandResult(result) });
    } catch (error) {
      handleSessionError(error, res);
    }
  });

  app.post("/api/screen-feed/control/sessions/:sessionId/stop", requireLogin, async (req, res) => {
    const session = getRemoteControlSession(req.params.sessionId);
    if (!session) return res.status(404).json({ message: "Support session not found." });
    const actorUserId = sessionUserId(req);
    const actorIsTarget = session.targetUserId === actorUserId;
    const actorIsController = session.controllerUserId === actorUserId;
    const actorIsAuthorizedController = isRemoteControlControllerRole(sessionRole(req));
    if (!actorIsTarget && !actorIsController && !actorIsAuthorizedController) {
      return res.status(403).json({ message: "Access denied." });
    }
    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 160)
        : actorIsTarget
          ? "target-emergency-stop"
          : "controller-stopped";
    const stopped = stopRemoteControlSession(session.id, reason);
    if (stopped) {
      try {
        await writeRemoteSupportAudit({
          event: "session_stopped",
          session: stopped,
          actorUserId,
          actorUsername: sessionUsername(req),
          details: { capability: "view", stopReason: reason, route: stopped.targetRoute },
        });
      } catch {
        // Stopping remains fail-safe even when the audit database is unavailable.
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ session: serializeSession(stopped) });
  });
}
