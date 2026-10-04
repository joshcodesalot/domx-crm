const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = process.env.BROWSER_HOST_FILES || '/home/debian/Downloads';
const PORTAL_FEATURE = 'XdgFileChooserPortal';

const SYSTEM_DIRS = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/opt', '/etc', '/sys'];

let cachedSupport = null;

function commandExists(name) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    return fs.existsSync(path.join(dir, name));
  });
}

function ensureDownloadsDir(dir = DOWNLOADS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pinDownloadDirectory(userDataDir, downloadsDir = DOWNLOADS_DIR) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed;
    } catch {
      prefs = {};
    }
  }
  const download = prefs.download && typeof prefs.download === 'object' && !Array.isArray(prefs.download)
    ? prefs.download
    : {};
  const savefile = prefs.savefile && typeof prefs.savefile === 'object' && !Array.isArray(prefs.savefile)
    ? prefs.savefile
    : {};
  const selectfile = prefs.selectfile && typeof prefs.selectfile === 'object' && !Array.isArray(prefs.selectfile)
    ? prefs.selectfile
    : {};
  prefs.download = {
    ...download,
    default_directory: downloadsDir,
    directory_upgrade: true,
  };
  prefs.savefile = { ...savefile, default_directory: downloadsDir };
  prefs.selectfile = { ...selectfile, last_directory: downloadsDir };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

function writeUserDirs(userDataDir, downloadsDir = DOWNLOADS_DIR) {
  const configDir = path.join(userDataDir, '.domx-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(userDataDir, '.domx-cache'), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, '.domx-data'), { recursive: true });
  const names = [
    'XDG_DESKTOP_DIR',
    'XDG_DOWNLOAD_DIR',
    'XDG_TEMPLATES_DIR',
    'XDG_PUBLICSHARE_DIR',
    'XDG_DOCUMENTS_DIR',
    'XDG_MUSIC_DIR',
    'XDG_PICTURES_DIR',
    'XDG_VIDEOS_DIR',
  ];
  const body = names.map((name) => `${name}="${downloadsDir}"`).join('\n');
  fs.writeFileSync(path.join(configDir, 'user-dirs.dirs'), `${body}\n`);
  return configDir;
}

function withPortalDisabled(chromeArgs) {
  const prefix = '--disable-features=';
  const index = chromeArgs.findIndex((arg) => arg.startsWith(prefix));
  if (index === -1) return [...chromeArgs, `${prefix}${PORTAL_FEATURE}`];
  const names = chromeArgs[index].slice(prefix.length).split(',').filter(Boolean);
  if (!names.includes(PORTAL_FEATURE)) names.push(PORTAL_FEATURE);
  const next = chromeArgs.slice();
  next[index] = `${prefix}${names.join(',')}`;
  return next;
}

function parentDirs(dir) {
  const chain = [];
  let current = path.posix.dirname(path.posix.resolve(dir));
  while (current && current !== '/' && current !== '.') {
    chain.push(current);
    current = path.posix.dirname(current);
  }
  return chain;
}

function pushBind(args, source, dest, { chmod, mode }) {
  args.push(chmod ? '--bind' : '--ro-bind', source, dest);
  if (chmod) args.push('--chmod', mode, dest);
}

function buildBwrapArgs({
  executable,
  chromeArgs,
  userDataDir,
  downloadsDir = DOWNLOADS_DIR,
  systemDirs = SYSTEM_DIRS,
  systemSymlinks = [],
  chmod = false,
  x11Dir = '/tmp/.X11-unix',
}) {
  const configDir = `${userDataDir}/.domx-config`;
  const cacheDir = `${userDataDir}/.domx-cache`;
  const dataDir = `${userDataDir}/.domx-data`;
  const args = ['--die-with-parent'];

  for (const dir of systemDirs) {
    pushBind(args, dir, dir, { chmod, mode: '0511' });
  }
  for (const link of systemSymlinks) {
    args.push('--symlink', link.target, link.path);
  }

  args.push('--dev', '/dev', '--proc', '/proc');
  args.push('--tmpfs', '/tmp');
  if (chmod) args.push('--chmod', '0711', '/tmp');
  args.push('--bind', x11Dir, x11Dir);

  args.push('--tmpfs', '/home', '--dir', '/home/debian');
  if (chmod) args.push('--chmod', '0511', '/home');
  args.push('--bind', downloadsDir, '/home/debian/Downloads');

  args.push('--bind', userDataDir, userDataDir);
  if (chmod) {
    args.push('--chmod', '0511', '/');
    for (const dir of parentDirs(userDataDir)) {
      if (dir !== '/tmp' && dir !== '/home' && dir !== '/home/debian') {
        args.push('--chmod', '0511', dir);
      }
    }
  }

  args.push(
    '--chdir', '/home/debian/Downloads',
    '--setenv', 'HOME', '/home/debian',
    '--setenv', 'XDG_CONFIG_HOME', configDir,
    '--setenv', 'XDG_CACHE_HOME', cacheDir,
    '--setenv', 'XDG_DATA_HOME', dataDir,
    '--setenv', 'GTK_USE_PORTAL', '0',
    '--',
    executable,
    ...withPortalDisabled(chromeArgs)
  );
  return args;
}

function hostSystemMounts() {
  const dirs = [];
  const symlinks = [];
  for (const dir of SYSTEM_DIRS) {
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        symlinks.push({ path: dir, target: fs.readlinkSync(dir) });
      } else if (stat.isDirectory()) {
        dirs.push(dir);
      }
    } catch {
      // This path is not on the host.
    }
  }
  return { dirs, symlinks };
}

