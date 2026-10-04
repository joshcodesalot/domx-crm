const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pinDownloadDirectory,
  writeUserDirs,
  buildBwrapArgs,
  probeBwrapArgs,
} = require('../../../browser-host/clearcote/fileJail');

describe('browser file jail', () => {
  it('points download and upload dialogs at Downloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-file-jail-'));
    const prefsPath = path.join(dir, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify({ browser: { window_placement: { left: 0 } } }));

    pinDownloadDirectory(dir, '/home/debian/Downloads');
    writeUserDirs(dir, '/home/debian/Downloads');

    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    assert.equal(prefs.browser.window_placement.left, 0);
    assert.equal(prefs.download.default_directory, '/home/debian/Downloads');
    assert.equal(prefs.savefile.default_directory, '/home/debian/Downloads');
    assert.equal(prefs.selectfile.last_directory, '/home/debian/Downloads');
    const userDirs = fs.readFileSync(path.join(dir, '.domx-config', 'user-dirs.dirs'), 'utf8');
    assert.match(userDirs, /XDG_DOWNLOAD_DIR="\/home\/debian\/Downloads"/);
    assert.match(userDirs, /XDG_DOCUMENTS_DIR="\/home\/debian\/Downloads"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hides every folder except Downloads from the file dialog', () => {
    const args = buildBwrapArgs({
      executable: '/opt/clearcote/chrome',
      chromeArgs: ['--user-data-dir=/var/lib/domx-browser/profile', '--disable-features=Foo'],
      userDataDir: '/var/lib/domx-browser/profile',
      downloadsDir: '/home/debian/Downloads',
      systemDirs: ['/usr', '/opt'],
      chmod: true,
    });

    const homeTmp = args.indexOf('/home');
    assert.equal(args[homeTmp - 1], '--tmpfs');
    const downloadBind = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === '/home/debian/Downloads' &&
        args[index + 2] === '/home/debian/Downloads'
    );
    assert.notEqual(downloadBind, -1);
    assert.equal(args[args.indexOf('--chdir') + 1], '/home/debian/Downloads');
    assert.equal(args.includes('--ro-bind'), false);
    assert.ok(args.includes('0511'));
    const profileChmod = args.findIndex(
      (arg, index) => arg === '0511' && args[index + 1] === '/var/lib/domx-browser/profile'
    );
    assert.equal(profileChmod, -1);
    assert.equal(args.at(-1), '--disable-features=Foo,XdgFileChooserPortal');
  });

  it('probes bubblewrap with the Debian loader links', () => {
    const symlinks = [
      { path: '/bin', target: 'usr/bin' },
      { path: '/lib', target: 'usr/lib' },
      { path: '/lib64', target: 'usr/lib64' },
    ];
    const plain = probeBwrapArgs({ systemDirs: ['/usr'], systemSymlinks: symlinks });
    assert.equal(plain.at(-1), '/usr/bin/true');
    assert.equal(plain.at(-2), '--');
    assert.deepEqual(
      symlinks.map((link) => {
        const at = plain.indexOf(link.path);
        return [plain[at - 2], plain[at - 1], plain[at]];
      }),
      symlinks.map((link) => ['--symlink', link.target, link.path])
    );
    assert.equal(plain.includes('--chmod'), false);

    const chmod = probeBwrapArgs({ systemDirs: ['/usr'], systemSymlinks: symlinks, chmod: true });
    assert.equal(chmod.at(-1), '/usr/bin/true');
    const chmodAt = chmod.indexOf('--chmod');
    assert.equal(chmod[chmodAt + 1], '0511');
    assert.equal(chmod[chmodAt + 2], '/usr');
  });
});
