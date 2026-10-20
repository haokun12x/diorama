# Measurements and validation

Measurements below are actual browser observations from 2026-10-13. They are single acceptance runs on the development machine, not hardware-independent claims, warmed-up distributions, or a benchmark of native Linux. The environment is headless Chromium 153 on Linux, production Vite preview under /diorama/, without cross-origin isolation or SharedArrayBuffer. No network throttling was used; localhost results do not estimate broadband first-use download time.

| Experiment | Observed result |
|---|---|
| Cold-context homepage first contentful paint, localhost | 512 ms |
| Workspace restored and terminal input created, localhost | 862.7 ms; no compiler, model, or ONNX runtime downloads |
| Real hello.c Clang/LLD build | 630.5 ms; 184,672 linked WASM bytes (includes cwd initialization constructor) |
| Real files.c build | 532.1 ms; 261,261 linked WASM bytes |
| Rust kernel module | 240,102 bytes; 85,790 gzip bytes; built from pinned Rust 1.90.0 |
| Rust kernel linear memory, fresh workspace | 1,376,256 bytes observed; maximum 256 MiB |
| Rust/WASM service probe | Real C argv/env, mkdir/readdir, offsets, truncation, entropy, clock, permission denial, ENOTSUP; file bytes aZc |
| Guest linear memory during acceptance | 1,114,112 bytes observed |
| YOLO26n CPU street-image detection | 277.9 ms inference; 295.1 ms worker prediction pipeline; 5 detections |
| YOLO26n-seg CPU street-image segmentation | 361.6 ms inference; 388.7 ms pipeline; 4 detections; 3,499,200 RGBA mask bytes; valid PNG persisted |
| YOLO26n WebGPU path, SwiftShader software fallback adapter | 15,101.6 ms inference; 5 detections; not a hardware GPU measurement |
| Guest interruption | Infinite loop cancelled; worker disposed; shell exit 130 |
| Guest nonzero exit | C return 7 propagated as shell exit 7 |
| Compiler failure | Invalid C produced genuine Clang diagnostics, exit 1 |
| Persistence | Actual VFS file survived a page reload via IndexedDB |

The software WebGPU path validates backend integration, not acceleration. A physical GPU latency measurement remains unperformed. Automatic device detection can choose a software adapter; use the CPU option when that is faster. The UI reports the backend that actually executed, rather than assuming GPU access implies fast hardware.

Production bundle sizes are recorded by `npm run build`. With the October 20 observatory update, the initial app is approximately 271 kB raw / 90 kB gzip across the initial JavaScript chunks, plus the 240 kB raw Rust kernel module; the initial terminal chunk is 333 kB raw / 85 kB gzip. The 522 kB raw / 171 kB gzip CodeMirror editor is lazy. Compiler/model/runtime downloads are excluded from first-page use and start on an explicit action.

## Reproduce

```sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
npm ci
npm run kernel
npm run assets
npm run typecheck
npm test
npm run test:rust
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
# against a deployed site:
DIORAMA_URL=https://haokun12x.github.io/diorama/ npm run test:e2e
```

The original validation passed 14 Vitest cases against the actual kernel WASM, 3 Rust unit tests, and 8 browser acceptance cases. The October 20 observatory update extends coverage to 17 Vitest cases and 9 browser acceptance cases, adding event grouping, real memory growth, telemetry boundaries, replay, export, and pause/resume checks. The real model and compiler tests use no fabricated prediction/compilation fixtures. The successful camera test uses Chromium's explicitly synthetic test-video device but evaluates the real model, verifies one-frame processing, stops the actual MediaStream tracks, and checks persisted prediction metadata. Accessibility scanning reports zero detected WCAG A/AA issues across the five desktop computer views; this is an automated check, not a certification. The camera-denial test deliberately replaces getUserMedia with a permission error; the asset-failure test deliberately responds HTTP 503. Those validate error handling, not inference. The WebGPU test enables Chromium's software-capable test adapter and prints its architecture/fallback status. CI records detailed test output and uploads test-results artifacts.

For a meaningful hardware performance study, record browser/OS/adapter, model hash, tensor size, threshold, first-use downloads, warmup policy, at least 30 inference samples, and p50/p95 independently for CPU and WebGPU. Do not turn these single-run observations into an advertised FPS guarantee.
