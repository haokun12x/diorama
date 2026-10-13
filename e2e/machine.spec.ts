import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("Rust/WASM kernel and native WASI services execute actual C system operations", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  const proof = await page.evaluate(
    async (source) => {
      const { kernel, shell } = window.diorama;
      kernel.fs.write("/home/visitor/native-probe.c", source);
      const build = await shell.execute("cc native-probe.c -o native-probe");
      await shell.execute("export PROBE=native");
      const run = await shell.execute("./native-probe proof");
      return {
        build,
        run,
        file: kernel.fs.text("/home/visitor/system-probe/data"),
        info: kernel.core.info(),
        proc: JSON.parse(kernel.fs.text("/proc/runtime")),
        calls: kernel.events
          .filter((e) => e.layer === "WASI")
          .map((e) => [e.op, e.result]),
      };
    },
    await readFile(
      new URL("../src/data/system-probe.c", import.meta.url),
      "utf8",
    ),
  );
  expect(proof.build.code).toBe(0);
  expect(proof.run.code).toBe(0);
  expect(proof.file).toBe("aZc");
  expect(proof.info).toMatchObject({
    language: "Rust",
    execution: "WebAssembly",
    abi: 1,
  });
  expect(proof.proc.kernelExecution).toBe("WebAssembly");
  for (const op of [
    "fd_pwrite",
    "fd_seek",
    "fd_read",
    "fd_filestat_set_size",
    "fd_readdir",
    "random_get",
    "clock_time_get",
  ])
    expect(proof.calls).toContainEqual([op, "0"]);
  expect(proof.calls).toContainEqual(["path_open", "63"]);
  expect(proof.calls).toContainEqual(["path_rename", "58"]);
  console.log("RUST_WASM_PROOF", JSON.stringify(proof));
});
test("production navigation, terminal, persistence, and narrow layout", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "An Entire Computer",
  );
  await page.getByRole("button", { name: "Explore the System" }).click();
  const r = await page.evaluate(() =>
    window.diorama.shell.execute('echo "persistent bytes" > note.txt'),
  );
  expect(r.code).toBe(0);
  await page.waitForTimeout(350);
  await page.reload();
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  expect(
    await page.evaluate(() =>
      window.diorama.kernel.fs.text("/home/visitor/note.txt"),
    ),
  ).toBe("persistent bytes\n");
  await page.getByRole("tab", { name: "Kernel" }).click();
  await expect(page.getByText("Runtime-managed tasks")).toBeVisible();
  await page.getByRole("tab", { name: "Projects" }).click();
  await expect(
    page.getByRole("heading", { name: "WaveFill", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Terminal" }).click();
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("echo keyboard-ok");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.diorama.shell.history.at(-1))).toBe(
    "echo keyboard-ok",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Vision Lab" }).click();
  await expect(
    page.getByRole("button", { name: "Detect objects" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  for (const tab of [
    "Terminal",
    "Kernel",
    "Compiler",
    "Vision Lab",
    "Projects",
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.locator(".view-loading:visible")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      tab + " fits the mobile viewport",
    ).toBe(true);
  }
});
test("genuine local Clang compilation, WASI I/O, diagnostics, exits, and interruption", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  const proof = await page.evaluate(async () => {
    const { shell, kernel, compiler } = window.diorama;
    const source = kernel.fs.text("/home/visitor/hello.c");
    const build = await shell.execute("cc hello.c -o hello");
    const bytes = kernel.fs.read("/home/visitor/hello");
    const run = await shell.execute("./hello");
    const files = await shell.execute("cc files.c -o files");
    const io = await shell.execute("./files");
    kernel.fs.write("/home/visitor/exit.c", "int main(void) { return 7; }");
    await shell.execute("cc exit.c -o exit");
    const exit = await shell.execute("./exit");
    kernel.fs.write("/home/visitor/bad.c", "int main( { ???");
    const bad = await shell.execute("cc bad.c -o bad");
    kernel.fs.write(
      "/home/visitor/loop.c",
      "int main(void){volatile int i=0;for(;;)i++;}",
    );
    await shell.execute("cc loop.c -O0 -o loop");
    const hanging = shell.execute("./loop");
    await new Promise((r) => setTimeout(r, 200));
    shell.cancel();
    const cancelled = await hanging;
    return {
      source,
      build,
      magic: [...bytes.slice(0, 4)],
      run,
      files,
      io,
      guestFile: kernel.fs.text("/tmp/guest-note.txt"),
      exit,
      bad,
      cancelled,
      trace: kernel.events.some(
        (e) => e.layer === "WASI" && e.op === "fd_write",
      ),
      memory: compiler.memoryBytes,
      isolated: crossOriginIsolated,
    };
  });
  expect(proof.source).toContain("#include");
  expect(proof.build.code).toBe(0);
  expect(proof.magic).toEqual([0, 97, 115, 109]);
  expect(proof.run.stdout).toContain("Hello from inside the browser.");
  expect(proof.files.code).toBe(0);
  expect(proof.io.code).toBe(0);
  expect(proof.guestFile).toContain("Written by a WASI guest");
  expect(proof.exit.code).toBe(7);
  expect(proof.bad.code).toBe(1);
  expect(proof.bad.stderr).toContain("error:");
  expect(proof.cancelled.code).toBe(130);
  expect(proof.trace).toBe(true);
  expect(proof.memory).toBeGreaterThan(0);
  expect(proof.isolated).toBe(false);
  await page.evaluate(() =>
    window.diorama.kernel.fs.write(
      "/home/visitor/stdin-test.c",
      '#include <stdio.h>\nint main(void){char b[100];while(fgets(b,100,stdin))printf("%s",b);}',
    ),
  );
  expect(
    await page.evaluate(async () => {
      await window.diorama.shell.execute("cc stdin-test.c -o stdin-test");
      return (
        await window.diorama.shell.execute(
          "echo pipe-through-wasi | ./stdin-test",
        )
      ).stdout;
    }),
  ).toBe("pipe-through-wasi\n");
  const nested = await page.evaluate(async () => {
    const { kernel, shell } = window.diorama;
    kernel.fs.mkdir("/home/visitor/nested", true);
    kernel.fs.write("/home/visitor/nested/value.h", "#define ANSWER 42\n");
    kernel.fs.write(
      "/home/visitor/nested/main.c",
      '#include <stdio.h>\n#include "value.h"\nint main(void){puts("relative header works");FILE*f=fopen("relative.txt","w");if(!f)return 1;fprintf(f,"%d",ANSWER);fclose(f);return 0;}',
    );
    const build = await shell.execute("cc nested/main.c -o nested/program");
    const run = await shell.execute("./nested/program");
    return { build, run, file: kernel.fs.text("/home/visitor/relative.txt") };
  });
  expect(nested.build.code).toBe(0);
  expect(nested.run.code).toBe(0);
  expect(nested.file).toBe("42");
  console.log("COMPILER_PROOF", JSON.stringify(proof));
});
test("actual YOLO26 CPU predictions, masks, filesystem results and permission failure", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  await page.evaluate(() => {
    window.diorama.vision.preferredDevice = "cpu";
  });
  const r = await page.evaluate(async () => {
    const { vision, kernel } = window.diorama;
    const detect = await vision.inferPath("/samples/street.jpg");
    const segment = await vision.inferPath("/samples/street.jpg", true);
    return {
      device: vision.device,
      boxes: detect.boxes,
      width: detect.width,
      height: detect.height,
      speed: detect.speed,
      masks: segment.masks.length,
      png: [...kernel.fs.read("/tmp/vision/mask.png").slice(0, 8)],
      stored: JSON.parse(kernel.fs.text("/tmp/vision/detections.json")),
      segStored: JSON.parse(kernel.fs.text("/tmp/vision/segments.json")),
      isolated: crossOriginIsolated,
    };
  });
  expect(r.device).toBe("cpu");
  expect(r.boxes.length).toBeGreaterThan(0);
  expect(r.boxes.some((b) => b.name === "person")).toBe(true);
  expect(r.speed.inference).toBeGreaterThan(0);
  expect(r.masks).toBe(r.width * r.height * 4);
  expect(r.png).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(r.stored.boxes).toEqual(r.boxes);
  expect(r.segStored.model).toBe("yolo26n-seg");
  expect(r.isolated).toBe(false);
  for (const b of r.boxes) {
    expect(b.x1).toBeGreaterThanOrEqual(-1);
    expect(b.x2).toBeLessThanOrEqual(r.width + 1);
    expect(b.conf).toBeGreaterThanOrEqual(0.25);
  }
  await page.getByRole("tab", { name: "Vision Lab" }).click();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.getByRole("button", { name: "Use camera" }).click();
  await expect(
    page.getByText(
      "Camera access was denied. Use a sample image or upload instead.",
    ),
  ).toBeVisible();
  console.log("VISION_PROOF", JSON.stringify(r));
});
test("model download failure gives a truthful retryable state", async ({
  page,
}) => {
  await page.route("**/models/yolo26n.onnx", (r) =>
    r.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  const failure = await page.evaluate(async () => {
    try {
      await window.diorama.vision.inferPath("/samples/street.jpg");
      return "";
    } catch (e) {
      return String(e);
    }
  });
  expect(failure).toContain("503");
  expect(await page.evaluate(() => window.diorama.vision.modelName)).toBe("");
});

test("WebGPU backend runs genuine YOLO26 inference when an adapter is available", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox", "--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(
      process.env.DIORAMA_URL || "http://127.0.0.1:4173/diorama/",
    );
    await page.waitForFunction(() => window.diorama?.ready);
    await page.evaluate(() => window.diorama.ready);
    const info = await page.evaluate(async () => {
      const gpu = (
        navigator as Navigator & {
          gpu?: {
            requestAdapter(): Promise<{
              info: {
                vendor: string;
                architecture: string;
                isFallbackAdapter: boolean;
              };
            } | null>;
          };
        }
      ).gpu;
      const a = await gpu?.requestAdapter();
      return a
        ? {
            vendor: a.info.vendor,
            architecture: a.info.architecture,
            isFallbackAdapter: a.info.isFallbackAdapter,
          }
        : null;
    });
    test.skip(!info, "No WebGPU adapter in this test environment");
    const proof = await page.evaluate(async () => {
      const v = window.diorama.vision;
      const r = await v.inferPath("/samples/street.jpg");
      return { device: v.device, count: r.boxes.length, speed: r.speed };
    });
    expect(proof.device).toBe("webgpu");
    expect(proof.count).toBeGreaterThan(0);
    expect(proof.speed.inference).toBeGreaterThan(0);
    console.log("WEBGPU_PROOF", JSON.stringify({ info, ...proof }));
  } finally {
    await browser.close();
  }
});

