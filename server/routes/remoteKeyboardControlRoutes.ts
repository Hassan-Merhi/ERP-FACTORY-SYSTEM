import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getSessionCompanyId } from "../lib/requestContext";
import {
  assertRemoteKeyboardCommandAdmission,
  authorizeRemoteKeyboardControl,
  publishRemoteKeyboardCommand,
  publishRemoteKeyboardCommandResult,
  revokeRemoteKeyboardControl,
  subscribeRemoteKeyboardCommands,
  subscribeRemoteKeyboardResults,
  type RemoteKeyboardCommandResult,
} from "../services/remoteKeyboardCommandService";
import { getRemoteControlSession } from "../services/remoteControlSessionService";
import { remoteSupportCommandAuditDetails, writeRemoteSupportAudit } from "../services/remoteSupportAuditService";
import {
  enqueueRemoteSupportCommandAudit,
  isRemoteSupportCommandAuditAccepting,
} from "../services/remoteSupportCommandAuditQueue";
import { isRemoteKeyboardAllowedOnRoute } from "../services/remoteSupportSensitiveActionPolicy";
import {
  STREAM_HEARTBEAT_MS,
  sessionUserId,
  sessionUsername,
  passwordConfirmedAt,
  requireController,
  openEventStream,
  writeEvent,
  writeHeartbeat,
  serializeAuthorization,
  serializeCommand,
  handleError,
  respondAuditUnavailable,
  auditOrBlock,
} from "./remoteKeyboardControlRoutesHelpers";

const keyboardPermission = requireActionAccess("remote_support_keyboard");

function serializeResult(result: RemoteKeyboardCommandResult) {
  return { ...result, completedAt: new Date(result.completedAt).toISOString() };
}

