# DomX CRM — Updating & Releasing

This guide covers how to ship new versions of the DomX CRM desktop app and how the in-app auto-updater behaves for staff.

## How updates work for staff

DomX CRM uses a **hard-gate** update policy: if a newer version is available, the app cannot be used until updated.

| Platform | Behavior |
|----------|----------|
| **Windows** | App blocks immediately → downloads update in background → **Update now** installs with one click |
| **macOS** | App blocks immediately → **Download update** opens the DMG → user installs manually and relaunches |

- Update checks run on startup and every **15 minutes**
- If the update server is unreachable, the app **allows use** so staff are not locked out by network issues
- macOS in-app install requires Apple code signing (not set up yet), so Mac users must install the DMG manually

## Update server

Published files are hosted at:

**https://domx.low7labs.cloud/crm-updates/**

The app reads:

| File | Used by |
|------|---------|
| `latest.yml` | Windows auto-update (electron-updater) |
| `latest-mac.yml` | macOS electron-updater metadata (for future signed builds) |
| `latest.json` | macOS version check + download URLs |

## Releasing a new version

Do this **once per version** you want staff to receive (e.g. `1.0.0` → `1.0.1`).

### 1. Bump the version

Edit [`frontend/package.json`](frontend/package.json):

```json
"version": "1.0.1"
```

Commit and push:

```bash
git add frontend/package.json
git commit -m "Release v1.0.1"
git push origin master
```

### 2. Build installers (GitHub Actions — recommended)

Push a version tag to trigger the CI build:

```bash
git tag v1.0.1
git push origin v1.0.1
```

This runs the [**Build Electron App**](.github/workflows/build-electron.yml) workflow, which:

1. Builds the Windows `.exe` on `windows-latest`
2. Builds macOS `.dmg` files (x64 + arm64) on `macos-latest`
3. Merges all artifacts and generates `latest.json`
4. Creates a **GitHub Release** with all files attached

**Alternative:** GitHub → **Actions** → **Build Electron App** → **Run workflow** (manual, no GitHub Release created).

You do **not** need to run both the manual workflow and a tag — pick one per release. **Tagging is recommended** for real releases.

### 3. Download the build

**Option A — GitHub Release (after tagging):**

`https://github.com/joshcodesalot/domx-crm/releases`

Download the release assets for your version.

**Option B — Actions artifact (always has the full bundle):**

1. Go to **Actions** → open the workflow run
2. Scroll to **Artifacts**
3. Download **`domx-crm-release`**

This zip contains everything you need, including `latest.json`.

### 4. Upload to hosting

Upload **all files** from the build to:

`https://domx.low7labs.cloud/crm-updates/`

Required files per release:

```
DomX-CRM-Setup-<version>-x64.exe
DomX-CRM-Setup-<version>-x64.exe.blockmap
DomX-CRM-<version>-arm64.dmg
DomX-CRM-<version>-x64.dmg
latest.yml
latest-mac.yml
latest.json
```

Overwrite `latest.yml`, `latest-mac.yml`, and `latest.json` each release. Keep old versioned installers if you want rollback options.

### 5. Verify

Confirm these URLs load in a browser:

- https://domx.low7labs.cloud/crm-updates/latest.yml
- https://domx.low7labs.cloud/crm-updates/latest.json

### 6. Test

Launch an older installed build:

- **Windows:** should block → download → show **Update now**
- **macOS:** should block → show **Download update**

---

## Building locally (optional)

Use local builds for testing. macOS installers **must** be built on a Mac.

```bash
cd frontend

# Windows (on Windows)
npm run build:electron:win

# macOS (on a Mac)
npm run build:electron:mac
```

Output goes to `frontend/release/`. Builds use `--publish=never` — nothing is uploaded automatically.

---

## Regenerating `latest.json` manually

If `latest.json` is missing, put all release files in `frontend/release/` then run from the **frontend** folder (not `release/`):

```bash
cd frontend
node scripts/generate-update-manifest.js
```

This writes `frontend/release/latest.json` based on the installers present.

Example output:

```json
{
  "version": "1.0.1",
  "publishedAt": "2026-07-14T08:00:00.000Z",
  "downloads": {
    "windows": {
      "url": "https://domx.low7labs.cloud/crm-updates/DomX-CRM-Setup-1.0.1-x64.exe"
    },
    "mac": {
      "arm64": {
        "url": "https://domx.low7labs.cloud/crm-updates/DomX-CRM-1.0.1-arm64.dmg"
      },
      "x64": {
        "url": "https://domx.low7labs.cloud/crm-updates/DomX-CRM-1.0.1-x64.dmg"
      }
    }
  }
}
```

---

## Quick reference

| Task | Command / location |
|------|---------------------|
| Repo | https://github.com/joshcodesalot/domx-crm |
| Bump version | `frontend/package.json` → `"version"` |
| Trigger CI build | `git tag v1.0.1 && git push origin v1.0.1` |
| Download artifacts | Actions → workflow run → **domx-crm-release** |
| Upload destination | `https://domx.low7labs.cloud/crm-updates/` |
| Windows local build | `npm run build:electron:win` |
| macOS local build | `npm run build:electron:mac` (Mac only) |
| Regenerate manifest | `cd frontend && node scripts/generate-update-manifest.js` |

## Troubleshooting

**"Build for macOS is supported only on macOS"**  
You ran the Mac build on Windows. Use GitHub Actions or a Mac machine.

**`latest.json` missing from GitHub Release**  
Download the **`domx-crm-release`** artifact from Actions instead, or regenerate locally (see above).

**Mac users not seeing updates**  
Ensure `latest.json` is uploaded to hosting with correct Mac DMG URLs.

**Windows users not updating**  
Ensure `latest.yml` and the `.exe` + `.blockmap` are uploaded and reachable over HTTPS.

**Staff locked out**  
If hosting is down, the app allows use. If they are blocked, a newer version is live — install the update.
