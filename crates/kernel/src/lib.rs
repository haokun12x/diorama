//! Authoritative DIORAMA system state lives here, in Rust/WebAssembly linear memory.
//! JavaScript supplies browser clocks, UI, IndexedDB, and worker handles through a small ABI.
mod wasi;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};

const FILE_LIMIT: usize = 8 * 1024 * 1024;
const WORKSPACE_LIMIT: usize = 32 * 1024 * 1024;
const NODE_LIMIT: usize = 4096;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "diorama")]
extern "C" {
    fn clock_ms() -> f64;
    fn unix_ms() -> f64;
    fn random_fill(ptr: u32, len: u32) -> u32;
}
fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        unsafe { clock_ms() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs_f64()
            * 1000.0
    }
}
fn wall() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        unsafe { unix_ms() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0
    }
}
fn memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
fn path(input: &str) -> Result<String, String> {
    if input.len() > 4096 || input.contains('\0') {
        return Err("invalid or oversized path".into());
    }
    let mut parts = Vec::new();
    for p in input.split('/') {
        match p {
            "" | "." => (),
            ".." => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    if parts.len() > 256 {
        return Err("path has too many components".into());
    }
    Ok(format!("/{}", parts.join("/")))
}
fn parent(p: &str) -> &str {
    p.rsplit_once('/')
        .map(|(a, _)| if a.is_empty() { "/" } else { a })
        .unwrap_or("/")
}
fn is_proc(p: &str) -> bool {
    p == "/proc" || p.starts_with("/proc/")
}
fn guard(p: &str) -> Result<(), String> {
    if is_proc(p) {
        Err(format!("{p}: read-only virtual mount"))
    } else {
        Ok(())
    }
}
fn text<'a>(v: &'a Value, name: &str) -> &'a str {
    v.get(name).and_then(Value::as_str).unwrap_or("")
}
fn num(v: &Value, name: &str) -> u32 {
    v.get(name).and_then(Value::as_u64).unwrap_or(0) as u32
}
fn yes(v: &Value, name: &str) -> bool {
    v.get(name).and_then(Value::as_bool).unwrap_or(false)
}

#[derive(Clone)]
struct Node {
    dir: bool,
    data: Vec<u8>,
    mtime: f64,
    ino: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    pid: u32,
    ppid: u32,
    name: String,
    kind: String,
    state: String,
    created: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    memory_bytes: usize,
}
#[derive(Clone, Serialize, Deserialize)]
struct Descriptor {
    pid: u32,
    fd: u32,
    path: String,
    mode: String,
    offset: usize,
    #[serde(default)]
    flags: u16,
    #[serde(default)]
    dir: bool,
    #[serde(default)]
    preopen: bool,
}
#[derive(Clone, Serialize)]
struct Event {
    id: u32,
    time: f64,
    pid: u32,
    layer: String,
    op: String,
    args: String,
    result: String,
    duration: f64,
}
#[derive(Serialize, Deserialize)]
struct SnapshotNode {
    path: String,
    kind: String,
    mtime: f64,
    offset: usize,
    len: usize,
}

