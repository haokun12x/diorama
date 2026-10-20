import type { AdapterInfo } from "../observability/telemetry";
import type { Results } from "@ultralytics/yolo";
import type { Kernel, Task } from "../kernel/kernel";
export class Vision {
  status = "Models unloaded";
  device = "not initialized";
  modelName = "";
  preferredDevice: "auto" | "cpu" = "auto";
  confidence = 0.25;
  last?: Results;
  lastDuration?: number;
  frames = 0;
  progress = new Map<string, { loaded: number; total: number }>();
  imageUrl = import.meta.env.BASE_URL + "samples/street.jpg";
  worker?: Worker;
  busy = false;
  private seq = 0;
  lastMaskUrl?: string;
  private resultMetadata = new WeakMap<
    Results,
    { model: string; backend: string; pipelineMs: number; timestamp: string }
  >();
  constructor(public kernel: Kernel) {}
  describe() {
    return `${this.status}\nModel: ${this.modelName || "none"}\nBackend: ${this.device}\nFrames processed: ${this.frames}\nInference: ${this.last ? this.last.speed.inference.toFixed(2) + " ms" : "not measured"}\nAll inference stays in this browser. Input tensor: fixed 640×640.\n`;
  }
  private async rpc<T>(
    payload: Record<string, unknown>,
    task: Task,
    limit = 120000,
  ): Promise<T> {
    if (!this.worker)
      this.worker = new Worker(
        new URL("../workers/vision.worker.ts", import.meta.url),
        { type: "module" },
      );
    const worker = this.worker,
      id = ++this.seq;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", error);
        task.controller.signal.removeEventListener("abort", abort);
      };
      const stop = (reason: string) => {
        cleanup();
        worker.terminate();
        this.worker = undefined;
        this.modelName = "";
        this.device = "not initialized";
        reject(Error(reason));
      };
      const abort = () => stop("Vision interrupted");
      const error = (e: ErrorEvent) =>
        stop(e.message || "Vision worker failed");
      const timer = setTimeout(
        () => stop("Vision worker timed out; retry or choose CPU"),
        limit,
      );
      const message = ({ data }: MessageEvent) => {
        if (data.id !== id) return;
        if (data.type === "progress") {
          this.progress.set(data.asset, {
            loaded: data.loaded,
            total: data.total,
          });
          this.status = "Downloading " + data.asset;
          this.kernel.notify();
        } else if (data.type === "done") {
          cleanup();
          resolve(data);
        } else if (data.type === "error") stop(data.message);
      };
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      task.controller.signal.addEventListener("abort", abort, { once: true });
      if (task.controller.signal.aborted) {
        abort();
        return;
      }
      worker.postMessage({ ...payload, id });
    });
  }
  async load(segment: boolean, task: Task) {
    const name = segment ? "yolo26n-seg" : "yolo26n";
    if (this.modelName === name && this.worker) return;
    this.worker?.terminate();
    this.worker = undefined;
    this.modelName = "";
    this.status = "Initializing " + name;
    this.kernel.trace(task.pid, "vision", "model.initialize", name, "loading");
    this.progress.clear();
    this.kernel.notify();
    const result = await this.rpc<{
      device: string;
      task: string;
      adapter?: AdapterInfo;
    }>(
      {
        action: "load",
        model: name,
        device: this.preferredDevice,
        base: new URL(import.meta.env.BASE_URL, location.origin).href,
      },
      task,
      180000,
    );
    this.kernel.telemetry.adapter = result.adapter;
    this.modelName = name;
    this.device = result.device;
    this.status = "Ready · " + name;
    this.kernel.trace(task.pid, "vision", "model.load", name, this.device);
    this.kernel.notify();
  }
  async infer(
    image: Uint8Array | ImageData,
    segment = false,
    parent = 1,
    signal?: AbortSignal,
    classes?: number[],
    persist = true,
  ): Promise<Results> {
    if (this.busy)
      throw Error("Vision is processing one frame; wait for it to finish");
    this.busy = true;
    try {
      return await this.kernel.run(
        segment ? "YOLO26 segmentation" : "YOLO26 detection",
        "vision",
        async (task) => {
          this.kernel.state(task, "waiting");
          await this.load(segment, task);
          this.status = "Running inference";
          this.kernel.trace(
            task.pid,
            "vision",
            "predict.begin",
            this.modelName,
            this.device,
          );
          this.kernel.state(task, "running");
          const result = await this.rpc<{ results: Results; duration: number }>(
            { action: "predict", image, conf: this.confidence, classes },
            task,
          );
          const r = result.results;
          if (
            r.boxes.some(
              (b) =>
                ![b.x1, b.y1, b.x2, b.y2, b.conf].every(Number.isFinite) ||
                b.x2 < b.x1 ||
                b.y2 < b.y1,
            )
          )
            throw Error("Model returned invalid bounding boxes");
          this.resultMetadata.set(r, {
            model: this.modelName,
            backend: this.device,
            pipelineMs: result.duration,
            timestamp: new Date().toISOString(),
          });
          this.last = r;
          this.lastDuration = result.duration;
          this.frames++;
          this.kernel.telemetry.recordInference({
            pid: task.pid,
            model: this.modelName,
            backend: this.device,
            preprocess: r.speed.preprocess,
            inference: r.speed.inference,
            postprocess: r.speed.postprocess,
            pipeline: result.duration,
            objects: r.boxes.length,
          });
          this.status = `Ready · ${r.boxes.length} objects`;
          if (persist) await this.persist(r, segment, task.pid);
          this.kernel.trace(
            task.pid,
            "vision",
            "model.predict",
            `${r.width}×${r.height}, conf=${this.confidence}`,
            String(r.boxes.length) + " objects",
            result.duration,
          );
          this.kernel.notify();
          return r;
        },
        parent,
        signal,
      );
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e);
      this.kernel.notify();
      throw e;
    } finally {
      this.busy = false;
      this.kernel.notify();
    }
  }
  async inferPath(
    path: string,
    segment = false,
    parent = 1,
    signal?: AbortSignal,
    classes?: number[],
  ) {
    if (
      !this.kernel.fs.exists(path) &&
      ["/samples/street.jpg", "/samples/people.jpg"].includes(path)
    ) {
      const res = await fetch(import.meta.env.BASE_URL + path.slice(1), {
        signal,
      });
      if (!res.ok) throw Error(`Sample image: HTTP ${res.status}`);
      this.kernel.fs.write(path, new Uint8Array(await res.arrayBuffer()));
    }
    const bytes = this.kernel.fs.read(path);
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>]),
    );
    if (this.imageUrl.startsWith("blob:")) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = url;
    return this.infer(bytes, segment, parent, signal, classes);
  }
  json(r: Results) {
    const metadata = this.resultMetadata.get(r);
    return {
      model: metadata?.model || this.modelName,
      backend: metadata?.backend || this.device,
      width: r.width,
      height: r.height,
      boxes: r.boxes,
      speed: r.speed,
      pipelineMs: metadata?.pipelineMs ?? this.lastDuration,
      masks: {
        bytes: r.masks.length,
        path: r.masks.length ? "/tmp/vision/mask.png" : null,
      },
      timestamp: metadata?.timestamp || new Date().toISOString(),
    };
  }
  async persist(r: Results, segment: boolean, pid = 1) {
    this.kernel.withPid(pid, () => {
      this.kernel.fs.mkdir("/tmp/vision", true);
      this.kernel.fs.write(
        "/tmp/vision/" + (segment ? "segments" : "detections") + ".json",
        JSON.stringify(this.json(r), null, 2) + "\n",
      );
    });
    if (r.masks.length) {
      const canvas = document.createElement("canvas");
      canvas.width = r.width;
      canvas.height = r.height;
      canvas
        .getContext("2d")!
        .putImageData(
          new ImageData(new Uint8ClampedArray(r.masks), r.width, r.height),
          0,
          0,
        );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) =>
          b ? resolve(b) : reject(Error("Cannot encode mask")),
        ),
      );
      const maskBytes = new Uint8Array(await blob.arrayBuffer());
      this.kernel.withPid(pid, () =>
        this.kernel.fs.write("/tmp/vision/mask.png", maskBytes),
      );
      if (this.lastMaskUrl) URL.revokeObjectURL(this.lastMaskUrl);
      this.lastMaskUrl = URL.createObjectURL(blob);
    }
  }
  unload() {
    if (this.busy)
      throw Error("Cancel the active task before changing the device");
    this.worker?.terminate();
    this.worker = undefined;
    this.modelName = "";
    this.last = undefined;
    this.device = "not initialized";
    this.status = "Models unloaded";
    this.kernel.notify();
  }
}
