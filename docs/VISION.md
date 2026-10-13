# Local YOLO26 perception

DIORAMA pins @ultralytics/yolo 0.0.51, the official Ultralytics browser package built from its Rust inference crate. Selected exports are yolo26n.onnx and yolo26n-seg.onnx from Ultralytics assets v8.4.0. ONNX Runtime Web is the 1.27.0 distribution expected by the package. Exact downloaded sizes, sources, and SHA-256 hashes live in public/assets-manifest.json.

The package's model and Rust preprocessing/postprocessing remain intact. The preparation script adapts ort-web's DOM loader to a module worker, self-hosts its runtime, fixes CPU numThreads to one, and disables domain telemetry. The worker provides the minimal window alias the upstream bridge requests; it has no document. Inputs use encoded bytes or ImageData, avoiding DOM drawable paths. Package updates need a new compatibility test, rather than silently changing the adapter.

Detection and segmentation are genuine model evaluations. The returned speed fields measure preprocessing, inference, and postprocessing. DIORAMA also measures total worker prediction time and counts completed frames. It does not display invented GPU utilization, theoretical throughput as measured FPS, or performance copied from another machine.

WebGPU is requested only when available and the automatic backend falls back to CPU. CPU can be selected explicitly. These exports have fixed 640×640 input tensors, so arbitrary resolution adjustment is intentionally unavailable. The source-image dimensions/coordinates are preserved. Confidence and model selection are configurable. Segmentation masks are labeled YOLO26, never SAM3. SAM3 was removed from scope at the owner's request.

```sh
vision status
vision models
vision detect /samples/street.jpg --json
cat /tmp/vision/detections.json
vision segment /samples/street.jpg --model yolo26-seg
cat /tmp/vision/segments.json
ls -l /tmp/vision/mask.png
```

The vision UI adds sample selection, image upload, actual bounding-box overlays, labels, class selection, masks, side-by-side mask rendering, and camera operation. Selecting a class filters camera segmentation to that class; text, points, and instance-box prompts are not supported by this adapter. Stop-camera persists the latest results. Frames stay local. Camera permission denial, download failures, timeouts, and worker errors produce explicit retryable states.

Models load only when the visitor requests detection, segmentation, or camera inference. Weights are ~9.5/10.7 MiB; the ONNX CPU runtime adds ~12.9 MiB or WebGPU runtime ~25.6 MiB. Downloads are same-origin and no inference server is configured. An active-model switch terminates the old worker. Model cancellation terminates the worker and resets its loading state, permitting a clean retry.

Sources: [official package documentation](https://github.com/ultralytics/inference/tree/main/web), [YOLO26 documentation](https://docs.ultralytics.com/models/yolo26/), [assets release](https://github.com/ultralytics/assets/releases/tag/v8.4.0), [WASM runtime guidance](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

Stopping the camera terminates an in-flight worker, stops all MediaStream tracks, freezes the last completed source frame, and saves that frame and its actual result metadata to the local workspace. Result metadata is bound to each prediction rather than the mutable currently-loaded model, so cancelling or switching models cannot relabel older predictions.
