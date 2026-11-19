// Extracted from ./remoteControlSessionRoutes.ts
import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { getSessionCompanyId } from "../lib/requestContext";
import {
  assertRemoteMouseCommandAdmission,
  authorizeRemoteMouseControl,
  publishRemoteMouseCommand,
  revokeRemoteMouseControl,
  subscribeRemoteMouseCommands,
} from "../services/remoteControlCommandService";
import {
  getActiveRemoteControlSession,
  getRemoteControlSession,
  heartbeatRemoteControlController,
  startRemoteControlSession,
  stopRemoteControlSession,
} from "../services/remoteControlSessionService";
import { remoteSupportCommandAuditDetails, writeRemoteSupportAudit } from "../services/remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "../services/remoteSupportCommandAuditQueue";
import { isRemoteMouseCommandAllowedOnRoute } from "../services/remoteSupportSensitiveActionPolicy";
import {
  COMMAND_HEARTBEAT_MS,
  viewPermission,
  mousePermission,
  sessionUserId,
  sessionUsername,
  sessionRole,
  passwordConfirmedAt,
  requireController,
  serializeSession,
  serializeMouseAuthorization,
  serializeMouseCommand,
  openEventStream,
  writeEvent,
  writeHeartbeat,
  handleSessionError,
  respondAuditUnavailable,
  writeAuditOrUnavailable,
} from "./remoteControlSessionHelpers";

export function registerRemoteControlSessionRoutesPart1(app: Express) {
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
}
