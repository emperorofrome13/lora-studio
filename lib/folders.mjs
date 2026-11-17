// Choosing folders without typing paths.
//
// pickFolder(): opens the operating system's own folder picker on this computer
//   Windows: the Explorer-style "Select Folder" dialog (IFileOpenDialog)
//   macOS:   Finder's "choose folder" (osascript)
//   Linux:   zenity, or kdialog on KDE
// It answers { status: 'ok', folder } | { status: 'cancelled' } | { status: 'unavailable', reason }.
// When no native picker exists (e.g. Linux without zenity/kdialog, or no desktop session),
// the page falls back to listDir(), a small folder browser drawn inside the app.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OPEN_LIMIT_MS = 15 * 60 * 1000; // the person may browse for a while

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: OPEN_LIMIT_MS, maxBuffer: 1 << 20, encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: err && err.code === 'ENOENT', stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// ------------------------------------------------------------------ Windows
const WIN_PICKER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class LsFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCo {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c); void Unadvise(uint c);
    void SetOptions(uint o); void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem i); void SetFolder(IShellItem i);
    void GetFolder(out IShellItem i); void GetCurrentSelection(out IShellItem i);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem i);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem p);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);

  public static string Pick(string title, string start) {
    // An invisible always-on-top owner, so the dialog opens in front of the browser.
    var owner = new Form { TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None,
      StartPosition = FormStartPosition.CenterScreen, Width = 1, Height = 1, Opacity = 0 };
    owner.Show();
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    if (fg != me) AttachThreadInput(me, fg, true);
    BringWindowToTop(owner.Handle); SetForegroundWindow(owner.Handle);
    if (fg != me) AttachThreadInput(me, fg, false);
    var d = (IFileOpenDialog)new FileOpenDialogCo();
    try {
      d.SetOptions(0x20 | 0x40 | 0x800); // pick folders, real file-system folders only, must exist
      if (!String.IsNullOrEmpty(title)) d.SetTitle(title);
      d.SetOkButtonLabel("Select Folder");
      if (!String.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
        try { IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out si); d.SetFolder(si); } catch {}
      }
      if (d.Show(owner.Handle) != 0) return null; // cancelled or closed
      IShellItem r; d.GetResult(out r);
      string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
      return p;
    } finally { owner.Close(); Marshal.ReleaseComObject(d); }
  }
}`;

async function pickWindows(title, start) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'\n${WIN_PICKER}\n'@`,
    '$r = [LsFolderPicker]::Pick($env:LS_PICK_TITLE, $env:LS_PICK_START)',
    "if ($r) { [Console]::Out.Write('PICKED:' + $r) }",
  ].join('\n');
  // -EncodedCommand avoids every quoting problem; title and start folder travel as environment variables.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { LS_PICK_TITLE: title, LS_PICK_START: start });
  if (r.missing) return { status: 'unavailable', reason: 'PowerShell was not found.' };
  const m = /PICKED:(.+)$/s.exec(r.stdout.trim());
  if (m) return { status: 'ok', folder: m[1].trim() };
  if (r.code !== 0) return { status: 'unavailable', reason: (r.stderr.trim().split(/\r?\n/).find((l) => l.trim()) || 'The folder window could not be opened.').slice(0, 300) };
  return { status: 'cancelled' };
}

// ------------------------------------------------------------------ macOS
const MAC_SCRIPT = [
  'on run argv',
  '  set t to item 1 of argv',
  '  set s to item 2 of argv',
  '  set useFront to item 3 of argv',
  '  if useFront is "1" then',
  '    tell application "System Events"',
  '      activate',
  '      if s is "" then',
  '        set f to choose folder with prompt t',
  '      else',
  '        set f to choose folder with prompt t default location (POSIX file s)',
  '      end if',
  '    end tell',
  '  else',
  '    if s is "" then',
  '      set f to choose folder with prompt t',
  '    else',
  '      set f to choose folder with prompt t default location (POSIX file s)',
  '    end if',
  '  end if',
  '  return POSIX path of f',
  'end run',
];

