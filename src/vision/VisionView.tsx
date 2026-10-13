import { useEffect, useRef, useState } from "react";
import type { Results } from "@ultralytics/yolo";
import { kernel, vision } from "../app/machine";
import { useMachine } from "../components/useMachine";
function draw(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  width: number,
  height: number,
  r?: Results,
  masks = true,
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0, width, height);
  if (!r) return;
  if (masks && r.masks.length) {
    const overlay = document.createElement("canvas");
    overlay.width = r.width;
    overlay.height = r.height;
    overlay
      .getContext("2d")!
      .putImageData(
        new ImageData(new Uint8ClampedArray(r.masks), r.width, r.height),
        0,
        0,
      );
    ctx.drawImage(overlay, 0, 0, width, height);
  }
  const sx = width / r.width,
    sy = height / r.height;
  ctx.lineWidth = Math.max(2, width / 360);
  ctx.font = `${Math.max(13, width / 50)}px monospace`;
  for (const b of r.boxes) {
    const x = b.x1 * sx,
      y = b.y1 * sy,
      w = (b.x2 - b.x1) * sx,
      h = (b.y2 - b.y1) * sy;
    ctx.strokeStyle = b.color || "#c2d49c";
    ctx.strokeRect(x, y, w, h);
    const text = `${b.name} ${(b.conf * 100).toFixed(0)}%`;
    const tw = ctx.measureText(text).width + 12,
      th = width / 35 + 8;
    ctx.fillStyle = b.color || "#c2d49c";
    ctx.fillRect(x, Math.max(0, y - th), tw, th);
    ctx.fillStyle = "#172018";
    ctx.fillText(text, x + 6, Math.max(th - 5, y - 5));
  }
}
export default function VisionView() {
  useMachine();
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    alive = useRef(true),
    cameraOn = useRef(false),
    abort = useRef<AbortController | null>(null);
  const [sample, setSample] = useState("/samples/street.jpg"),
    [segment, setSegment] = useState(false),
    [mask, setMask] = useState(true),
    [split, setSplit] = useState(false),
    [camera, setCamera] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<number | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cameraOn.current = false;
      stream.current?.getTracks().forEach((t) => t.stop());
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (camera) return;
    let stale = false;
    const image = new Image();
    image.onload = () => {
      if (!stale && canvas.current)
        draw(
          canvas.current,
          image,
          image.naturalWidth,
          image.naturalHeight,
          vision.last,
          mask,
        );
    };
    image.src = vision.imageUrl;
    return () => {
      stale = true;
    };
  }, [vision.imageUrl, vision.last, mask, camera]);
  const infer = async () => {
    setError("");
    abort.current = new AbortController();
    try {
      await vision.inferPath(
        sample,
        segment,
        1,
        abort.current.signal,
        segment && selected !== undefined ? [selected] : undefined,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
    }
  };
  const upload = async (file: File) => {
    setError("");
    try {
      if (!file.type.startsWith("image/")) throw Error("Choose an image file");
      if (file.size > 8 * 1024 * 1024) throw Error("Image exceeds 8 MiB");
      kernel.fs.write(
        "/tmp/upload-image",
        new Uint8Array(await file.arrayBuffer()),
      );
      setSample("/tmp/upload-image");
      if (vision.imageUrl.startsWith("blob:"))
        URL.revokeObjectURL(vision.imageUrl);
      vision.imageUrl = URL.createObjectURL(file);
      vision.last = undefined;
      setSelected(undefined);
      kernel.notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const choose = (path: string) => {
    setSample(path);
    vision.imageUrl = import.meta.env.BASE_URL + path.slice(1);
    vision.last = undefined;
    setSelected(undefined);
    kernel.notify();
  };
  const stop = () => {
    cameraOn.current = false;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera(false);
  };
  const startCamera = async () => {
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error("Camera requires HTTPS and browser camera support");
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      if (!alive.current) {
        stream.current.getTracks().forEach((t) => t.stop());
        return;
      }
      video.current!.srcObject = stream.current;
      await video.current!.play();
      cameraOn.current = true;
      setCamera(true);
      const buffer = document.createElement("canvas");
      buffer.width = video.current!.videoWidth;
      buffer.height = video.current!.videoHeight;
      const context = buffer.getContext("2d", { willReadFrequently: true })!;
      // Exactly one frame in flight. Capture the latest available frame only after inference finishes.
      while (cameraOn.current && alive.current) {
        context.drawImage(video.current!, 0, 0, buffer.width, buffer.height);
        const image = context.getImageData(0, 0, buffer.width, buffer.height);
        abort.current = new AbortController();
        const r = await vision.infer(
          image,
          segment,
          1,
          abort.current.signal,
          selected === undefined ? undefined : [selected],
          false,
        );
        if (canvas.current && cameraOn.current)
          draw(canvas.current, buffer, buffer.width, buffer.height, r, mask);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      if (vision.last) await vision.persist(vision.last, segment);
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Camera access was denied. Use a sample image or upload instead."
          : e instanceof Error
            ? e.message
            : String(e),
      );
      stop();
    } finally {
      abort.current = null;
    }
  };
  return (
    <div className="vision-grid">
      <div className="vision-stage">
        <div className="pane-title">
          <span>
            Perception /{" "}
            <b>{segment ? "instance segmentation" : "object detection"}</b>
          </span>
          <span className="micro">LOCAL INFERENCE</span>
        </div>
        <div className={"vision-canvas " + (split ? "split" : "")}>
          <canvas
            ref={canvas}
            aria-label="Source image with actual YOLO26 predictions"
          />
          {split && vision.last?.masks.length && vision.lastMaskUrl ? (
            <img
              src={vision.lastMaskUrl}
              alt="Actual YOLO26 segmentation mask"
            />
          ) : null}
          <video ref={video} muted playsInline className="camera-source" />
        </div>
        <div className="vision-metrics">
          {[
            ["BACKEND", vision.device],
            [
              "INFERENCE",
              vision.last
                ? vision.last.speed.inference.toFixed(1) + " ms"
                : "—",
            ],
            [
              "PIPELINE",
              vision.lastDuration
                ? vision.lastDuration.toFixed(1) + " ms"
                : "—",
            ],
            ["OBJECTS", vision.last ? String(vision.last.boxes.length) : "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <span className="micro">{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <p className="fine">
          Model input: fixed 640 × 640. Boxes use source-image coordinates.
          Camera processing keeps one frame in flight. Pipeline time includes
          preprocessing, inference, and postprocessing.
        </p>
      </div>
      <aside className="vision-controls">
        <p className="micro">YOLO26 / VISION LAB</p>
        <h3>Let the machine see.</h3>
        <p>Real neural perception, running where the image lives.</p>
        <label>
          Model
          <select
            value={segment ? "segment" : "detect"}
            disabled={vision.busy || camera}
            onChange={(e) => {
              setSegment(e.target.value === "segment");
              setSelected(undefined);
            }}
          >
            <option value="detect">YOLO26n · detection</option>
            <option value="segment">YOLO26n-seg · segmentation</option>
          </select>
        </label>
        <label>
          Device
          <select
            value={vision.preferredDevice}
            disabled={vision.busy || camera}
            onChange={(e) => {
              vision.unload();
              vision.preferredDevice = e.target.value as "auto" | "cpu";
              kernel.notify();
            }}
          >
            <option value="auto">Automatic · WebGPU / CPU</option>
            <option value="cpu">CPU / WebAssembly</option>
          </select>
        </label>
        <label>
          Confidence <span>{Math.round(vision.confidence * 100)}%</span>
          <input
            type="range"
            min="5"
            max="95"
            step="5"
            aria-label="Confidence threshold"
            value={vision.confidence * 100}
            disabled={vision.busy}
            onChange={(e) => {
              vision.confidence = Number(e.target.value) / 100;
              kernel.notify();
            }}
          />
        </label>
        <div className="sample-buttons">
          <button
            onClick={() => choose("/samples/street.jpg")}
            disabled={vision.busy || camera}
            className={sample === "/samples/street.jpg" ? "selected" : ""}
          >
            Street scene
          </button>
          <button
            onClick={() => choose("/samples/people.jpg")}
            disabled={vision.busy || camera}
            className={sample === "/samples/people.jpg" ? "selected" : ""}
          >
            People
          </button>
        </div>
        <div className="vision-actions">
          <button
            className="primary small"
            onClick={infer}
            disabled={vision.busy || camera}
          >
            {vision.busy
              ? "Processing…"
              : segment
                ? "Segment image ↗"
                : "Detect objects ↗"}
          </button>
          <label className="upload-button">
            Upload image
            <input
              type="file"
              accept="image/*"
              disabled={vision.busy || camera}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
          <button
            className="secondary small"
            onClick={() => (camera ? stop() : void startCamera())}
            disabled={vision.busy && !camera}
          >
            {camera ? "Stop camera" : "Use camera"}
          </button>
          {vision.busy && (
            <button
              className="text-button"
              onClick={() => {
                stop();
                abort.current?.abort();
              }}
            >
              Cancel task
            </button>
          )}
        </div>
        <p className="fine">
          Images and camera frames stay in this browser. Models and runtimes
          download from this site on first use; no inference server or
          telemetry.
        </p>
        <p
          className={"vision-status " + (error ? "error" : "")}
          aria-live="polite"
        >
          {error || vision.status}
        </p>
        {vision.busy && (
          <div className="downloads">
            {[...vision.progress].map(([name, p]) => (
              <div key={name}>
                <span>{name}</span>
                <span>
                  {(p.loaded / 1048576).toFixed(1)} MiB{" "}
                  {p.total ? "/ " + (p.total / 1048576).toFixed(1) : ""}
                </span>
                <progress
                  max={p.total || 1}
                  value={p.total ? p.loaded : undefined}
                />
              </div>
            ))}
          </div>
        )}
        {vision.last && (
          <>
            <div className="overlay-options">
              <label>
                <input
                  type="checkbox"
                  checked={mask}
                  onChange={(e) => setMask(e.target.checked)}
                />{" "}
                Mask overlay
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={split}
                  onChange={(e) => setSplit(e.target.checked)}
                />{" "}
                Side by side
              </label>
            </div>
            <div className="detection-list">
              {vision.last.boxes.map((b, i) => (
                <button
                  key={i}
                  className={selected === b.cls ? "selected" : ""}
                  onClick={() =>
                    setSelected(selected === b.cls ? undefined : b.cls)
                  }
                >
                  <span style={{ background: b.color }} />
                  <b>{b.name}</b>
                  <code>{(b.conf * 100).toFixed(1)}%</code>
                </button>
              ))}
            </div>
            {selected !== undefined && (
              <p className="fine">
                Selected class {selected}. The next segmentation filters to this
                class. YOLO26 segments COCO classes; it does not accept text
                prompts.
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
