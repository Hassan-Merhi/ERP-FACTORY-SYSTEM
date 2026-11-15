// Extracted from ./remoteControlSessionRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { getSessionCompanyId } from "../lib/requestContext";
import {
  assertRemoteMouseCommandAdmission,
  authorizeRemoteMouseControl,
  getRemoteMouseAuthorization,
  publishRemoteMouseCommand,
  publishRemoteMouseCommandResult,
  revokeRemoteMouseControl,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
} from "../services/remoteControlCommandService";
import {
  getActiveRemoteControlSession,
  getRemoteControlSession,
  heartbeatRemoteControlController,
  isRemoteControlControllerRole,
  listActiveRemoteControlSessionsForController,
  listRemoteControlTabs,
  registerRemoteControlTab,
  startRemoteControlSession,
  stopRemoteControlSession,
  subscribeRemoteControlTarget,
} from "../services/remoteControlSessionService";
import { getRemoteKeyboardAuthorization } from "../services/remoteKeyboardCommandService";
import { remoteSupportCommandAuditDetails, writeRemoteSupportAudit } from "../services/remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "../services/remoteSupportCommandAuditQueue";
import { isRemoteMouseCommandAllowedOnRoute } from "../services/remoteSupportSensitiveActionPolicy";
import { isRemoteSupportEnabled } from "../services/remoteSupportRuntime";
import {
  COMMAND_HEARTBEAT_MS,
  STATUS_REFRESH_MS,
  handleSessionError,
  mousePermission,
  openEventStream,
  passwordConfirmedAt,
  requireController,
  respondAuditUnavailable,
  serializeKeyboardAuthorization,
  serializeMouseAuthorization,
  serializeMouseCommand,
  serializeMouseCommandResult,
  serializeSession,
  sessionRole,
  sessionUserId,
  sessionUsername,
  viewPermission,
  writeAuditOrUnavailable,
  writeEvent,
  writeHeartbeat,
} from "./handleSessionError";

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

  app.get("/api/screen-feed/control/sessions/active/:userId", requireAuth, viewPermission, (req, res) => {
    if (!requireController(req, res)) return;
    const session = getActiveRemoteControlSession(req.params.userId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      session: session?.companyId === getSessionCompanyId(req) ? serializeSession(session) : null,
    });
  });

  app.post("/api/screen-feed/control/sessions", requireAuth, viewPermission, async (req, res) => {
    if (!requireController(req, res)) return;
    try {
      const durationMinutes = Number(req.body?.durationMinutes);
      const session = startRemoteControlSession({
        targetUserId: req.body?.targetUserId,
        targetUsername: req.body?.targetUsername,
        requestedTabId: req.body?.tabId,
        controllerUserId: sessionUserId(req),
        controllerUsername: sessionUsername(req),
        controllerRole: sessionRole(req),
        controllerCompanyId: getSessionCompanyId(req),
        durationMs: Number.isFinite(durationMinutes) ? durationMinutes * 60 * 1000 : undefined,
      });
      const audited = await writeAuditOrUnavailable(
        {
          event: "session_started",
          session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: { capability: "view", status: "requested", route: session.targetRoute },
        },
        res
      );
      if (!audited) {
        stopRemoteControlSession(session.id, "audit-unavailable");
        return;
      }
      res.status(201).json({ session: serializeSession(session) });
    } catch (error) {
      handleSessionError(error, res);
    }
  });

  app.post("/api/screen-feed/control/sessions/:sessionId/heartbeat", requireAuth, viewPermission, (req, res) => {
    if (!requireController(req, res)) return;
    const session = heartbeatRemoteControlController(req.params.sessionId, sessionUserId(req));
    if (!session || session.companyId !== getSessionCompanyId(req)) {
      return res.status(404).json({ message: "The support session is no longer active." });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ session: serializeSession(session) });
  });

  app.post(
    "/api/screen-feed/control/sessions/:sessionId/mouse-authorization",
    requireAuth,
    mousePermission,
    async (req, res) => {
      if (!requireController(req, res)) return;
      try {
        const authorization = authorizeRemoteMouseControl({
          sessionId: req.params.sessionId,
          controllerUserId: sessionUserId(req),
          passwordConfirmedAt: passwordConfirmedAt(req),
        });
        const session = getRemoteControlSession(req.params.sessionId);
        if (!session || session.companyId !== getSessionCompanyId(req)) {
          revokeRemoteMouseControl({ sessionId: req.params.sessionId, controllerUserId: sessionUserId(req) });
          return res.status(404).json({ message: "Support session not found." });
        }
        const audited = await writeAuditOrUnavailable(
          {
            event: "mouse_authorized",
            session,
            actorUserId: sessionUserId(req),
            actorUsername: sessionUsername(req),
            details: { capability: "mouse", status: "requested", route: session.targetRoute },
          },
          res
        );
        if (!audited) {
          revokeRemoteMouseControl({ sessionId: session.id, controllerUserId: sessionUserId(req) });
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.json({ authorization: serializeMouseAuthorization(authorization) });
      } catch (error) {
        handleSessionError(error, res);
      }
    }
  );

  app.post(
    "/api/screen-feed/control/sessions/:sessionId/mouse-authorization/revoke",
    requireAuth,
    mousePermission,
    async (req, res) => {
      if (!requireController(req, res)) return;
      try {
        const session = getRemoteControlSession(req.params.sessionId);
        if (!session || session.companyId !== getSessionCompanyId(req)) {
          return res.status(404).json({ message: "Support session not found." });
        }
        revokeRemoteMouseControl({ sessionId: session.id, controllerUserId: sessionUserId(req) });
        await writeRemoteSupportAudit({
          event: "mouse_revoked",
          session: getRemoteControlSession(session.id) ?? session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: { capability: "mouse", status: "requested", route: session.targetRoute },
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ authorization: null, session: serializeSession(getRemoteControlSession(session.id)) });
      } catch (error) {
        handleSessionError(error, res);
      }
    }
  );

  app.get("/api/screen-feed/control/commands", requireLogin, (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const tabId = typeof req.query.tabId === "string" ? req.query.tabId : "";
    if (!sessionId || !tabId) {
      return res.status(400).json({ message: "A support session and browser tab are required." });
    }
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeRemoteMouseCommands({
        sessionId,
        targetUserId: sessionUserId(req),
        targetTabId: tabId,
        listener: (command) => writeEvent(res, "command", serializeMouseCommand(command)),
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
    writeEvent(res, "ready", { sessionId, tabId });
  });

  app.post("/api/screen-feed/control/sessions/:sessionId/commands", requireAuth, mousePermission, async (req, res) => {
    if (!requireController(req, res)) return;
    try {
      const session = getRemoteControlSession(req.params.sessionId);
      if (!session || session.companyId !== getSessionCompanyId(req)) {
        return res.status(404).json({ message: "Support session not found." });
      }
      const type = req.body?.type;
      if (
        (type !== "pointer-move" && type !== "click" && type !== "scroll") ||
        !isRemoteMouseCommandAllowedOnRoute(session.targetRoute, type)
      ) {
        // A refusal is rare and terminal for this command, so it is still
        // worth a synchronous, guaranteed record.
        await writeRemoteSupportAudit({
          event: "command_blocked",
          session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: {
            capability: "mouse",
            commandType: typeof type === "string" ? type : "invalid",
            status: "denied",
            reason: "sensitive-route",
            route: session.targetRoute,
          },
        });
        return res.status(403).json({
          code: "SENSITIVE_REMOTE_ACTION_BLOCKED",
          message: "Mouse clicks are blocked on this sensitive ERP route.",
        });
      }

      // Phase 10: decide admission before any audit or publication work. Rate
      // limiting used to run at the end of publication, after an audit row had
      // already been written for a command that was then thrown away.
      assertRemoteMouseCommandAdmission({
        sessionId: session.id,
        controllerUserId: sessionUserId(req),
        type,
      });

      // Auditing is enqueued rather than awaited, but it still fails closed:
      // when the queue cannot promise the row, the command is refused here
      // instead of shipping unaudited control.
      if (!isRemoteSupportCommandAuditAccepting()) return respondAuditUnavailable(res);
      const accepted = enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        actorUserId: sessionUserId(req),
        actorUsername: sessionUsername(req),
        details: remoteSupportCommandAuditDetails({
          capability: "mouse",
          commandType: type,
          route: session.targetRoute,
        }),
      });
      if (!accepted) return respondAuditUnavailable(res);

      const { command, supersededCommandIds } = publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: sessionUserId(req),
        type,
        x: req.body?.x,
        y: req.body?.y,
        deltaX: req.body?.deltaX,
        deltaY: req.body?.deltaY,
        frameViewport: req.body?.frameViewport,
        admitted: true,
      });
      res.status(202).json({ command: serializeMouseCommand(command), supersededCommandIds });
    } catch (error) {
      handleSessionError(error, res);
    }
  });

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
