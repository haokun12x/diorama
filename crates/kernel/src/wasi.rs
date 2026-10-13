//! Restricted WASI preview1 services. Filesystem/descriptor semantics execute in this WASM module.
use super::*;
fn put32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn put64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
fn integer(v: &Value, name: &str) -> Result<u64, String> {
    v[name]
        .as_u64()
        .or_else(|| v[name].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| "invalid integer".into())
}
fn index(v: &Value, name: &str) -> Result<usize, String> {
    usize::try_from(integer(v, name)?).map_err(|_| "integer exceeds wasm32 range".into())
}
fn errno(error: &str) -> u32 {
    if error.contains("unsupported") {
        58
    } else if error.contains("descriptor limit") {
        33
    } else if error.contains("bad descriptor") {
        8
    } else if error.contains("no such") {
        44
    } else if error.contains("already exists") {
        20
    } else if error.contains("not empty") {
        55
    } else if error.contains("not a directory") {
        54
    } else if error.contains("is a directory") {
        31
    } else if error.contains("8 MiB") {
        22
    } else if error.contains("limit") {
        51
    } else if error.contains("not capable") {
        76
    } else if error.contains("permission") || error.contains("read-only") {
        63
    } else {
        28
    }
}
impl Kernel {
    pub(super) fn write_guard(&self, p: &str) -> Result<(), String> {
        guard(p)?;
        if self.guest_pid.is_some()
            && !p.starts_with("/home/visitor/")
            && !p.starts_with("/tmp/")
            && p != "/dev/stdout"
            && p != "/dev/stderr"
        {
            return Err("permission denied by guest filesystem capability".into());
        }
        Ok(())
    }
    pub(super) fn guest_init(&mut self, req: &Value, stdin: &[u8]) -> Result<Value, String> {
        let pid = num(req, "pid");
        if stdin.len() > 1024 * 1024 {
            return Err("stdin exceeds 1 MiB limit".into());
        }
        if pid == 0 {
            return Err("guest PID must be nonzero".into());
        }
        let cwd = path(text(req, "cwd"))?;
        if !self.stat(&cwd)?.dir {
            return Err("cwd is not a directory".into());
        }
        self.argv = serde_json::from_value(req["argv"].clone()).map_err(|_| "invalid argv")?;
        self.environ =
            serde_json::from_value(req["env"].clone()).map_err(|_| "invalid environment")?;
        if self
            .argv
            .iter()
            .chain(self.environ.iter())
            .any(|s| s.contains('\0'))
        {
            return Err("NUL in argv/environment".into());
        }
        if self.argv.len() + self.environ.len() > 512
            || self
                .argv
                .iter()
                .chain(self.environ.iter())
                .map(|s| s.len())
                .sum::<usize>()
                > 65536
        {
            return Err("argument/environment limit reached".into());
        }
        for (name, bytes) in [("stdin", stdin), ("stdout", &[][..]), ("stderr", &[][..])] {
            self.write(&format!("/dev/{name}"), bytes, false, true)?;
        }
        self.tasks.clear();
        self.tasks.insert(
            pid,
            Task {
                pid,
                ppid: 0,
                name: self
                    .argv
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "WASI guest".into()),
                kind: "wasm guest".into(),
                state: "running".into(),
                created: now(),
                ended: None,
                exit_code: None,
                memory_bytes: 0,
            },
        );
        self.fds = Self::stdio(pid);
        self.fds.push(Descriptor {
            pid,
            fd: 3,
            path: "/".into(),
            mode: "r".into(),
            offset: 0,
            flags: 0,
            dir: true,
            preopen: true,
        });
        self.fds.push(Descriptor {
            pid,
            fd: 4,
            path: cwd,
            mode: "r".into(),
            offset: 0,
            flags: 0,
            dir: true,
            preopen: true,
        });
        self.guest_pid = Some(pid);
        self.caller = pid;
        self.proc_mounted = true;
        self.mkdir("/proc", true, true)?;
        for name in ["tasks", "mounts", "runtime"] {
            self.write(&format!("/proc/{name}"), &[], false, true)?;
        }
        self.trace(
            pid,
            "kernel",
            "guest.init",
            "WASI preview1 in Rust/WASM",
            "ready",
            0.0,
        );
        Ok(json!(null))
    }
    fn descriptor_index(&self, fd: u32) -> Result<usize, String> {
        let pid = self.guest_pid.ok_or("guest not initialized")?;
        self.fds
            .iter()
            .position(|d| d.pid == pid && d.fd == fd)
            .ok_or_else(|| "bad descriptor".into())
    }
    fn relative_path(&self, fd: u32, name: &str) -> Result<String, String> {
        let d = &self.fds[self.descriptor_index(fd)?];
        if !d.dir {
            return Err("not a directory".into());
        }
        if name.starts_with('/') || name.contains('\0') {
            return Err("not capable: WASI paths must be relative".into());
        }
        let mut depth = 0;
        for part in name.split('/') {
            match part {
                "" | "." => (),
                ".." => {
                    if depth == 0 {
                        return Err("not capable: traversal escapes directory".into());
                    }
                    depth -= 1;
                }
                _ => depth += 1,
            }
        }
        path(&format!("{}/{}", d.path, name))
    }
    fn file_stat(&self, p: &str, out: &mut Vec<u8>) -> Result<(), String> {
        let n = self.stat(p)?;
        let size = self.proc_read(p).map(|b| b.len()).unwrap_or(n.data.len());
        out.resize(64, 0);
        put64(out, 0, 1);
        put64(out, 8, n.ino);
        out[16] = if n.dir { 3 } else { 4 };
        put64(out, 24, 1);
        put64(out, 32, size as u64);
        put64(out, 48, (n.mtime * 1_000_000.) as u64);
        put64(out, 56, (n.mtime * 1_000_000.) as u64);
        Ok(())
    }
    pub(super) fn wasi(
        &mut self,
        req: &Value,
        blob: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<Value, String> {
        let name = text(req, "op").trim_start_matches("wasi.").to_string();
        let began = now();
        let result = self.wasi_inner(&name, req, blob, out);
        let (code, fields) = match result {
            Ok(fields) => (0, fields),
            Err(error) => {
                out.clear();
                (errno(&error), json!({"message":error}))
            }
        };
        let pid = self.guest_pid.unwrap_or(self.caller);
        self.trace(
            pid,
            "WASI",
            &name,
            text(req, "traceArgs"),
            &code.to_string(),
            now() - began,
        );
        Ok(json!({"errno":code,"fields":fields}))
    }
    fn wasi_inner(
        &mut self,
        name: &str,
        req: &Value,
        blob: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<Value, String> {
        let pid = self.guest_pid.ok_or("guest not initialized")?;
        match name {
            "args_sizes_get" | "environ_sizes_get" => {
                let strings = if name == "args_sizes_get" {
                    &self.argv
                } else {
                    &self.environ
                };
                out.resize(8, 0);
                put32(out, 0, strings.len() as u32);
                put32(
                    out,
                    4,
                    strings.iter().map(|s| s.len() + 1).sum::<usize>() as u32,
                );
                Ok(json!(null))
            }
            "args_get" | "environ_get" => {
                let strings = if name == "args_get" {
                    &self.argv
                } else {
                    &self.environ
                };
                let mut offsets = vec![];
                for string in strings {
                    offsets.push(out.len());
                    out.extend_from_slice(string.as_bytes());
                    out.push(0);
                }
                Ok(json!({"offsets":offsets}))
            }
            "fd_prestat_get" | "fd_prestat_dir_name" => {
                let d = &self.fds[self.descriptor_index(num(req, "fd"))?];
                if !d.preopen {
                    return Err("bad descriptor".into());
                }
                if name == "fd_prestat_get" {
                    out.resize(8, 0);
                    put32(out, 4, d.path.len() as u32);
                } else {
                    out.extend_from_slice(d.path.as_bytes());
                }
                Ok(json!(null))
            }
            "fd_fdstat_get" => {
                let d = &self.fds[self.descriptor_index(num(req, "fd"))?];
                out.resize(24, 0);
                out[0] = if d.dir {
                    3
                } else if d.fd == 1 || d.fd == 2 {
                    2
                } else {
                    4
                };
                out[2..4].copy_from_slice(&d.flags.to_le_bytes());
                let rights = if d.dir {
                    (1u64 << 9)
                        | (1 << 10)
                        | (1 << 13)
                        | (1 << 14)
                        | (1 << 18)
                        | (1 << 21)
                        | (1 << 25)
                        | (1 << 26)
                } else {
                    (1 << 2)
                        | (1 << 5)
                        | (1 << 21)
                        | if d.mode.contains('r') { 2 } else { 0 }
                        | if d.mode.contains('w') {
                            64 | (1 << 22) | (1 << 8)
                        } else {
                            0
                        }
                };
                put64(out, 8, rights);
                put64(
                    out,
                    16,
                    if d.dir {
                        rights | 2 | 64 | (1 << 2) | (1 << 5) | (1 << 22) | (1 << 8)
                    } else {
                        0
                    },
                );
                Ok(json!(null))
            }
            "fd_read" | "fd_pread" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                let d = self.fds[i].clone();
                if d.dir || !d.mode.contains('r') {
                    return Err("bad descriptor".into());
                }
                let bytes = self.read(&d.path, true)?;
                let offset = if name == "fd_pread" {
                    index(req, "offset")?
                } else {
                    d.offset
                };
                let start = offset.min(bytes.len());
                let end = start
                    .saturating_add(num(req, "count") as usize)
                    .min(bytes.len());
                out.extend_from_slice(&bytes[start..end]);
                if name == "fd_read" {
                    self.fds[i].offset = offset + out.len();
                }
                Ok(json!({"count":out.len()}))
            }
            "fd_write" | "fd_pwrite" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                let d = self.fds[i].clone();
                if d.dir || !d.mode.contains('w') {
                    return Err("bad descriptor".into());
                }
                self.write_guard(&d.path)?;
                let offset = if name == "fd_pwrite" {
                    index(req, "offset")?
                } else if d.flags & 1 != 0 {
                    self.stat(&d.path)?.data.len()
                } else {
                    d.offset
                };
                let end = offset
                    .checked_add(blob.len())
                    .ok_or("file exceeds 8 MiB limit")?;
                let limit = if d.path == "/dev/stdout" || d.path == "/dev/stderr" {
                    1024 * 1024
                } else {
                    FILE_LIMIT
                };
                if end > limit {
                    return Err("file exceeds 8 MiB or 1 MiB output limit".into());
                }
                let mut bytes = self.stat(&d.path)?.data.clone();
                bytes.resize(bytes.len().max(end), 0);
                bytes[offset..end].copy_from_slice(blob);
                self.write(&d.path, &bytes, false, false)?;
                if name == "fd_write" {
                    self.fds[i].offset = end;
                }
                Ok(json!({"count":blob.len()}))
            }
            "fd_close" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                self.fds.remove(i);
                Ok(json!(null))
            }
            "fd_seek" | "fd_tell" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                let d = self.fds[i].clone();
                if d.dir {
                    return Err("bad descriptor".into());
                }
                if name == "fd_seek" {
                    let offset = text(req, "offset")
                        .parse::<i64>()
                        .map_err(|_| "invalid offset")?;
                    let base = match num(req, "whence") {
                        0 => 0,
                        1 => d.offset as i64,
                        2 => self.stat(&d.path)?.data.len() as i64,
                        _ => return Err("invalid whence".into()),
                    };
                    let value = base.checked_add(offset).ok_or("invalid offset")?;
                    if value < 0 {
                        return Err("invalid negative offset".into());
                    }
                    self.fds[i].offset =
                        usize::try_from(value).map_err(|_| "offset exceeds wasm32 range")?;
                }
                out.extend_from_slice(&(self.fds[i].offset as u64).to_le_bytes());
                Ok(json!(null))
            }
            "fd_filestat_get" => {
                let d = &self.fds[self.descriptor_index(num(req, "fd"))?];
                self.file_stat(&d.path, out)?;
                Ok(json!(null))
            }
            "fd_filestat_set_size" | "fd_allocate" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                let d = self.fds[i].clone();
                if !d.mode.contains('w') || d.dir {
                    return Err("bad descriptor".into());
                }
                self.write_guard(&d.path)?;
                let old = self.stat(&d.path)?.data.len();
                let size = if name == "fd_allocate" {
                    old.max(
                        (index(req, "offset")?)
                            .checked_add(index(req, "len")?)
                            .ok_or("file exceeds 8 MiB limit")?,
                    )
                } else {
                    index(req, "size")?
                };
                if size > FILE_LIMIT
                    || ((d.path == "/dev/stdout" || d.path == "/dev/stderr") && size > 1024 * 1024)
                {
                    return Err("file exceeds 8 MiB or 1 MiB output limit".into());
                }
                let mut bytes = self.stat(&d.path)?.data.clone();
                bytes.resize(size, 0);
                self.write(&d.path, &bytes, false, false)?;
                Ok(json!(null))
            }
            "fd_fdstat_set_flags" => {
                let i = self.descriptor_index(num(req, "fd"))?;
                self.fds[i].flags = num(req, "flags") as u16;
                Ok(json!(null))
            }
            "fd_sync" | "fd_datasync" | "fd_advise" => {
                self.descriptor_index(num(req, "fd"))?;
                Ok(json!(null))
            }
            "path_open" => {
                let p = self.relative_path(num(req, "dirfd"), text(req, "path"))?;
                let flags = num(req, "oflags");
                let rights = integer(req, "rights")?;
                let writable = rights & 64 != 0 || flags & 9 != 0;
                let readable = rights & 2 != 0 || rights == 0;
                if writable {
                    self.write_guard(&p)?;
                }
                if flags & 4 != 0 && self.files.contains_key(&p) {
                    return Err(format!("{p}: already exists"));
                }
                if !self.files.contains_key(&p) {
                    if flags & 1 == 0 {
                        return Err(format!("{p}: no such file"));
                    }
                    if flags & 2 != 0 {
                        self.mkdir(&p, false, false)?;
                    } else {
                        self.write(&p, &[], false, false)?;
                    }
                }
                let node = self.stat(&p)?;
                if flags & 2 != 0 && !node.dir {
                    return Err("not a directory".into());
                }
                let dir = node.dir;
                if flags & 8 != 0 {
                    if dir {
                        return Err("is a directory".into());
                    }
                    self.write(&p, &[], false, false)?;
                }
                if self.fds.len() >= 256 {
                    return Err("descriptor limit reached".into());
                }
                let fd = self.fds.iter().map(|d| d.fd).max().unwrap_or(4) + 1;
                let offset = if num(req, "fdflags") & 1 != 0 {
                    self.stat(&p)?.data.len()
                } else {
                    0
                };
                self.fds.push(Descriptor {
                    pid,
                    fd,
                    path: p,
                    mode: if writable && readable {
                        "rw"
                    } else if writable {
                        "w"
                    } else {
                        "r"
                    }
                    .into(),
                    offset,
                    flags: num(req, "fdflags") as u16,
                    dir,
                    preopen: false,
                });
                out.extend_from_slice(&fd.to_le_bytes());
                Ok(json!(null))
            }
            "path_filestat_get" => {
                let p = self.relative_path(num(req, "dirfd"), text(req, "path"))?;
                self.file_stat(&p, out)?;
                Ok(json!(null))
            }
            "path_create_directory" => {
                let p = self.relative_path(num(req, "dirfd"), text(req, "path"))?;
                self.mkdir(&p, false, false)?;
                Ok(json!(null))
            }
            "path_unlink_file" | "path_remove_directory" => {
                let p = self.relative_path(num(req, "dirfd"), text(req, "path"))?;
                let n = self.stat(&p)?;
                if name == "path_unlink_file" && n.dir {
                    return Err("is a directory".into());
                }
                if name == "path_remove_directory" && !n.dir {
                    return Err("not a directory".into());
                }
                self.remove(&p, false)?;
                Ok(json!(null))
            }
            "fd_readdir" => {
                let d = self.fds[self.descriptor_index(num(req, "fd"))?].clone();
                if !d.dir {
                    return Err("not a directory".into());
                }
                let mut entries = vec![
                    (".".to_string(), d.path.clone()),
                    ("..".to_string(), parent(&d.path).to_string()),
                ];
                entries.extend(
                    self.files
                        .keys()
                        .filter(|p| p.as_str() != d.path && parent(p) == d.path)
                        .map(|p| (p.rsplit('/').next().unwrap().to_string(), p.clone())),
                );
                let start = index(req, "cookie")?;
                let limit = num(req, "count") as usize;
                for (i, (name, p)) in entries.iter().enumerate().skip(start) {
                    let n = self.stat(p)?;
                    let mut header = [0u8; 24];
                    put64(&mut header, 0, (i + 1) as u64);
                    put64(&mut header, 8, n.ino);
                    put32(&mut header, 16, name.len() as u32);
                    header[20] = if n.dir { 3 } else { 4 };
                    out.extend_from_slice(&header);
                    out.extend_from_slice(name.as_bytes());
                    if out.len() >= limit {
                        out.truncate(limit);
                        break;
                    }
                }
                Ok(json!(null))
            }
            "clock_time_get" => {
                let id = num(req, "clock");
                if id > 1 {
                    return Err("unsupported clock".into());
                }
                out.extend_from_slice(
                    &((if id == 0 {
                        wall().floor()
                    } else {
                        now().floor()
                    }) as u64
                        * 1_000_000)
                        .to_le_bytes(),
                );
                Ok(json!(null))
            }
            "clock_res_get" => {
                if num(req, "clock") > 1 {
                    return Err("unsupported clock".into());
                }
                out.extend_from_slice(&1_000_000u64.to_le_bytes());
                Ok(json!(null))
            }
            "random_get" => {
                let len = num(req, "len") as usize;
                if len > 64 * 1024 * 1024 {
                    return Err("random buffer limit reached".into());
                }
                out.resize(len, 0);
                #[cfg(target_arch = "wasm32")]
                unsafe {
                    let code = random_fill(out.as_mut_ptr() as u32, len as u32);
                    if code != 0 {
                        return Err("random source unavailable".into());
                    }
                }
                Ok(json!(null))
            }
            "proc_exit" => {
                let code = num(req, "code") as i32;
                self.finish(pid, code, false)?;
                Ok(json!({"exitCode":code}))
            }
            _ => Err("unsupported WASI service".into()),
        }
    }
}
