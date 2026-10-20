import { test, expect } from "@playwright/test";
test("execution paths follow real commands, replay recorded events, and export live samples", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  await expect(page.locator(".execution-rail")).toContainText(
    "Waiting for your first command",
  );
  await page.evaluate(() => window.diorama.shell.execute("./sample-hello"));
  await expect(page.locator(".execution-rail")).toContainText("WASI");
  await page.evaluate(async () => {
    const s = window.diorama.shell;
    await s.execute('echo "real file" > observatory.txt');
    await s.execute("cat observatory.txt | wc -w");
  });
  await page.getByRole("tab", { name: "Kernel", exact: true }).click();
  const explorer = page.getByRole("region", { name: "Execution observatory" });
  await expect(explorer).toContainText("cat observatory.txt | wc -w");
  await expect(explorer.locator(".obs-time-row")).toHaveCount(2);
  await expect(explorer.locator(".obs-layer-path")).toContainText(
    "Virtual filesystem",
  );
  await expect(explorer.locator(".obs-layer-path")).not.toContainText(
    "Clang / LLD",
  );
  await page
    .getByRole("button", { name: "Replay execution", exact: true })
    .click();
  await expect(explorer).toContainText("RECORDED REPLAY");
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await page
    .getByRole("slider", { name: "Execution replay position" })
    .fill("0");
  await expect(explorer.locator(".obs-event-detail")).toContainText(
    "task.spawn",
  );
  await page.getByRole("button", { name: "Live follow", exact: true }).click();
  await expect(explorer).toContainText("LIVE FOLLOW");
  const runId = await page.evaluate(
    () =>
      window.diorama.kernel.telemetry.commands.find(
        (r) => r.label === "./sample-hello",
      )!.id,
  );
  await page.getByLabel("Observed execution").selectOption(runId);
  await expect(explorer.locator(".obs-layer-path")).toContainText("WASI");
  await expect(explorer.locator(".obs-time-row")).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => window.diorama.kernel.telemetry.samples.length),
    )
    .toBeGreaterThan(2);
  await page.getByRole("button", { name: "Pause charts", exact: true }).click();
  const count = await page.evaluate(
    () => window.diorama.kernel.telemetry.samples.length,
  );
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => window.diorama.kernel.telemetry.samples.length),
  ).toBe(count);
  await page
    .getByRole("button", { name: "Resume charts", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.diorama.kernel.telemetry.samples.length),
    )
    .toBeGreaterThan(count);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export JSON ↗", exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let body = "";
  for await (const chunk of stream!) body += chunk.toString();
  const report = JSON.parse(body);
  expect(report.samples.length).toBeGreaterThan(2);
  expect(
    report.commands.some(
      (r: { label: string }) => r.label === "./sample-hello",
    ),
  ).toBe(true);
  expect(report.events.some((e: { layer: string }) => e.layer === "WASI")).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