async function pickMac(title, start) {
  const args = MAC_SCRIPT.flatMap((l) => ['-e', l]);
  let r = await run('osascript', [...args, title, start, '1']);
  // -1743: not allowed to control System Events. Ask without bringing it to the front instead.
  if (r.code !== 0 && /-1743/.test(r.stderr)) r = await run('osascript', [...args, title, start, '0']);
  if (r.missing) return { status: 'unavailable', reason: 'osascript was not found.' };
  if (r.code === 0 && r.stdout.trim()) return { status: 'ok', folder: r.stdout.trim().replace(/(.)\/$/, '$1') };
  if (/-128/.test(r.stderr)) return { status: 'cancelled' };
  return { status: 'unavailable', reason: r.stderr.trim().slice(0, 300) || 'The folder window could not be opened.' };
}

// ------------------------------------------------------------------ Linux
async function pickLinux(title, start) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { status: 'unavailable', reason: 'No desktop session was found for a folder window.' };
  const from = start ? `${start.replace(/\/$/, '')}/` : `${os.homedir()}/`;
  let r = await run('zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${from}`]);
  if (r.missing) r = await run('kdialog', ['--getexistingdirectory', start || os.homedir(), '--title', title]);
  if (r.missing) return { status: 'unavailable', reason: 'Neither zenity nor kdialog is installed.' };
  if (r.code === 0 && r.stdout.trim()) return { status: 'ok', folder: r.stdout.trim().split(/\r?\n/).pop() };
  if (r.code === 1) return { status: 'cancelled' };
  return { status: 'unavailable', reason: r.stderr.trim().slice(0, 300) || 'The folder window could not be opened.' };
}

let open = false;

/** Show the system folder picker. Only one at a time. */
export async function pickFolder({ title = 'Choose a folder', start = '' } = {}) {
  if (open) return { status: 'busy' };
  open = true;
  try {
    const t = String(title).slice(0, 120);
    let s = String(start || '').trim();
    if (s) s = await fs.stat(s).then((st) => (st.isDirectory() ? path.resolve(s) : ''), () => '');
    // LORA_STUDIO_FOLDER_PICKER=builtin always uses the in-app folder browser.
    if (String(process.env.LORA_STUDIO_FOLDER_PICKER || '').toLowerCase() === 'builtin') return { status: 'unavailable', reason: '' };
    if (process.platform === 'win32') return await pickWindows(t, s);
    if (process.platform === 'darwin') return await pickMac(t, s);
    return await pickLinux(t, s);
  } finally {
    open = false;
  }
}

// ------------------------------------------------------------------ in-app fallback browser
async function roots() {
  if (process.platform === 'win32') {
    const found = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const p = `${letter}:\\`;
      if (await fs.stat(p).then(() => true, () => false)) found.push({ name: `${letter}:`, path: p });
    }
    return [{ name: 'Home', path: os.homedir() }, ...found];
  }
  const list = [{ name: 'Home', path: os.homedir() }, { name: 'Computer (/)', path: '/' }];
  const mounts = process.platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media', path.join('/media', os.userInfo().username), path.join('/run/media', os.userInfo().username)];
  for (const m of mounts) {
    const names = await fs.readdir(m, { withFileTypes: true }).catch(() => []);
    for (const d of names) if (d.isDirectory() && !d.name.startsWith('.')) list.push({ name: d.name, path: path.join(m, d.name) });
  }
  return list;
}

/** Folders inside `dir` (or the drives / home / mounts when `dir` is empty). */
export async function listDir(dir) {
  const r = await roots();
  if (!dir) return { path: '', parent: null, dirs: r, roots: r };
  const full = path.resolve(String(dir));
  let entries;
  try { entries = await fs.readdir(full, { withFileTypes: true }); } catch (e) {
    throw Object.assign(new Error(e.code === 'EACCES' || e.code === 'EPERM' ? 'This folder cannot be opened (no permission).' : 'This folder does not exist.'), { status: 400 });
  }
  const dirs = entries
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !/^\$/.test(d.name) && d.name !== 'System Volume Information')
    .map((d) => ({ name: d.name, path: path.join(full, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 3000);
  const parent = path.dirname(full);
  return { path: full, parent: parent === full ? '' : parent, dirs, roots: r };
}
