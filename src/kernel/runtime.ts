// Synchronous transport for the Rust kernel C ABI, shared with guest workers.
import type { TraceEvent } from "./kernel";
type Exports = {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  __data_end: WebAssembly.Global;
  kernel_abi_version: () => number;
  kernel_alloc: (size: number) => number;
  kernel_dealloc: (ptr: number, size: number) => void;
  kernel_call: (
    ptr: number,
    len: number,
    blobPtr: number,
    blobLen: number,
  ) => void;
  kernel_response_ptr: () => number;
  kernel_response_len: () => number;
  kernel_data_ptr: () => number;
  kernel_data_len: () => number;
};
const encode = new TextEncoder(),
  decode = new TextDecoder();
export class NativeKernel {
  instance: WebAssembly.Instance;
  exports: Exports;
  onEvents: (events: TraceEvent[]) => void = () => {};
  constructor(module: WebAssembly.Module) {
    this.instance = new WebAssembly.Instance(module, {
      diorama: {
        clock_ms: () => performance.now(),
        unix_ms: () => Date.now(),
        random_fill: (ptr: number, len: number) => {
          try {
            const bytes = new Uint8Array(this.exports.memory.buffer, ptr, len);
            for (let offset = 0; offset < len; offset += 65536)
              crypto.getRandomValues(
                bytes.subarray(offset, Math.min(len, offset + 65536)),
              );
            return 0;
          } catch {
            return 29;
          }
        },
      },
    });
    this.exports = this.instance.exports as unknown as Exports;
    if (this.exports.kernel_abi_version() !== 1)
      throw Error("Unsupported WASM kernel ABI");
  }
  call<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    blob: Uint8Array = new Uint8Array(),
  ): { value: T; data: Uint8Array; events: TraceEvent[] } {
    const request = encode.encode(JSON.stringify({ op, ...args }));
    const e = this.exports;
    const ptr = e.kernel_alloc(request.length),
      blobPtr = e.kernel_alloc(blob.length);
    try {
      new Uint8Array(e.memory.buffer, ptr, request.length).set(request);
      new Uint8Array(e.memory.buffer, blobPtr, blob.length).set(blob);
      e.kernel_call(ptr, request.length, blobPtr, blob.length);
      const response = JSON.parse(
        decode.decode(
          new Uint8Array(
            e.memory.buffer,
            e.kernel_response_ptr(),
            e.kernel_response_len(),
          ),
        ),
      ) as { ok: boolean; value: T; events: TraceEvent[]; error?: string };
      if (!response.ok)
        throw Error(response.error || "WASM kernel operation failed");
      const data = new Uint8Array(
        e.memory.buffer,
        e.kernel_data_ptr(),
        e.kernel_data_len(),
      ).slice();
      if (response.events.length) this.onEvents(response.events);
      return { value: response.value, data, events: response.events };
    } finally {
      e.kernel_dealloc(ptr, request.length);
      e.kernel_dealloc(blobPtr, blob.length);
    }
  }
  info() {
    return this.call<{
      execution: "WebAssembly";
      language: "Rust";
      abi: number;
      started: number;
      calls: number;
      linearMemoryBytes: number;
      taskCount: number;
      filesystemBytes: number;
    }>("kernel.info").value;
  }
}
