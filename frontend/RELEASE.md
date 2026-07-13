# DomX CRM Release Guide

## Prerequisites

- Node.js installed
- `frontend/build/icon.png` present (1024x1024 recommended)
- Access to upload files to `https://domx.low7labs.cloud/crm-updates/`

## Release steps

1. Bump the app version in [`package.json`](package.json):

```json
"version": "1.0.1"
```

2. Build installers on each target platform:

```bash
# Windows
npm run build:electron:win

# macOS (run on a Mac)
npm run build:electron:mac
```

Or use GitHub Actions (builds Windows + macOS automatically):

- **Manual run:** Actions → **Build Electron App** → **Run workflow**
- **Tag release:** push a version tag, e.g. `git tag v1.0.1 && git push origin v1.0.1`
  - Builds Windows and macOS in parallel
  - Merges artifacts and regenerates `latest.json`
  - Uploads a combined `domx-crm-release` artifact
  - Creates a GitHub Release when triggered by a `v*` tag

Download the combined artifact from the workflow run, then upload its contents to hosting.

Build output is written to `frontend/release/`.

3. Upload the release artifacts to hosting:

Upload the built files from `frontend/release/` to:

`https://domx.low7labs.cloud/crm-updates/`

Required files per release:

- `DomX-CRM-Setup-<version>-x64.exe`
- `DomX-CRM-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `latest.json`
- macOS builds when applicable:
  - `DomX-CRM-<version>-arm64.dmg`
  - `DomX-CRM-<version>-x64.dmg`
  - `latest-mac.yml`

4. Verify the update feed is reachable:

- `https://domx.low7labs.cloud/crm-updates/latest.yml`
- `https://domx.low7labs.cloud/crm-updates/latest.json`

5. Test with an older installed build:

- Windows: app should block immediately, download the update, then show **Update now**
- macOS: app should block immediately and show **Download update**

## Notes

- Builds use `--publish=never`; uploading is manual
- `latest.json` is generated automatically after electron-builder finishes
- If the update server is unreachable, the app allows use so staff are not locked out by network outages
- macOS in-app install requires Apple signing and notarization; until then users must install the DMG manually

## Manifest format

`latest.json` is generated in this shape:

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