test("camera capture keeps one frame in flight and stops tracks with truthful persisted metadata", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(
      process.env.DIORAMA_URL || "http://127.0.0.1:4173/diorama/",
    );
    await page.waitForFunction(() => window.diorama?.ready);
    await page.evaluate(() => window.diorama.ready);
    await page.evaluate(() => {
      window.diorama.vision.preferredDevice = "cpu";
    });
    await page.getByRole("tab", { name: "Vision Lab", exact: true }).click();
    await page.getByRole("button", { name: "Use camera" }).click();
    await page.waitForFunction(() => window.diorama.vision.frames >= 2);
    await page.getByRole("button", { name: "Stop camera" }).click();
    await page.waitForFunction(() => !window.diorama.vision.busy);
    const proof = await page.evaluate(() => {
      const { vision, kernel } = window.diorama;
      const video = document.querySelector("video")!;
      return {
        frames: vision.frames,
        tracks: (video.srcObject as MediaStream)
          .getTracks()
          .map((t) => t.readyState),
        active: kernel.taskInfo().filter((t) => t.kind === "vision" && !t.ended)
          .length,
        frameMagic: [...kernel.fs.read("/tmp/camera-frame.png").slice(0, 8)],
        stored: JSON.parse(kernel.fs.text("/tmp/vision/detections.json")),
        source: vision.imageUrl.slice(0, 22),
      };
    });
    expect(proof.frames).toBeGreaterThanOrEqual(2);
    expect(proof.tracks).toEqual(["ended"]);
    expect(proof.active).toBe(0);
    expect(proof.frameMagic).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(proof.stored.model).toBe("yolo26n");
    expect(proof.stored.backend).toBe("cpu");
    expect(proof.stored.width).toBe(640);
    expect(proof.stored.height).toBe(480);
    console.log("CAMERA_PROOF", JSON.stringify(proof));
  } finally {
    await browser.close();
  }
});

test("all computer views expose accessible controls and readable contrast", async ({
  page,
}) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.goto("./");
  await page.waitForFunction(() => window.diorama?.ready);
  await page.evaluate(() => window.diorama.ready);
  for (const tab of [
    "Terminal",
    "Compiler",
    "Vision Lab",
    "Projects",
    "Kernel",
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.locator(".view-loading:visible")).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations, tab + " accessibility failures").toEqual([]);
  }
});
