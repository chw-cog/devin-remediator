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
    "/dashboard?page=1",
  );
  assert.deepEqual(
    await fallback.locator(".usage .metric-name").allTextContents(),
    [
      "Provider-reported usage",
      "Average per session",
      "Median time until fix proposed",
      "Median time until merged",
    ],
  );
  assert.equal(
    await fallback.locator("#fix-proposed-timing .usage-value").textContent(),
    "23m 40s",
  );
  assert.equal(
    await fallback.locator("#merged-timing .usage-value").textContent(),
    "2h 0m",
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
  await page.route("**/api/v1/metrics?*", async (route) => {
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
  snapshot.timing.fixProposed.medianMilliseconds = 600000;
  snapshot.timing.fixProposed.sampleCount = 29;
  snapshot.timing.fixProposed.excludedSessions = 6;
  snapshot.timing.merged.medianMilliseconds = 3600000;
  snapshot.timing.merged.sampleCount = 19;
  snapshot.timing.merged.excludedSessions = 16;
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
  assert.equal(
    await page.locator("#fix-proposed-timing .usage-value").textContent(),
    "10m 0s",
  );
  assert.equal(
    await page.locator("#merged-timing .usage-value").textContent(),
    "1h 0m",
  );
  assert.match(
    await page.locator("#fix-proposed-timing p").textContent(),
    /29 samples/,
  );
  assert.match(
    await page.locator("#merged-timing p").textContent(),
    /19 samples/,
  );
  assert.equal(
    await page.locator("#excluded-proposed-samples").textContent(),
    "6",
  );
  assert.equal(
    await page.locator("#excluded-merged-samples").textContent(),
    "16",
  );
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
  snapshot.timing.merged.medianMilliseconds = null;
  snapshot.timing.merged.sampleCount = 0;
  snapshot.timing.merged.excludedSessions = 35;
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
  assert.equal(
    await page.locator("#fix-proposed-timing .usage-value").textContent(),
    "10m 0s",
  );
  assert.equal(
    await page.locator("#merged-timing .usage-value").textContent(),
    "—",
  );
  assert.match(
    await page.locator("#merged-timing p").textContent(),
    /0 samples/,
  );
  assert.equal(
    await page.locator("#excluded-merged-samples").textContent(),
    "35",
  );
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
    const proposed = await page.locator("#fix-proposed-timing").boundingBox();
    const merged = await page.locator("#merged-timing").boundingBox();
    if (width > 480) {
      assert.equal(proposed.y, merged.y);
      assert.ok(proposed.x < merged.x, `proposal must be left at ${width}`);
    } else {
      assert.ok(proposed.y < merged.y, "proposal must precede merge on mobile");
    }
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
  const pagination = await browser.newContext({ httpCredentials: credentials });
  const paged = await pagination.newPage();
  paged.on("pageerror", (error) => errors.push(error.message));
  await paged.clock.install();
  for (const count of [0, 1, 3, 4, 7]) {
    assert.equal(
      (await pagination.request.post(`${base}/__fixture/count/${count}`))
        .status(),
      204,
    );
    await paged.goto(`${base}/dashboard`);
    const pages = Math.max(1, Math.ceil(count / 3));
    const totals = await paged.locator(".metric-value").allTextContents();
    const ids = [];
    for (let number = 1; number <= pages; number++) {
      assert.equal(
        await paged.locator(".session").count(),
        Math.min(3, count - (number - 1) * 3),
      );
      assert.match(
        await paged.locator("#page-feedback").textContent(),
        new RegExp(`Page ${number} of ${pages}`),
      );
      assert.equal(
        await paged.locator("#previous-page").getAttribute("aria-disabled"),
        number === 1 ? "true" : null,
      );
      assert.equal(
        await paged.locator("#next-page").getAttribute("aria-disabled"),
        number === pages ? "true" : null,
      );
      ids.push(
        ...await paged.locator(".session").evaluateAll((cards) =>
          cards.map((card) => card.dataset.sessionId)
        ),
      );
      assert.deepEqual(
        await paged.locator(".metric-value").allTextContents(),
        totals,
      );
      for (const width of [320, 390, 768, 1440]) {
        await paged.setViewportSize({ width, height: 900 });
        assert.equal(
          await paged.evaluate(() =>
            document.documentElement.scrollWidth > innerWidth
          ),
          false,
          `count ${count}, page ${number}, width ${width}`,
        );
      }
      if (number < pages) await paged.locator("#next-page").click();
    }
    assert.deepEqual(
      ids,
      Array.from({ length: count }, (_, index) => `demo-${index + 1}`),
    );
    if (pages > 1) {
      await paged.locator("#previous-page").click();
      assert.match(
        await paged.locator("#page-feedback").textContent(),
        new RegExp(`Page ${pages - 1} of ${pages}`),
      );
    }
  }
  const noScriptPages = await browser.newContext({
    javaScriptEnabled: false,
    httpCredentials: credentials,
  });
  const fallbackPages = await noScriptPages.newPage();
  await fallbackPages.goto(`${base}/dashboard?page=2`);
  assert.equal(
    await fallbackPages.locator(".session").first().getAttribute(
      "data-session-id",
    ),
    "demo-4",
  );
  await fallbackPages.locator("#next-page").click();
  assert.equal(await fallbackPages.locator(".session").count(), 1);
  await fallbackPages.locator("#previous-page").click();
  await fallbackPages.locator("#refresh").click();
  assert.match(fallbackPages.url(), /page=2$/);
  await noScriptPages.close();
  await paged.goto(`${base}/dashboard?page=3`);
  await paged.locator("details").evaluate((details) => {
    details.open = true;
  });
  await paged.clock.runFor(30_001);
  await paged.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.startsWith("Live")
  );
  assert.match(paged.url(), /page=3$/);
  assert.equal(
    await paged.locator(".session").first().getAttribute("data-session-id"),
    "demo-7",
  );
  await pagination.request.post(`${base}/__fixture/count/1`);
  await paged.locator("#refresh").click();
  await paged.waitForFunction(() =>
    document.querySelector("#page-feedback").textContent.includes("Page 1 of 1")
  );
  assert.match(paged.url(), /page=1$/);
  assert.equal(await paged.locator("details").getAttribute("open"), "");
  assert.equal(await paged.locator("#next-page").getAttribute("href"), null);
  assert.equal(
    await paged.locator("#metrics-json").getAttribute("href"),
    "/api/v1/metrics?page=1",
  );
  const intact = await paged.locator("#page-feedback").textContent();
  await paged.route("**/api/v1/metrics?*", async (route) => {
    const invalid = structuredClone(initial);
    invalid.activePage = { number: 0, pageCount: 1, size: 3 };
    await route.fulfill({ json: invalid });
  });
  await paged.locator("#refresh").click();
  await paged.waitForFunction(() =>
    document.querySelector("#refresh-status").textContent.includes(
      "last successful snapshot",
    )
  );
  assert.equal(await paged.locator("#page-feedback").textContent(), intact);
  assert.equal(await paged.locator(".session").count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: live HTTP auth, 0/1/3/4/7 current sessions, page boundaries, no-JS previous/next/refresh, refresh retention and shrink clamping, invalid metadata rejection, unchanged global totals, milestone values/order/sample counts, automatic/manual refresh, safe DOM updates, stale/partial/empty states, no overlapping requests, hidden-tab pause/resume, focus/details preservation, 320px+ layout, and expired-login handling.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await exited;
}
