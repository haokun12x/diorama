/// <reference lib="webworker" />
self.onmessage = async ({
  data,
}: {
  data: {
    source: string;
    fileName: string;
    flags: string[];
    extraFiles: Record<string, string>;
    base: string;
  };
}) => {
  try {
    const originalFetch = globalThis.fetch;
    // Measure byte progress for all large compiler artifacts, including Emscripten streaming loads.
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (!response.ok)
        throw Error(`Compiler asset ${response.url}: HTTP ${response.status}`);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const encoding = response.headers.get("content-encoding");
      const total =
        encoding && encoding !== "identity"
          ? 0
          : Number(response.headers.get("content-length")) || 0;
      let loaded = 0;
      const body = new ReadableStream({
        async pull(controller) {
          const r = await reader.read();
          if (r.done) {
            controller.close();
            return;
          }
          loaded += r.value.length;
          self.postMessage({
            type: "progress",
            asset: response.url.split("/").pop(),
            loaded,
            total,
          });
          controller.enqueue(r.value);
        },
        cancel() {
          return reader.cancel();
        },
      });
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    };
    self.postMessage({
      type: "phase",
      phase: "Loading Clang + LLD + WASI sysroot",
    });
    const cc = await import(
      /* @vite-ignore */ data.base + "toolchain/index.js"
    );
    const started = performance.now();
    const runtimeHeader =
      '#include <stdlib.h>\n#include <unistd.h>\n__attribute__((constructor)) static void __diorama_working_directory(void) { const char *p = getenv("PWD"); if (p) chdir(p); }\n';
    const result = await cc.compile({
      ...data,
      extraFiles: { ...data.extraFiles, "__diorama_runtime.h": runtimeHeader },
      flags: [
        ...data.flags,
        "-include",
        "__diorama_runtime.h",
        "-Wl,--max-memory=67108864",
        "-Wl,-z,stack-size=1048576",
      ],
    });
    self.postMessage({
      type: "done",
      diagnostics: result.compileOutput,
      binary: result.binary,
      duration: performance.now() - started,
    });
  } catch (e) {
    self.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
