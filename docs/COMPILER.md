# Real browser C toolchain

The locked browsercc 0.1.1 distribution provides LLVM 20.1.2 Clang and LLD WebAssembly binaries and WASI SDK 25 headers/libraries. `scripts/prepare-assets.mjs` copies the package and adds the linked output bytes to its result. No compiler result is fabricated and no source is sent to a server. See the browsercc MIT notice, LLVM Apache-2.0 WITH LLVM-exception notices, and WASI/musl notices under public/licenses.

```sh
cat hello.c
cc hello.c -O2 -o hello
./hello
trace show
ps
cc files.c -o files
./files
cat /tmp/guest-note.txt
cc stdin.c -o input
echo "input from the shell" | ./input
```

Samples cover hello, Fibonacci, guest file I/O, malloc/checksum, qsort, numerical integration, and stdin. CodeMirror edits the same C source file the shell compiles. Compile saves it, passes allowed options to Clang, and writes a .wasm output. Run executes that output; after edits, compile again before running.

Supported flags: -O0/-O1/-O2/-O3/-Os/-Oz, -g, -Wall, -Wextra, -Werror, -std=c89/c99/c11/c17/c2x/c23, and -DNAME=value. One translation unit is supported; local .h files in /home/visitor are copied at their absolute VFS paths into the compiler's isolated filesystem, preserving source-relative includes in nested folders. Multi-file linking and C++ UI are not implemented.

The actual module inspector uses `WebAssembly.Module.imports` and `.exports`. Clang diagnostics and nonzero guest exits remain visible. Compile has a 180 s timeout, guests 10 s, output 1 MiB per stdout/stderr stream, guest linear memory 64 MiB, file size 8 MiB, and workspace 32 MiB. The system kernel instance has a separate 256 MiB linear-memory maximum. Limits apply to guest linear memory; browser-managed compiler and inference allocations are larger and not described as guest usage.

WASI preview1 service semantics execute in an independent instance of the Rust/WASM kernel. The JavaScript worker marshals guest pointers into the kernel ABI and copies results back. Services include argument/environment reads, fd_read/write/pread/pwrite/seek/tell/close/stat/flags, size/allocation, path_open, mkdir/unlink/rmdir, directory/stat calls, clocks, random_get, and proc_exit. Unsupported polling, links/rename/symlinks, rights changes, timestamp changes, signals, and sockets return ENOTSUP. Directory traversal may not escape its fd capability; writes are restricted to /home/visitor and /tmp. Entropy comes from browser crypto.getRandomValues. There are no threads, fork, native host filesystem, or DOM/network imports.

All guests require exactly one defined, non-shared memory with a maximum ≤1024 64 KiB pages. The binary validator checks this before instantiation. Clang links with a 64 MiB maximum and 1 MiB stack. A compiler worker is disposed after each compilation to release large LLVM heaps. Browser HTTP cache can reuse assets. User binaries live in the VFS and IndexedDB, not in an application backend.

DIORAMA injects a private constructor header that calls wasi-libc `chdir(getenv("PWD"))` before main. The cwd and root are explicit preopens named by their absolute paths. This keeps relative guest file operations consistent with the invoking shell. The header is part of the worker adapter and is compiled by Clang along with the user translation unit; it is not an output simulator.

The initial workspace also mounts sample-hello, a ~50 kB prebuilt WASI executable compiled by the same Clang WebAssembly toolchain during asset preparation. Its exact source is sample-hello.c. Running it immediately exercises real guest execution; it does not replace visitor-driven browser compilation.