function probeBwrapArgs({ systemDirs, systemSymlinks, chmod = false }) {
  const args = ['--die-with-parent'];
  for (const dir of systemDirs) {
    args.push(chmod ? '--bind' : '--ro-bind', dir, dir);
  }
  for (const link of systemSymlinks) {
    args.push('--symlink', link.target, link.path);
  }
  if (chmod && systemDirs.includes('/usr')) {
    args.push('--chmod', '0511', '/usr');
  }
  args.push('--', '/usr/bin/true');
  return args;
}

function probeBwrap() {
  if (cachedSupport) return cachedSupport;
  if (!commandExists('bwrap')) {
    cachedSupport = { ok: false, chmod: false };
    return cachedSupport;
  }
  const mounts = hostSystemMounts();
  const probeMounts = { systemDirs: mounts.dirs, systemSymlinks: mounts.symlinks };
  const chmodProbe = spawnSync('bwrap', probeBwrapArgs({ ...probeMounts, chmod: true }), { timeout: 8000 });
  if (chmodProbe.status === 0) {
    cachedSupport = { ok: true, chmod: true };
    return cachedSupport;
  }
  const plainProbe = spawnSync('bwrap', probeBwrapArgs(probeMounts), { timeout: 8000 });
  cachedSupport = { ok: plainProbe.status === 0, chmod: false };
  return cachedSupport;
}

function clearcoteCommand({ executable, chromeArgs, userDataDir, downloadsDir = DOWNLOADS_DIR }) {
  const support = probeBwrap();
  if (!support.ok) {
    const detail = commandExists('bwrap')
      ? 'bubblewrap is installed but could not start a file jail. Allow unprivileged user namespaces, then restart the browser host.'
      : 'Install bubblewrap so browser download and upload stay in /home/debian/Downloads: sudo apt install bubblewrap';
    throw Object.assign(new Error(detail), { status: 503, code: 'BROWSER_HOST_UNAVAILABLE' });
  }
  const mounts = hostSystemMounts();
  const executableDir = path.posix.dirname(executable);
  const covered = mounts.dirs.some(
    (dir) => executableDir === dir || executableDir.startsWith(`${dir}/`)
  );
  const dirs = covered || !executableDir || executableDir === '/'
    ? mounts.dirs
    : [...mounts.dirs, executableDir];
  return {
    command: 'bwrap',
    args: buildBwrapArgs({
      executable,
      chromeArgs,
      userDataDir,
      downloadsDir,
      systemDirs: dirs,
      systemSymlinks: mounts.symlinks,
      chmod: support.chmod,
    }),
    env: {
      HOME: '/home/debian',
      XDG_CONFIG_HOME: `${userDataDir}/.domx-config`,
      XDG_CACHE_HOME: `${userDataDir}/.domx-cache`,
      XDG_DATA_HOME: `${userDataDir}/.domx-data`,
      GTK_USE_PORTAL: '0',
    },
  };
}

module.exports = {
  DOWNLOADS_DIR,
  ensureDownloadsDir,
  pinDownloadDirectory,
  writeUserDirs,
  withPortalDisabled,
  buildBwrapArgs,
  probeBwrapArgs,
  clearcoteCommand,
};
