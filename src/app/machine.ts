import { Kernel } from "../kernel/kernel";
import { Compiler } from "../compiler/compiler";
import { Vision } from "../vision/vision";
import { Shell } from "../terminal/shell";
import { SnapshotStore } from "../fs/filesystem";
import { seed } from "../data/seed";
export const kernel = new Kernel();
seed(kernel);
export const compiler = new Compiler(kernel),
  vision = new Vision(kernel),
  store = new SnapshotStore();
export let persistence = "Restoring workspace";
let resetPending = false;
let saveTimer: ReturnType<typeof setTimeout>;
export const shell = new Shell(kernel, compiler, vision, async () => {
  resetPending = true;
  clearTimeout(saveTimer);
  await store.clear();
  persistence = "Workspace reset; reload to initialize";
  kernel.notify();
});
export const ready = (async () => {
  try {
    const snapshot = await store.load();
    if (snapshot) {
      kernel.fs.restore(snapshot);
      kernel.proc();
    }
    persistence = "Workspace saved locally";
  } catch (e) {
    persistence = "Persistence unavailable · session memory only";
    kernel.trace(
      1,
      "storage",
      "snapshot.restore",
      "IndexedDB",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!kernel.fs.exists("/home/visitor/sample-hello")) {
    try {
      const response = await fetch(
        import.meta.env.BASE_URL + "examples/sample-hello.wasm",
      );
      if (!response.ok) throw Error("HTTP " + response.status);
      kernel.fs.write(
        "/home/visitor/sample-hello",
        new Uint8Array(await response.arrayBuffer()),
      );
      kernel.trace(
        1,
        "kernel",
        "sample.mount",
        "prebuilt real WASI guest",
        "ready",
      );
    } catch (e) {
      kernel.trace(
        1,
        "kernel",
        "sample.mount",
        "prebuilt WASI guest",
        String(e),
      );
    }
  }
  const prior = kernel.fs.onChange;
  kernel.fs.onChange = () => {
    prior();
    if (resetPending) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store
        .save(kernel.fs.snapshot())
        .then(() => {
          persistence = "Workspace saved locally";
          kernel.notify();
        })
        .catch(() => {
          persistence = "Storage write failed";
          kernel.notify();
        });
    }, 200);
  };
  kernel.notify();
})();

// Deliberately inspectable browser console API; no credentials or privileged host objects.
declare global {
  interface Window {
    diorama: {
      kernel: Kernel;
      compiler: Compiler;
      vision: Vision;
      shell: Shell;
      ready: Promise<void>;
    };
  }
}
window.diorama = { kernel, compiler, vision, shell, ready };
kernel.telemetry.start();
