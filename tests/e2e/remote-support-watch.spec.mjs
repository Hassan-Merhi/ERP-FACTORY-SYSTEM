import { test, expect } from "@playwright/test";

const baseURL = String(process.env.REMOTE_SUPPORT_E2E_BASE_URL || "").replace(/\/$/, "");
const controllerUsername = process.env.REMOTE_SUPPORT_E2E_CONTROLLER_USERNAME || "";
const controllerPassword = process.env.REMOTE_SUPPORT_E2E_CONTROLLER_PASSWORD || "";
const targetUsername = process.env.REMOTE_SUPPORT_E2E_TARGET_USERNAME || "";
const targetPassword = process.env.REMOTE_SUPPORT_E2E_TARGET_PASSWORD || "";
const targetPath = process.env.REMOTE_SUPPORT_E2E_TARGET_PATH || "/";
const maxFrameIntervalP95Ms = Number(process.env.REMOTE_SUPPORT_GATE_MAX_FRAME_INTERVAL_P95_MS || 2500);
const maxClientToViewerP95Ms = Number(process.env.REMOTE_SUPPORT_GATE_MAX_CLIENT_TO_VIEWER_P95_MS || 2500);
const minClickSuccessRate = Number(process.env.REMOTE_SUPPORT_GATE_MIN_CLICK_SUCCESS_RATE || 0.95);
const frameSamplesRequired = Number(process.env.REMOTE_SUPPORT_E2E_FRAME_SAMPLES || 6);

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

async function login(page, username, password) {
  const response = await page.request.post(`${baseURL}/api/auth/login`, {
    data: { username, password },
  });
  expect(response.ok(), `login for ${username}`).toBeTruthy();
  const me = await page.request.get(`${baseURL}/api/auth/me`);
  expect(me.ok(), `auth/me for ${username}`).toBeTruthy();
  return me.json();
}

async function runtime(page) {
  const response = await page.request.get(`${baseURL}/api/screen-feed/admin/runtime`);
  expect(response.ok(), "remote-support runtime metrics endpoint").toBeTruthy();
  return response.json();
}

async function auditTotal(page) {
  const response = await page.request.get(`${baseURL}/api/screen-feed/control/audit?limit=1&page=1`);
  expect(response.ok(), "remote-support permanent audit endpoint").toBeTruthy();
  const payload = await response.json();
  return Number(payload.total || 0);
}

async function collectFrameTimes(page, image, wanted, timeoutMs = 45_000) {
  const values = [];
  const deadline = Date.now() + timeoutMs;
  while (values.length < wanted && Date.now() < deadline) {
    const raw = await image.getAttribute("data-frame-captured-at");
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(parsed) && values[values.length - 1] !== parsed) values.push(parsed);
    await page.waitForTimeout(150);
  }
  expect(values.length, `expected ${wanted} distinct live frames`).toBeGreaterThanOrEqual(wanted);
  return values;
}

required("REMOTE_SUPPORT_E2E_BASE_URL", baseURL);
required("REMOTE_SUPPORT_E2E_CONTROLLER_USERNAME", controllerUsername);
required("REMOTE_SUPPORT_E2E_CONTROLLER_PASSWORD", controllerPassword);
required("REMOTE_SUPPORT_E2E_TARGET_USERNAME", targetUsername);
required("REMOTE_SUPPORT_E2E_TARGET_PASSWORD", targetPassword);

