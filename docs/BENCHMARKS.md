# Measurements and validation

Measurements below are actual browser observations from 2026-10-13. They are single acceptance runs on the development machine, not hardware-independent claims, warmed-up distributions, or a benchmark of native Linux. The environment is headless Chromium 153 on Linux, production Vite preview under /diorama/, without cross-origin isolation or SharedArrayBuffer. No network throttling was used; localhost results do not estimate broadband first-use download time.

| Experiment | Observed result |
|---|---|
| Real hello.c Clang/LLD build | 651.0 ms; 184,672 linked WASM bytes (includes cwd initialization constructor) |
| Real files.c build | 531.2 ms; 261,261 linked WASM bytes |
| Guest linear memory during acceptance | 1,114,112 bytes observed |
| YOLO26n CPU street-image detection | 281.1 ms inference; 298.4 ms worker prediction pipeline; 5 detections |
| YOLO26n-seg CPU street-image segmentation | 360.6 ms inference; 389.2 ms pipeline; 4 detections; 3,499,200 RGBA mask bytes; valid PNG persisted |
| YOLO26n WebGPU path, SwiftShader software fallback adapter | 14,745.8 ms inference; 5 detections; not a hardware GPU measurement |
| Guest interruption | Infinite loop cancelled; worker disposed; shell exit 130 |
| Guest nonzero exit | C return 7 propagated as shell exit 7 |
| Compiler failure | Invalid C produced genuine Clang diagnostics, exit 1 |
| Persistence | Actual VFS file survived a page reload via IndexedDB |

The software WebGPU path validates backend integration, not acceleration. A physical GPU latency measurement remains unperformed. Automatic device detection can choose a software adapter; use the CPU option when that is faster. The UI reports the backend that actually executed, rather than assuming GPU access implies fast hardware.

Production bundle sizes are recorded by `npm run build`. The initial app is approximately 247 kB raw / 80 kB gzip; the initial terminal chunk is 333 kB raw / 85 kB gzip. The 522 kB raw / 171 kB gzip CodeMirror editor is lazy. Compiler/model/runtime downloads are excluded from first-page use and start on an explicit action.

## Reproduce

```sh
npm ci
npm run assets
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
# against a deployed site:
DIORAMA_URL=https://haokun12x.github.io/diorama/ npm run test:e2e
```

The real model and compiler tests use no fabricated prediction/compilation fixtures. The camera-denial test deliberately replaces getUserMedia with a permission error; the asset-failure test deliberately responds HTTP 503. Those validate error handling, not inference. The WebGPU test enables Chromium's software-capable test adapter and prints its architecture/fallback status. CI records detailed test output and uploads test-results artifacts.

For a meaningful hardware performance study, record browser/OS/adapter, model hash, tensor size, threshold, first-use downloads, warmup policy, at least 30 inference samples, and p50/p95 independently for CPU and WebGPU. Do not turn these single-run observations into an advertised FPS guarantee.