export function registerRemoteKeyboardControlRoutes(app: Express): void {
  app.post(
    "/api/screen-feed/control/sessions/:sessionId/keyboard-authorization",
    requireAuth,
    keyboardPermission,
    async (req, res) => {
      if (!requireController(req, res)) return;
      try {
        const authorization = authorizeRemoteKeyboardControl({
          sessionId: req.params.sessionId,
          controllerUserId: sessionUserId(req),
          passwordConfirmedAt: passwordConfirmedAt(req),
        });
        const session = getRemoteControlSession(req.params.sessionId);
        if (!session || session.companyId !== getSessionCompanyId(req)) {
          revokeRemoteKeyboardControl({ sessionId: req.params.sessionId, controllerUserId: sessionUserId(req) });
          return res.status(404).json({ message: "Support session not found." });
        }
        const audited = await auditOrBlock(
          {
            event: "keyboard_authorized",
            session,
            actorUserId: sessionUserId(req),
            actorUsername: sessionUsername(req),
            details: { capability: "keyboard", status: "requested", route: session.targetRoute },
          },
          res
        );
        if (!audited) {
          revokeRemoteKeyboardControl({ sessionId: session.id, controllerUserId: sessionUserId(req) });
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.json({ authorization: serializeAuthorization(authorization) });
      } catch (error) {
        handleError(error, res);
      }
    }
  );

  app.post(
    "/api/screen-feed/control/sessions/:sessionId/keyboard-authorization/revoke",
    requireAuth,
    keyboardPermission,
    async (req, res) => {
      if (!requireController(req, res)) return;
      try {
        const session = getRemoteControlSession(req.params.sessionId);
        if (!session || session.companyId !== getSessionCompanyId(req)) {
          return res.status(404).json({ message: "Support session not found." });
        }
        revokeRemoteKeyboardControl({ sessionId: session.id, controllerUserId: sessionUserId(req) });
        await writeRemoteSupportAudit({
          event: "keyboard_revoked",
          session: getRemoteControlSession(session.id) ?? session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: { capability: "keyboard", status: "requested", route: session.targetRoute },
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ authorization: null });
      } catch (error) {
        handleError(error, res);
      }
    }
  );

  app.get("/api/screen-feed/control/keyboard-commands", requireLogin, (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const tabId = typeof req.query.tabId === "string" ? req.query.tabId : "";
    if (!sessionId || !tabId) {
      return res.status(400).json({ message: "A support session and browser tab are required." });
    }
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeRemoteKeyboardCommands({
        sessionId,
        targetUserId: sessionUserId(req),
        targetTabId: tabId,
        listener: (command) => writeEvent(res, "command", serializeCommand(command)),
      });
    } catch (error) {
      return handleError(error, res);
    }
    openEventStream(res);
    let closed = false;
    const heartbeatId = setInterval(() => writeHeartbeat(res), STREAM_HEARTBEAT_MS);
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

  app.post(
    "/api/screen-feed/control/sessions/:sessionId/keyboard-commands",
    requireAuth,
    keyboardPermission,
    async (req, res) => {
      if (!requireController(req, res)) return;
      try {
        const session = getRemoteControlSession(req.params.sessionId);
        if (!session || session.companyId !== getSessionCompanyId(req)) {
          return res.status(404).json({ message: "Support session not found." });
        }
        if (!isRemoteKeyboardAllowedOnRoute(session.targetRoute)) {
          await writeRemoteSupportAudit({
            event: "command_blocked",
            session,
            actorUserId: sessionUserId(req),
            actorUsername: sessionUsername(req),
            details: {
              capability: "keyboard",
              commandType: typeof req.body?.type === "string" ? req.body.type : "invalid",
              status: "denied",
              reason: "sensitive-route",
              route: session.targetRoute,
            },
          });
          return res.status(403).json({
            code: "SENSITIVE_REMOTE_ACTION_BLOCKED",
            message: "Keyboard control is blocked on this sensitive ERP route.",
          });
        }
        // Phase 10: admission first. Rate, authorization, and target-channel
        // refusals used to happen inside publication, after an audit row had
        // already been written for a keystroke that was then discarded.
        assertRemoteKeyboardCommandAdmission({
          sessionId: session.id,
          controllerUserId: sessionUserId(req),
        });

        if (!isRemoteSupportCommandAuditAccepting()) return respondAuditUnavailable(res);
        const accepted = enqueueRemoteSupportCommandAudit({
          event: "keyboard_command",
          session,
          actorUserId: sessionUserId(req),
          actorUsername: sessionUsername(req),
          details: remoteSupportCommandAuditDetails({
            capability: "keyboard",
            commandType: typeof req.body?.type === "string" ? req.body.type : "invalid",
            key: typeof req.body?.key === "string" ? req.body.key : undefined,
            text: typeof req.body?.text === "string" ? req.body.text : undefined,
            route: session.targetRoute,
          }),
        });
        if (!accepted) return respondAuditUnavailable(res);

        const command = publishRemoteKeyboardCommand({
          sessionId: session.id,
          controllerUserId: sessionUserId(req),
          type: req.body?.type,
          text: req.body?.text,
          key: req.body?.key,
          shiftKey: req.body?.shiftKey,
          admitted: true,
        });
        res.status(202).json({ command: serializeCommand(command) });
      } catch (error) {
        handleError(error, res);
      }
    }
  );

  app.get(
    "/api/screen-feed/control/sessions/:sessionId/keyboard-results",
    requireAuth,
    keyboardPermission,
    (req, res) => {
      if (!requireController(req, res)) return;
      let unsubscribe = () => {};
      try {
        unsubscribe = subscribeRemoteKeyboardResults({
          sessionId: req.params.sessionId,
          controllerUserId: sessionUserId(req),
          listener: (result) => writeEvent(res, "result", serializeResult(result)),
        });
      } catch (error) {
        return handleError(error, res);
      }
      openEventStream(res);
      let closed = false;
      const heartbeatId = setInterval(() => writeHeartbeat(res), STREAM_HEARTBEAT_MS);
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
    }
  );

  app.post(
    "/api/screen-feed/control/sessions/:sessionId/keyboard-commands/:commandId/result",
    requireLogin,
    (req, res) => {
      try {
        const result = publishRemoteKeyboardCommandResult({
          sessionId: req.params.sessionId,
          commandId: req.params.commandId,
          targetUserId: sessionUserId(req),
          targetTabId: req.body?.tabId,
          status: req.body?.status,
          reason: req.body?.reason,
        });
        const session = getRemoteControlSession(req.params.sessionId);
        if (session) {
          // One acknowledgement per keystroke: batched for the same reason the
          // mouse acknowledgement path is.
          enqueueRemoteSupportCommandAudit({
            event: result.status === "blocked" ? "command_blocked" : "keyboard_result",
            session,
            actorUserId: sessionUserId(req),
            actorUsername: sessionUsername(req),
            details: {
              capability: "keyboard",
              status: result.status,
              reason: result.reason,
              route: session.targetRoute,
            },
          });
        }
        res.setHeader("Cache-Control", "no-store");
        res.json({ result: serializeResult(result) });
      } catch (error) {
        handleError(error, res);
      }
    }
  );
}