test.describe("remote support canary measurement", () => {
  test.setTimeout(120_000);

  test("watch feed p95, safe click success, and permanent audit evidence", async ({ browser }) => {
    const targetContext = await browser.newContext({ baseURL });
    const controllerContext = await browser.newContext({ baseURL });
    const targetPage = await targetContext.newPage();
    const controllerPage = await controllerContext.newPage();

    try {
      const targetMe = await login(targetPage, targetUsername, targetPassword);
      await login(controllerPage, controllerUsername, controllerPassword);
      const targetUserId = String(targetMe.id || "");
      expect(targetUserId).not.toBe("");

      await targetPage.goto(`${baseURL}${targetPath}`, { waitUntil: "domcontentloaded" });
      await targetPage.waitForLoadState("networkidle").catch(() => undefined);
      await targetPage.evaluate(() => {
        const state = window;
        state.__remoteSupportE2EClickCount = 0;
        const existing = document.getElementById("remote-support-e2e-click-target");
        existing?.remove();
        const button = document.createElement("button");
        button.id = "remote-support-e2e-click-target";
        button.type = "button";
        button.setAttribute("data-remote-control-action", "view");
        button.textContent = "Remote support E2E 0";
        Object.assign(button.style, {
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: "240px",
          height: "80px",
          zIndex: "2147483000",
          background: "white",
          color: "black",
          border: "2px solid black",
          fontSize: "16px",
        });
        button.addEventListener("click", () => {
          state.__remoteSupportE2EClickCount = Number(state.__remoteSupportE2EClickCount || 0) + 1;
          button.dataset.clicked = String(state.__remoteSupportE2EClickCount);
        });
        document.body.appendChild(button);
        state.__remoteSupportE2ETimer = window.setInterval(() => {
          button.textContent = `Remote support E2E ${Date.now()}`;
        }, 450);
      });

      // Wait for the target's normal presence hook to publish the active row.
      await controllerPage.goto(`${baseURL}/settings`, { waitUntil: "domcontentloaded" });
      await controllerPage.getByRole("button", { name: "Sessions & Users" }).click();
      const watchButton = controllerPage.getByTestId(`button-watch-${targetUserId}`);
      await expect(watchButton).toBeVisible({ timeout: 45_000 });

      const auditBefore = await auditTotal(controllerPage);
      await watchButton.click();
      const dialog = controllerPage.getByTestId("dialog-watch-user");
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      const image = controllerPage.getByTestId("img-screen-feed");
      await expect(image).toBeVisible({ timeout: 45_000 });

      const frameTimes = await collectFrameTimes(controllerPage, image, frameSamplesRequired);
      const localIntervals = frameTimes.slice(1).map((value, index) => value - frameTimes[index]);
      const localFrameP95 = p95(localIntervals);
      expect(localFrameP95).toBeLessThanOrEqual(maxFrameIntervalP95Ms);

      const beforeClickRuntime = await runtime(controllerPage);
      const sentBefore = Number(beforeClickRuntime.metrics?.clickCommandsSent || 0);
      const executedBefore = Number(beforeClickRuntime.metrics?.clickCommandsExecuted || 0);

      const enableMouse = controllerPage.getByTestId("button-enable-remote-mouse");
      await expect(enableMouse).toBeVisible({ timeout: 30_000 });
      await enableMouse.click();
      const passwordInput = controllerPage.getByTestId("input-remote-mouse-password");
      if (await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.fill(controllerPassword);
        await controllerPage.getByRole("button", { name: "Confirm", exact: true }).click();
      }
      await expect(controllerPage.getByTestId("button-disable-remote-mouse")).toBeVisible({ timeout: 30_000 });

      const box = await image.boundingBox();
      expect(box).not.toBeNull();
      await controllerPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect
        .poll(
          () => targetPage.evaluate(() => Number(window.__remoteSupportE2EClickCount || 0)),
          { timeout: 20_000, intervals: [250, 500, 1000] }
        )
        .toBeGreaterThan(0);

      // The click changes target state and the animated marker continues to
      // produce fresh frames, allowing command→visible correlation to close.
      await collectFrameTimes(controllerPage, image, 3, 20_000);

      let afterRuntime = await runtime(controllerPage);
      await expect
        .poll(
          async () => {
            afterRuntime = await runtime(controllerPage);
            return Number(afterRuntime.metrics?.clickCommandsExecuted || 0) - executedBefore;
          },
          { timeout: 20_000, intervals: [500, 1000] }
        )
        .toBeGreaterThanOrEqual(1);

      const sentDelta = Number(afterRuntime.metrics?.clickCommandsSent || 0) - sentBefore;
      const executedDelta = Number(afterRuntime.metrics?.clickCommandsExecuted || 0) - executedBefore;
      expect(sentDelta).toBeGreaterThanOrEqual(1);
      expect(executedDelta / sentDelta).toBeGreaterThanOrEqual(minClickSuccessRate);

      const latency = afterRuntime.metrics?.latency || {};
      expect(Number(latency.frameIntervalMs?.p95Ms || 0)).toBeLessThanOrEqual(maxFrameIntervalP95Ms);
      expect(Number(latency.clientToViewerMs?.p95Ms || 0)).toBeLessThanOrEqual(maxClientToViewerP95Ms);
      expect(Number(latency.commandSentToExecutedMs?.count || 0)).toBeGreaterThanOrEqual(1);
      expect(Number(latency.commandSentToVisibleFrameMs?.count || 0)).toBeGreaterThanOrEqual(1);

      await expect
        .poll(() => auditTotal(controllerPage), { timeout: 20_000, intervals: [500, 1000] })
        .toBeGreaterThan(auditBefore);
      const auditAfter = await auditTotal(controllerPage);

      console.log(
        JSON.stringify(
          {
            localFrameIntervalP95Ms: localFrameP95,
            runtimeFrameIntervalP95Ms: latency.frameIntervalMs?.p95Ms,
            runtimeClientToViewerP95Ms: latency.clientToViewerMs?.p95Ms,
            clickSentDelta: sentDelta,
            clickExecutedDelta: executedDelta,
            clickSuccessRateDelta: executedDelta / sentDelta,
            commandSentToExecutedP95Ms: latency.commandSentToExecutedMs?.p95Ms,
            commandSentToVisibleFrameP95Ms: latency.commandSentToVisibleFrameMs?.p95Ms,
            auditRowsAdded: auditAfter - auditBefore,
          },
          null,
          2
        )
      );
    } finally {
      await targetContext.close();
      await controllerContext.close();
    }
  });
});
