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

Supported flags: -O0/-O1/-O2/-O3/-Os/-Oz, -g, -Wall, -Wextra, -Werror, -std=c89/c99/c11/c17/c2x/c23, and -DNAME=value. One translation unit is supported; local .h files in /home/visitor are copied into the compiler's isolated filesystem. Multi-file linking and C++ UI are not implemented.

The actual module inspector uses `WebAssembly.Module.imports` and `.exports`. Clang diagnostics and nonzero guest exits remain visible. Compile has a 180 s timeout, guests 10 s, output 1 MiB, linear memory 64 MiB, file size 8 MiB, and workspace 32 MiB. Limits apply to guest linear memory; browser-managed compiler and inference allocations are larger and not described as guest usage.

WASI preview1 imports come from the pinned browser_wasi_shim. Common exercised interfaces include argument/environment reads, fd_read/write/seek/close/stat, path_open, directory/stat calls, clocks, random_get, and proc_exit. All supported shim imports are available except restricted mutation paths and guest link/rename/symlink calls, which return permission/unsupported errors. Polling behavior is the shim's implementation, not a POSIX scheduler. There are no sockets, threads, fork, native host filesystem, or DOM/network imports.

All guests require exactly one defined, non-shared memory with a maximum ≤1024 64 KiB pages. The binary validator checks this before instantiation. Clang links with a 64 MiB maximum and 1 MiB stack. A compiler worker is disposed after each compilation to release large LLVM heaps. Browser HTTP cache can reuse assets. User binaries live in the VFS and IndexedDB, not in an application backend.

DIORAMA injects a private constructor header that calls wasi-libc `chdir(getenv("PWD"))` before main. The cwd and root are explicit preopens named by their absolute paths. This keeps relative guest file operations consistent with the invoking shell. The header is part of the worker adapter and is compiled by Clang along with the user translation unit; it is not an output simulator.
