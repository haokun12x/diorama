/// <reference lib="webworker" />
// Upstream's Rust bridge asks for window; this alias exposes only worker globals.
const scope = globalThis as any;
scope.window = scope;
scope.Window = class {
  static [Symbol.hasInstance](value: unknown) {
    return value === scope;
  }
};
for (const name of [
  "HTMLImageElement",
  "HTMLCanvasElement",
  "HTMLVideoElement",
])
  scope[name] = class {};
let model: any;
let busy = false;
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({
      id: data.id,
      type: "error",
      message: "Vision worker is busy",
    });
    return;
  }
  busy = true;
  try {
    if (data.action === "load") {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        if (!response.ok)
          throw Error(`Vision asset ${response.url}: HTTP ${response.status}`);
        if (!response.body) return response;
        const reader = response.body.getReader();
        let loaded = 0;
        const encoding = response.headers.get("content-encoding");
        const total =
          encoding && encoding !== "identity"
            ? 0
            : Number(response.headers.get("content-length")) || 0;
        const body = new ReadableStream({
          async pull(controller) {
            const r = await reader.read();
            if (r.done) {
              controller.close();
              return;
            }
            loaded += r.value.length;
            self.postMessage({
              id: data.id,
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
      try {
        const { YOLO } = await import(
          /* @vite-ignore */ data.base + "yolo/dist/index.js"
        );
        model = await YOLO.load(data.base + "models/" + data.model + ".onnx", {
          device: data.device,
          ortBaseUrl: data.base + "ort/",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      let adapter;
      if (model.device === "webgpu") {
        try {
          const device = await scope.ort?.env?.webgpu?.device;
          const info =
            device?.adapterInfo || scope.ort?.env?.webgpu?.adapter?.info;
          if (info)
            adapter = {
              vendor: info.vendor || "",
              architecture: info.architecture || "",
              description: info.description || "",
              fallback:
                typeof info.isFallbackAdapter === "boolean"
                  ? info.isFallbackAdapter
                  : null,
              timestampQuery: !!device?.features?.has("timestamp-query"),
            };
        } catch {
          /* Optional metadata does not prevent actual inference. */
        }
      }
      self.postMessage({
        id: data.id,
        type: "done",
        adapter,
        device: model.device,
        task: model.task,
      });
    } else if (data.action === "predict") {
      if (!model) throw Error("Load a model first");
      const started = performance.now();
      const results = await model.predict(data.image, {
        conf: data.conf,
        classes: data.classes,
      });
      self.postMessage({
        id: data.id,
        type: "done",
        results,
        duration: performance.now() - started,
      });
    }
  } catch (e) {
    self.postMessage({
      id: data.id,
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    busy = false;
  }
};