struct Kernel {
    files: BTreeMap<String, Node>,
    tasks: BTreeMap<u32, Task>,
    fds: Vec<Descriptor>,
    events: VecDeque<Event>,
    next_pid: u32,
    next_event: u32,
    started: f64,
    caller: u32,
    fs_revision: u32,
    max_bytes: usize,
    calls: u64,
    proc_mounted: bool,
    next_inode: u64,
    guest_pid: Option<u32>,
    argv: Vec<String>,
    environ: Vec<String>,
}
impl Kernel {
    fn new() -> Self {
        let t = now();
        let task = Task {
            pid: 1,
            ppid: 0,
            name: "visitor shell".into(),
            kind: "shell".into(),
            state: "waiting".into(),
            created: t,
            ended: None,
            exit_code: None,
            memory_bytes: 0,
        };
        let mut files = BTreeMap::new();
        files.insert(
            "/".into(),
            Node {
                dir: true,
                data: vec![],
                mtime: wall(),
                ino: 1,
            },
        );
        Self {
            files,
            tasks: BTreeMap::from([(1, task)]),
            fds: Self::stdio(1),
            events: VecDeque::new(),
            next_pid: 2,
            next_event: 1,
            started: t,
            caller: 1,
            fs_revision: 0,
            max_bytes: WORKSPACE_LIMIT,
            calls: 0,
            proc_mounted: false,
            next_inode: 2,
            guest_pid: None,
            argv: vec![],
            environ: vec![],
        }
    }
    fn stdio(pid: u32) -> Vec<Descriptor> {
        ["in", "out", "err"]
            .iter()
            .enumerate()
            .map(|(fd, suffix)| Descriptor {
                pid,
                fd: fd as u32,
                path: format!("/dev/std{suffix}"),
                mode: if fd == 0 { "r" } else { "w" }.into(),
                offset: 0,
                flags: 0,
                dir: false,
                preopen: false,
            })
            .collect()
    }
    fn bytes(&self) -> usize {
        self.files.values().map(|n| n.data.len()).sum()
    }
    fn trace(&mut self, pid: u32, layer: &str, op: &str, args: &str, result: &str, duration: f64) {
        self.events.push_back(Event {
            id: self.next_event,
            time: now() - self.started,
            pid,
            layer: layer.into(),
            op: op.into(),
            args: args.chars().take(300).collect(),
            result: result.chars().take(500).collect(),
            duration,
        });
        self.next_event += 1;
        if self.events.len() > 500 {
            self.events.pop_front();
        }
    }
    fn fs_event(&mut self, op: &str, args: &str, result: &str, began: f64) {
        self.trace(self.caller, "filesystem", op, args, result, now() - began);
    }
    fn stat(&self, p: &str) -> Result<&Node, String> {
        self.files
            .get(p)
            .ok_or_else(|| format!("{p}: no such file or directory"))
    }
    fn mkdir(&mut self, p: &str, recursive: bool, internal: bool) -> Result<(), String> {
        let began = now();
        if !internal {
            self.write_guard(p)?;
        }
        if let Some(n) = self.files.get(p) {
            return if recursive && n.dir {
                Ok(())
            } else {
                Err(format!("{p}: already exists"))
            };
        }
        if !self.files.contains_key(parent(p)) {
            if !recursive {
                return Err(format!("{}: no such directory", parent(p)));
            }
            self.mkdir(parent(p), true, internal)?;
        }
        if !self.stat(parent(p))?.dir {
            return Err("parent is not a directory".into());
        }
        if self.files.len() >= NODE_LIMIT {
            return Err("filesystem node limit reached".into());
        }
        let ino = self.next_inode;
        self.next_inode += 1;
        self.files.insert(
            p.into(),
            Node {
                dir: true,
                data: vec![],
                mtime: wall(),
                ino,
            },
        );
        self.fs_revision += 1;
        self.fs_event("fs.mkdir", p, "0", began);
        Ok(())
    }
    fn write(&mut self, p: &str, bytes: &[u8], append: bool, internal: bool) -> Result<(), String> {
        let began = now();
        if !internal {
            self.write_guard(p)?;
        }
        if !self.stat(parent(p))?.dir {
            return Err("parent is not a directory".into());
        }
        let old = self.files.get(p);
        if old.map(|n| n.dir).unwrap_or(false) {
            return Err(format!("{p}: is a directory"));
        }
        let prior = old.map(|n| n.data.len()).unwrap_or(0);
        let size = if append {
            prior.checked_add(bytes.len()).ok_or("file exceeds limit")?
        } else {
            bytes.len()
        };
        if size > FILE_LIMIT {
            return Err("file exceeds 8 MiB limit".into());
        }
        if self.bytes() - prior + size > self.max_bytes {
            return Err("workspace exceeds 32 MiB limit".into());
        }
        if old.is_none() && self.files.len() >= NODE_LIMIT {
            return Err("filesystem node limit reached".into());
        }
        let mut data = if append {
            old.map(|n| n.data.clone()).unwrap_or_default()
        } else {
            Vec::new()
        };
        data.extend_from_slice(bytes);
        let ino = old.map(|n| n.ino).unwrap_or_else(|| {
            let ino = self.next_inode;
            self.next_inode += 1;
            ino
        });
        self.files.insert(
            p.into(),
            Node {
                dir: false,
                data,
                mtime: wall(),
                ino,
            },
        );
        self.fs_revision += 1;
        self.fs_event(
            "fs.write",
            &format!("{p}, {size} bytes"),
            &size.to_string(),
            began,
        );
        Ok(())
    }
    fn proc_read(&self, p: &str) -> Option<Vec<u8>> {
        if !self.proc_mounted {
            return None;
        }
        match p {
            "/proc/tasks" => Some(format!("{}\n", serde_json::to_string_pretty(&self.tasks.values().collect::<Vec<_>>()).unwrap()).into_bytes()),
            "/proc/mounts" => Some(b"/  diorama-rust-wasm-memfs  rw\n/proc  dynamic-wasm-runtime  ro\n".to_vec()),
            "/proc/runtime" => Some(format!("{}\n", serde_json::to_string_pretty(&json!({"kernel":"DIORAMA Rust/WASM 0.1", "kernelExecution":"WebAssembly", "architecture":"wasm32 kernel / WASI preview1 guests", "uptimeMs":now()-self.started, "filesystemBytes":self.bytes(), "taskCount":self.tasks.len(), "kernelLinearMemoryBytes":memory_bytes(), "nativeCalls":self.calls, "sharedArrayBufferRequired":false})).unwrap()).into_bytes()),
            _ => None,
        }
    }
    fn read(&mut self, p: &str, traced: bool) -> Result<Vec<u8>, String> {
        let began = now();
        let n = self.stat(p)?;
        if n.dir {
            return Err(format!("{p}: is a directory"));
        }
        let bytes = self.proc_read(p).unwrap_or_else(|| n.data.clone());
        if traced {
            self.fs_event("fs.read", p, &bytes.len().to_string(), began);
        }
        Ok(bytes)
    }
    fn remove(&mut self, p: &str, recursive: bool) -> Result<(), String> {
        let began = now();
        self.write_guard(p)?;
        if p == "/" {
            return Err("cannot remove root".into());
        }
        let n = self.stat(p)?;
        let children: Vec<String> = self
            .files
            .keys()
            .filter(|k| k.starts_with(&format!("{p}/")))
            .cloned()
            .collect();
        if n.dir && !recursive && !children.is_empty() {
            return Err(format!("{p}: directory not empty"));
        }
        self.files.remove(p);
        for child in children {
            self.files.remove(&child);
        }
        self.fs_revision += 1;
        self.fs_event("fs.unlink", p, "0", began);
        Ok(())
    }
    fn copy(&mut self, a: &str, b: &str, recursive: bool) -> Result<(), String> {
        if a == b || b.starts_with(&format!("{a}/")) {
            return Err("cannot copy a path into itself".into());
        }
        if !self.stat(a)?.dir {
            let data = self.read(a, true)?;
            return self.write(b, &data, false, false);
        }
        if !recursive {
            return Err("directory copy needs -r".into());
        }
        self.mkdir(b, true, false)?;
        let children: Vec<String> = self
            .files
            .keys()
            .filter(|p| p.as_str() != a && parent(p) == a)
            .cloned()
            .collect();
        for child in children {
            let name = child.rsplit('/').next().unwrap();
            self.copy(&child, &format!("{b}/{name}"), true)?;
        }
        Ok(())
    }
    fn snapshot(&self, include_proc: bool) -> (Vec<SnapshotNode>, Vec<u8>) {
        let mut data = Vec::new();
        let mut nodes = Vec::new();
        for (p, n) in &self.files {
            if !include_proc && is_proc(p) {
                continue;
            }
            nodes.push(SnapshotNode {
                path: p.clone(),
                kind: if n.dir { "dir" } else { "file" }.into(),
                mtime: n.mtime,
                offset: data.len(),
                len: n.data.len(),
            });
            data.extend_from_slice(&n.data);
        }
        (nodes, data)
    }
    fn restore(&mut self, nodes: Vec<SnapshotNode>, bytes: &[u8]) -> Result<(), String> {
        let mut next = BTreeMap::new();
        let mut total = 0usize;
        if nodes.len() > NODE_LIMIT {
            return Err("snapshot node limit reached".into());
        }
        for n in nodes {
            if path(&n.path)? != n.path {
                return Err("invalid snapshot path".into());
            }
            if is_proc(&n.path) {
                continue;
            }
            let end = n
                .offset
                .checked_add(n.len)
                .ok_or("invalid snapshot bounds")?;
            if end > bytes.len() || n.len > FILE_LIMIT {
                return Err("invalid snapshot bounds".into());
            }
            if !["file", "dir"].contains(&n.kind.as_str()) {
                return Err("invalid snapshot kind".into());
            }
            total += n.len;
            if total > self.max_bytes {
                return Err("snapshot exceeds limit".into());
            }
            next.insert(
                n.path,
                Node {
                    dir: n.kind == "dir",
                    data: if n.kind == "file" {
                        bytes[n.offset..end].to_vec()
                    } else {
                        vec![]
                    },
                    mtime: n.mtime,
                    ino: {
                        let ino = self.next_inode;
                        self.next_inode += 1;
                        ino
                    },
                },
            );
        }
        if !next.get("/").map(|n| n.dir).unwrap_or(false) {
            return Err("snapshot needs root".into());
        }
        for p in next.keys() {
            if p != "/" && !next.get(parent(p)).map(|n| n.dir).unwrap_or(false) {
                return Err("snapshot parent missing".into());
            }
        }
        for (p, n) in &self.files {
            if is_proc(p) {
                next.insert(p.clone(), n.clone());
            }
        }
        self.files = next;
        self.fs_revision += 1;
        Ok(())
    }
    fn active(&self, pid: u32) -> Result<(), String> {
        if self
            .tasks
            .get(&pid)
            .map(|t| t.ended.is_none())
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(format!("{pid}: no active task"))
        }
    }
    fn finish(&mut self, pid: u32, code: i32, cancelled: bool) -> Result<(), String> {
        let task = self.tasks.get_mut(&pid).ok_or("unknown task")?;
        if task.ended.is_some() {
            return Ok(());
        }
        let t = now();
        task.state = if cancelled { "cancelled" } else { "terminated" }.into();
        task.ended = Some(t);
        task.exit_code = Some(code);
        let name = task.name.clone();
        let duration = t - task.created;
        self.fds.retain(|fd| fd.pid != pid);
        self.trace(
            pid,
            "kernel",
            "task.exit",
            &name,
            &code.to_string(),
            duration,
        );
        Ok(())
    }
    fn cancel(&mut self, pid: u32, affected: &mut Vec<u32>) -> Result<(), String> {
        if pid == 1 {
            return Err(format!("{pid}: no cancellable task"));
        }
        self.active(pid)
            .map_err(|_| format!("{pid}: no cancellable task"))?;
        let children: Vec<u32> = self
            .tasks
            .values()
            .filter(|t| t.ppid == pid && t.ended.is_none())
            .map(|t| t.pid)
            .collect();
        for child in children {
            self.cancel(child, affected)?;
        }
        self.finish(pid, 130, true)?;
        affected.push(pid);
        Ok(())
    }
    fn dispatch(&mut self, req: &Value, blob: &[u8], out: &mut Vec<u8>) -> Result<Value, String> {
        self.calls += 1;
        let op = text(req, "op");
        if op.starts_with("wasi.") {
            return self.wasi(req, blob, out);
        }
        if op == "guest.init" {
            return self.guest_init(req, blob);
        }
        let op = text(req, "op");
        let p = || path(text(req, "path"));
        match op {
            "kernel.info" => Ok(
                json!({"execution":"WebAssembly", "language":"Rust", "abi":1, "started":self.started,"calls":self.calls,"linearMemoryBytes":memory_bytes(),"taskCount":self.tasks.len(),"filesystemBytes":self.bytes()}),
            ),
            "kernel.caller" => {
                self.caller = num(req, "pid");
                Ok(json!(null))
            }
            "trace.list" => Ok(json!(self.events)),
            "trace.clear" => {
                self.events.clear();
                Ok(json!(null))
            }
            "trace.add" => {
                self.trace(
                    num(req, "pid"),
                    text(req, "layer"),
                    text(req, "name"),
                    text(req, "args"),
                    text(req, "result"),
                    req["duration"].as_f64().unwrap_or(0.0),
                );
                Ok(json!(null))
            }
            "fs.version" => Ok(json!(self.fs_revision)),
            "fs.limit" => {
                self.max_bytes = (num(req, "bytes") as usize).min(WORKSPACE_LIMIT);
                Ok(json!(null))
            }
            "fs.bytes" => Ok(json!(self.bytes())),
            "fs.exists" => Ok(json!(self.files.contains_key(&p()?))),
            "fs.stat" => {
                let path = p()?;
                let n = self.stat(&path)?;
                Ok(json!({"kind":if n.dir {"dir"}else{"file"},"mtime":n.mtime,"size":n.data.len()}))
            }
            "fs.mkdir" => {
                self.mkdir(&p()?, yes(req, "recursive"), yes(req, "internal"))?;
                Ok(json!(null))
            }
            "fs.write" => {
                self.write(&p()?, blob, yes(req, "append"), yes(req, "internal"))?;
                Ok(json!(null))
            }
            "fs.read" | "fs.peek" => {
                *out = self.read(&p()?, op == "fs.read")?;
                Ok(json!(null))
            }
            "fs.list" => {
                let began = now();
                let path = p()?;
                if !self.stat(&path)?.dir {
                    return Err(format!("{path}: not a directory"));
                }
                let list: Vec<_> = self
                    .files
                    .keys()
                    .filter(|k| k.as_str() != path && parent(k) == path)
                    .cloned()
                    .collect();
                self.fs_event("fs.readdir", &path, "0", began);
                Ok(json!(list))
            }
            "fs.remove" => {
                self.remove(&p()?, yes(req, "recursive"))?;
                Ok(json!(null))
            }
            "fs.copy" => {
                self.copy(
                    &path(text(req, "from"))?,
                    &path(text(req, "to"))?,
                    yes(req, "recursive"),
                )?;
                Ok(json!(null))
            }
            "fs.move" => {
                let a = path(text(req, "from"))?;
                let b = path(text(req, "to"))?;
                guard(&a)?;
                guard(&b)?;
                let saved = self.files.clone();
                let r = self.copy(&a, &b, true).and_then(|_| self.remove(&a, true));
                if let Err(e) = r {
                    self.files = saved;
                    return Err(e);
                }
                self.fs_event("fs.rename", &format!("{a} → {b}"), "0", now());
                Ok(json!(null))
            }
            "fs.snapshot" | "fs.inventory" => {
                let (nodes, data) = self.snapshot(op == "fs.inventory");
                *out = data;
                Ok(json!(nodes))
            }
            "fs.restore" => {
                let nodes = serde_json::from_value(req["nodes"].clone())
                    .map_err(|_| "invalid snapshot metadata")?;
                self.restore(nodes, blob)?;
                Ok(json!(null))
            }
            "proc.mount" => {
                self.mkdir("/proc", true, true)?;
                for name in ["tasks", "mounts", "runtime"] {
                    self.write(&format!("/proc/{name}"), &[], false, true)?;
                }
                self.proc_mounted = true;
                Ok(json!(null))
            }
            "task.list" => Ok(json!(self.tasks.values().collect::<Vec<_>>())),
            "task.spawn" => {
                let ppid = num(req, "ppid");
                self.active(ppid)?;
                while self.tasks.len() >= 128 {
                    let dead = self
                        .tasks
                        .values()
                        .find(|t| t.ended.is_some())
                        .map(|t| t.pid);
                    if let Some(pid) = dead {
                        self.tasks.remove(&pid);
                    } else {
                        return Err("active task limit reached".into());
                    }
                }
                let pid = self.next_pid;
                self.next_pid = self.next_pid.checked_add(1).ok_or("PID exhausted")?;
                let task = Task {
                    pid,
                    ppid,
                    name: text(req, "name").chars().take(256).collect(),
                    kind: text(req, "kind").into(),
                    state: "runnable".into(),
                    created: now(),
                    ended: None,
                    exit_code: None,
                    memory_bytes: 0,
                };
                self.tasks.insert(pid, task.clone());
                self.fds.extend(Self::stdio(pid));
                self.trace(
                    pid,
                    "kernel",
                    "task.spawn",
                    &format!("{}, parent={ppid}", task.name),
                    "runnable",
                    0.0,
                );
                Ok(json!(task))
            }
            "task.state" => {
                let pid = num(req, "pid");
                let state = text(req, "state");
                if !["runnable", "running", "waiting"].contains(&state) {
                    return Err("invalid active task state".into());
                }
                self.active(pid)?;
                let t = self.tasks.get_mut(&pid).unwrap();
                t.state = state.into();
                let name = t.name.clone();
                self.trace(pid, "scheduler", "task.state", &name, state, 0.0);
                Ok(json!(null))
            }
            "task.finish" => {
                self.finish(
                    num(req, "pid"),
                    req["code"].as_i64().unwrap_or(0) as i32,
                    yes(req, "cancelled"),
                )?;
                Ok(json!(null))
            }
            "task.cancel" => {
                let mut pids = Vec::new();
                self.cancel(num(req, "pid"), &mut pids)?;
                Ok(json!(pids))
            }
            "task.memory" => {
                let pid = num(req, "pid");
                let t = self.tasks.get_mut(&pid).ok_or("unknown task")?;
                t.memory_bytes = req["bytes"].as_u64().unwrap_or(0) as usize;
                Ok(json!(null))
            }
            "fd.list" => Ok(json!(self.fds)),
            "fd.replace" => {
                let fds: Vec<Descriptor> =
                    serde_json::from_value(req["fds"].clone()).map_err(|_| "invalid fd table")?;
                for fd in &fds {
                    self.active(fd.pid)?;
                    if !["r", "w", "rw"].contains(&fd.mode.as_str()) {
                        return Err("invalid descriptor mode".into());
                    }
                }
                self.fds = fds;
                Ok(json!(null))
            }
            "fd.open" => {
                let pid = num(req, "pid");
                self.active(pid)?;
                let path = p()?;
                let mode = text(req, "mode");
                if !["r", "w", "rw"].contains(&mode) {
                    return Err("invalid descriptor mode".into());
                }
                if mode == "r" {
                    self.stat(&path)?;
                }
                let fd = self
                    .fds
                    .iter()
                    .filter(|d| d.pid == pid)
                    .map(|d| d.fd)
                    .max()
                    .unwrap_or(2)
                    + 1;
                self.fds.push(Descriptor {
                    pid,
                    fd,
                    path: path.clone(),
                    mode: mode.into(),
                    offset: 0,
                    flags: 0,
                    dir: false,
                    preopen: false,
                });
                self.trace(
                    pid,
                    "kernel",
                    "fd.open",
                    &format!("{path}, {mode}"),
                    &fd.to_string(),
                    0.0,
                );
                Ok(json!(fd))
            }
            "fd.read" => {
                let pid = num(req, "pid");
                let fd = num(req, "fd");
                let index = self
                    .fds
                    .iter()
                    .position(|d| d.pid == pid && d.fd == fd && d.mode != "w")
                    .ok_or("bad descriptor")?;
                let d = self.fds[index].clone();
                let bytes = self.read(&d.path, true)?;
                let start = d.offset.min(bytes.len());
                let end = start
                    .saturating_add(num(req, "count") as usize)
                    .min(bytes.len());
                *out = bytes[start..end].to_vec();
                self.fds[index].offset += out.len();
                self.trace(
                    pid,
                    "kernel",
                    "fd.read",
                    &fd.to_string(),
                    &out.len().to_string(),
                    0.0,
                );
                Ok(json!(null))
            }
            "fd.write" => {
                let pid = num(req, "pid");
                let fd = num(req, "fd");
                let index = self
                    .fds
                    .iter()
                    .position(|d| d.pid == pid && d.fd == fd && d.mode != "r")
                    .ok_or("bad descriptor")?;
                let d = self.fds[index].clone();
                let size = d
                    .offset
                    .checked_add(blob.len())
                    .ok_or("file exceeds limit")?;
                if size > FILE_LIMIT {
                    return Err("file exceeds 8 MiB limit".into());
                }
                let mut bytes = self
                    .files
                    .get(&d.path)
                    .map(|n| n.data.clone())
                    .unwrap_or_default();
                bytes.resize(bytes.len().max(size), 0);
                bytes[d.offset..size].copy_from_slice(blob);
                self.write(&d.path, &bytes, false, false)?;
                self.fds[index].offset = size;
                self.trace(
                    pid,
                    "kernel",
                    "fd.write",
                    &fd.to_string(),
                    &blob.len().to_string(),
                    0.0,
                );
                Ok(json!(null))
            }
            "fd.close" => {
                let pid = num(req, "pid");
                let fd = num(req, "fd");
                let index = self
                    .fds
                    .iter()
                    .position(|d| d.pid == pid && d.fd == fd)
                    .ok_or("bad descriptor")?;
                self.fds.remove(index);
                self.trace(pid, "kernel", "fd.close", &fd.to_string(), "0", 0.0);
                Ok(json!(null))
            }
            _ => Err(format!("unknown kernel operation: {op}")),
        }
    }
}
thread_local! {
    static STATE: RefCell<Kernel> = RefCell::new(Kernel::new());
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static DATA: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
#[no_mangle]
pub extern "C" fn kernel_abi_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn kernel_alloc(len: u32) -> u32 {
    Box::into_raw(vec![0u8; len as usize].into_boxed_slice()) as *mut u8 as u32
}
#[no_mangle]
pub unsafe extern "C" fn kernel_dealloc(ptr: u32, len: u32) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        ptr as *mut u8,
        len as usize,
    )));
}
#[no_mangle]
pub unsafe extern "C" fn kernel_call(ptr: u32, len: u32, blob_ptr: u32, blob_len: u32) {
    let request = std::slice::from_raw_parts(ptr as *const u8, len as usize);
    let blob = std::slice::from_raw_parts(blob_ptr as *const u8, blob_len as usize);
    let mut data = Vec::new();
    let response = match serde_json::from_slice::<Value>(request) {
        Ok(req) => STATE.with(|cell| { let mut kernel=cell.borrow_mut();let before=kernel.next_event;match kernel.dispatch(&req,blob,&mut data) { Ok(value)=>json!({"ok":true,"value":value,"events":kernel.events.iter().filter(|e|e.id>=before).collect::<Vec<_>>()}),Err(error)=>json!({"ok":false,"error":error}) } }),
        Err(error) => json!({"ok":false,"error":format!("invalid request: {error}")}),
    };
    RESPONSE.with(|r| *r.borrow_mut() = serde_json::to_vec(&response).unwrap());
    DATA.with(|d| *d.borrow_mut() = data);
}
#[no_mangle]
pub extern "C" fn kernel_response_ptr() -> u32 {
    RESPONSE.with(|r| r.borrow().as_ptr() as u32)
}
#[no_mangle]
pub extern "C" fn kernel_response_len() -> u32 {
    RESPONSE.with(|r| r.borrow().len() as u32)
}
#[no_mangle]
pub extern "C" fn kernel_data_ptr() -> u32 {
    DATA.with(|r| r.borrow().as_ptr() as u32)
}
#[no_mangle]
pub extern "C" fn kernel_data_len() -> u32 {
    DATA.with(|r| r.borrow().len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_restore_rejects_orphans() {
        let mut k = Kernel::new();
        k.mkdir("/tmp", true, false).unwrap();
        k.write("/tmp/a", b"safe", false, false).unwrap();
        let bad = vec![
            SnapshotNode {
                path: "/".into(),
                kind: "dir".into(),
                mtime: 0.,
                offset: 0,
                len: 0,
            },
            SnapshotNode {
                path: "/missing/a".into(),
                kind: "file".into(),
                mtime: 0.,
                offset: 0,
                len: 0,
            },
        ];
        assert!(k.restore(bad, &[]).is_err());
        assert_eq!(k.read("/tmp/a", false).unwrap(), b"safe");
    }
    #[test]
    fn real_task_cancel_cascades_and_closes_fds() {
        let mut k = Kernel::new();
        let mut out = vec![];
        let p = k
            .dispatch(
                &json!({"op":"task.spawn","ppid":1,"name":"parent","kind":"test"}),
                &[],
                &mut out,
            )
            .unwrap()["pid"]
            .as_u64()
            .unwrap() as u32;
        let child = k
            .dispatch(
                &json!({"op":"task.spawn","ppid":p,"name":"child","kind":"worker"}),
                &[],
                &mut out,
            )
            .unwrap()["pid"]
            .as_u64()
            .unwrap() as u32;
        let mut affected = vec![];
        k.cancel(p, &mut affected).unwrap();
        assert_eq!(affected, vec![child, p]);
        assert!(k.fds.iter().all(|fd| fd.pid == 1));
        assert_eq!(k.tasks[&child].exit_code, Some(130));
    }
    #[test]
    fn read_only_mount_and_resource_limits_are_native() {
        let mut k = Kernel::new();
        k.mkdir("/proc", true, true).unwrap();
        assert!(k.write("/proc/x", b"x", false, false).is_err());
        k.mkdir("/tmp", true, false).unwrap();
        k.max_bytes = 4;
        assert!(k.write("/tmp/x", b"12345", false, false).is_err());
        assert!(k.files.get("/tmp/x").is_none());
    }
}
