import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const playwrightPath = process.argv[2] ??
  createRequire(import.meta.url).resolve("playwright", {
    paths: (process.env.PATH ?? "").split(delimiter).map((bin) =>
      resolve(bin, "..")
    ),
  });

const playwright = await import(pathToFileURL(playwrightPath).href);
const { chromium } = playwright.default ?? playwright;

const server = spawn("mise", [
  "x",
  "--",
  "deno",
  "run",
  "--allow-read",
  "--allow-net=127.0.0.1",
  "test/fixtures/dashboard.ts",
], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: ["ignore", "pipe", "pipe"],
});

const exited = once(server, "exit");
let browser;

try {
  const base = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Server startup timed out: ${output}`)),
      30000,
    );
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DASHBOARD_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}: ${output}`));
    });
  });
  for (
    const path of [
      "/dashboard",
      "/dashboard/styles.css",
      "/dashboard/client.js",
      "/api/v1/metrics",
    ]
  ) {
    assert.equal((await fetch(base + path)).status, 401);
  }
  browser = await chromium.launch();
  const credentials = {
    username: "viewer",
    password: "browser-fixture-password",
  };
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    httpCredentials: credentials,
  });
  const fallback = await noJs.newPage();
  await fallback.goto(base + "/dashboard");
  assert.equal(await fallback.locator(".session").count(), 3);
  assert.equal(
    await fallback.locator(".metric-value").first().textContent(),
    "248",
  );
  assert.match(
    await fallback.locator("#refresh-status").textContent(),
    /Manual refresh/,
  );
  assert.equal(
    await fallback.locator("#refresh").getAttribute("href"),
    "/dashboard",
  );
  await noJs.close();
  const context = await browser.newContext({ httpCredentials: credentials });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(base + "/dashboard");
  await page.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.startsWith("Live")
  );
  const initial = await (await context.request.get(base + "/api/v1/metrics"))
    .json();
  let snapshot = structuredClone(initial);
  let mode = "ok";
  let calls = 0;
  let release;
  await page.route("**/api/v1/metrics", async (route) => {
    calls++;
    if (mode === "hold") {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    await route.fulfill({
      status: mode === "error" ? 503 : mode === "unauthorized" ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        mode === "error" ? { error: "unavailable" } : snapshot,
      ),
    });
  });
  snapshot.issues.assignedToDevin = 37;
  snapshot.usage.total = 150;
  snapshot.generatedAt = "2026-09-14T10:43:00.000Z";
  snapshot.activeSessions = [snapshot.activeSessions[0]];
  snapshot.activeSessions[0].issue.title = '<img src=x onerror="alert(1)">';
  snapshot.activeSessions[0].url = "javascript:alert(1)";
  snapshot.activeSessionCount = 1;
  await page.clock.runFor(30_001);
  await page.waitForFunction(() =>
    document.querySelectorAll(".metric-value")[1].textContent === "37"
  );
  assert.equal(calls, 1);
  assert.equal(await page.locator(".session").count(), 1);
  assert.equal(await page.locator(".session img, .session script").count(), 0);
  assert.equal(
    await page.locator('.session a[href^="javascript:"]').count(),
    0,
  );
  assert.match(await page.locator(".session h4").textContent(), /<img/);
  assert.equal(
    await page.locator("#snapshot-time").textContent(),
    snapshot.generatedAt,
  );
  await page.locator("summary").click();
  const lastSnapshotTime = await page.locator("#snapshot-time").textContent();
  mode = "error";
  await page.clock.runFor(30_001);
  await page.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.includes(
      "Couldn’t refresh",
    )
  );
  assert.equal(
    await page.locator("#snapshot-time").textContent(),
    lastSnapshotTime,
  );
  assert.equal(await page.locator("details").getAttribute("open"), "");
  assert.equal(await page.locator(".metric-value").nth(1).textContent(), "37");
  mode = "hold";
  await page.locator("#refresh").click();
  await page.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent === "Refreshing…"
  );
  const heldCount = calls;
  await page.locator("#refresh").click();
  await page.clock.runFor(10_000);
  assert.equal(calls, heldCount, "in-flight requests must not overlap");
  mode = "ok";
  release();
  await page.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.startsWith("Live")
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCount = calls;
  await page.clock.runFor(120_000);
  assert.equal(calls, hiddenCount, "hidden tabs must not poll");
  snapshot.activeSessions = [];
  snapshot.activeSessionCount = 0;
  snapshot.github.status = "partial";
  snapshot.issues.repositoryTotal = null;
  snapshot.pullRequests.merged = null;
  snapshot.pullRequests.unknownMergeState = 2;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() =>
    document.querySelector(".metric-value").textContent === "—"
  );
  assert.equal(calls, hiddenCount + 1);
  assert.equal(await page.locator("#empty-sessions").isVisible(), true);
  assert.equal(await page.locator("#github-notice").isVisible(), true);
  assert.equal(await page.locator(".session").count(), 0);
  snapshot = structuredClone(initial);
  snapshot.activeSessions[0].acus = 4.5;
  await page.locator("#refresh").click();
  await page.waitForFunction(() =>
    document.querySelectorAll(".session").length === 3
  );
  const focused = page.locator('.session[data-session-id="demo-1"] h4 a');
  await focused.focus();
  snapshot.activeSessions[0].acus = 5;
  await page.clock.runFor(30_001);
  await page.waitForFunction(() =>
    document.querySelector(".session dl").textContent.includes("5 ACUs")
  );
  assert.equal(
    await focused.evaluate((element) => element === document.activeElement),
    true,
  );
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.scrollWidth > innerWidth
      ),
      false,
      `overflow at ${width}`,
    );
  }
  mode = "unauthorized";
  await page.locator("#refresh").click();
  await page.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.includes(
      "Login expired",
    )
  );
  const unauthorizedCount = calls;
  await page.clock.runFor(120_000);
  assert.equal(
    calls,
    unauthorizedCount,
    "expired authentication must stop polling",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: live HTTP auth, SSR without JavaScript, automatic/manual refresh, safe DOM updates, stale/partial/empty states, no overlapping requests, hidden-tab pause/resume, focus/details preservation, mobile layout, and expired-login handling.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await exited;
}
