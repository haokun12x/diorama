// A small C ABI bridge. Files, tasks, descriptors, events, and snapshots are owned by Rust.
import { NativeKernel as KernelBridge } from "./runtime";
const url = new URL("./native/core.wasm", import.meta.url);
let binary: Uint8Array;
if (import.meta.env.MODE === "test") {
  const { readFile } = await import("node:fs/promises");
  binary = await readFile(url);
} else {
  const response = await fetch(url);
  if (!response.ok) throw Error(`WASM kernel: HTTP ${response.status}`);
  binary = new Uint8Array(await response.arrayBuffer());
}
export const kernelModule = await WebAssembly.compile(
  binary as Uint8Array<ArrayBuffer>,
);
export class NativeKernel extends KernelBridge {
  constructor(module = kernelModule) {
    super(module);
  }
}
