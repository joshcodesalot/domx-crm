const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PUBLISH_URL = 'https://domx.low7labs.cloud/crm-updates/';

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

function findArtifact(files, pattern) {
  return files.find((name) => pattern.test(name)) || null;
}

function buildManifest(version, files) {
  const baseUrl = PUBLISH_URL.replace(/\/$/, '');
  const windowsExe = findArtifact(files, /^DomX-CRM-Setup-.+-x64\.exe$/i);
  const macArm64Dmg = findArtifact(files, /^DomX-CRM-.+-arm64\.dmg$/i);
  const macX64Dmg = findArtifact(files, /^DomX-CRM-.+-x64\.dmg$/i);

  const downloads = {};

  if (windowsExe) {
    downloads.windows = { url: `${baseUrl}/${windowsExe}` };
  }

  const mac = {};
  if (macArm64Dmg) {
    mac.arm64 = { url: `${baseUrl}/${macArm64Dmg}` };
  }
  if (macX64Dmg) {
    mac.x64 = { url: `${baseUrl}/${macX64Dmg}` };
  }
  if (Object.keys(mac).length > 0) {
    downloads.mac = mac;
  }

  return {
    version,
    publishedAt: new Date().toISOString(),
    downloads,
  };
}

function main() {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.warn('[generate-update-manifest] release directory not found, skipping');
    return;
  }

  const version = readVersion();
  const files = fs.readdirSync(RELEASE_DIR);
  const manifest = buildManifest(version, files);
  const outputPath = path.join(RELEASE_DIR, 'latest.json');

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[generate-update-manifest] wrote ${outputPath}`);
}

module.exports = async function afterAllArtifactBuild() {
  main();
};

module.exports.main = main;
module.exports.buildManifest = buildManifest;

if (require.main === module) {
  main();
}
