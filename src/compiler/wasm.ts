export type WasmInfo = {
  imports: WebAssembly.ModuleImportDescriptor[];
  exports: WebAssembly.ModuleExportDescriptor[];
  bytes: number;
};
// Validate the actual binary's defined linear memory before handing it to a worker.
export function validateMemory(bytes: Uint8Array, limitPages = 1024) {
  let i = 8;
  const leb = () => {
    let n = 0,
      shift = 0,
      b = 0;
    do {
      if (i >= bytes.length || shift > 28) throw Error("invalid WASM integer");
      b = bytes[i++];
      n |= (b & 127) << shift;
      shift += 7;
    } while (b & 128);
    return n >>> 0;
  };
  let memories = 0;
  while (i < bytes.length) {
    const section = bytes[i++],
      size = leb(),
      end = i + size;
    if (end > bytes.length) throw Error("invalid WASM section");
    if (section === 5) {
      const count = leb();
      memories += count;
      for (let n = 0; n < count; n++) {
        const flags = leb(),
          min = leb(),
          max = flags & 1 ? leb() : Infinity;
        if (flags !== 1 || min > max || max > limitPages)
          throw Error("guest memory must declare a maximum of at most 64 MiB");
      }
    }
    i = end;
  }
  if (memories !== 1)
    throw Error("guest must define exactly one bounded linear memory");
}
export async function inspectWasm(bytes: Uint8Array): Promise<WasmInfo> {
  const m = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
  return {
    imports: WebAssembly.Module.imports(m),
    exports: WebAssembly.Module.exports(m),
    bytes: bytes.length,
  };
}
