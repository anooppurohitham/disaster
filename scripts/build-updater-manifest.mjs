import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const bundleDir = args.get("--bundle-dir");
const version = args.get("--version");
const releaseBaseUrl = args.get("--release-base-url");
const outFile = args.get("--out");
const defaultArch = (args.get("--default-arch") || process.env.RUNNER_ARCH || "x64").toLowerCase();
const notes = args.get("--notes") || undefined;

if (!bundleDir || !version || !releaseBaseUrl || !outFile) {
  console.error(
    "Usage: node scripts/build-updater-manifest.mjs --bundle-dir <dir> --version <version> --release-base-url <url> --out <file> [--default-arch <arch>] [--notes <text>]",
  );
  process.exit(1);
}

const normalizedReleaseBaseUrl = releaseBaseUrl.replace(/\/+$/, "");

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

function inferArch(fileName) {
  const normalized = fileName.toLowerCase();
  if (/(^|[_-])(aarch64|arm64)([_\-.]|$)/.test(normalized)) return "aarch64";
  if (/(^|[_-])(x86_64|x64)([_\-.]|$)/.test(normalized)) return "x86_64";
  if (/(^|[_-])(i686|x86)([_\-.]|$)/.test(normalized)) return "i686";
  if (/(^|[_-])(armv7|arm)([_\-.]|$)/.test(normalized)) return "armv7";

  switch (defaultArch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "x86":
      return "i686";
    default:
      return defaultArch;
  }
}

function inferTarget(filePath) {
  const fileName = path.basename(filePath);
  const normalized = fileName.toLowerCase();
  const arch = inferArch(fileName);

  if (normalized.endsWith(".app.tar.gz") || normalized.endsWith(".app.tar.gz.zip")) {
    return `darwin-${arch}`;
  }

  if (normalized.endsWith(".appimage.tar.gz") || normalized.endsWith(".appimage.tar.gz.zip")) {
    return `linux-${arch}`;
  }

  if (normalized.endsWith(".appimage")) {
    return `linux-${arch}`;
  }

  if (normalized.endsWith(".deb")) {
    return `linux-${arch}-deb`;
  }

  if (normalized.endsWith(".rpm")) {
    return `linux-${arch}-rpm`;
  }

  if (normalized.endsWith(".msi.zip") || normalized.endsWith(".msi")) {
    return `windows-${arch}`;
  }

  if (
    normalized.endsWith(".exe.zip") ||
    normalized.endsWith("-setup.exe") ||
    normalized.endsWith(".nsis.zip")
  ) {
    return `windows-${arch}`;
  }

  return null;
}

if (!fs.existsSync(bundleDir)) {
  console.error(`Bundle directory not found: ${bundleDir}`);
  process.exit(1);
}

const allFiles = walk(bundleDir);
const platforms = {};

function isWindowsNsisArtifact(filePath) {
  const normalized = path.basename(filePath).toLowerCase();
  return (
    normalized.endsWith(".exe.zip") ||
    normalized.endsWith("-setup.exe") ||
    normalized.endsWith(".nsis.zip")
  );
}

for (const signaturePath of allFiles.filter((file) => file.endsWith(".sig"))) {
  const assetPath = signaturePath.slice(0, -4);
  if (!fs.existsSync(assetPath)) continue;

  const target = inferTarget(assetPath);
  if (!target) continue;

  if (platforms[target]) {
    if (target.startsWith("windows-")) {
      if (!isWindowsNsisArtifact(assetPath)) continue;
    } else {
      console.error(`Duplicate updater target detected for ${target}.`);
      process.exit(1);
    }
  }

  const fileName = path.basename(assetPath);
  platforms[target] = {
    url: `${normalizedReleaseBaseUrl}/${encodeURIComponent(fileName)}`,
    signature: fs.readFileSync(signaturePath, "utf8").trim(),
  };
}

if (!Object.keys(platforms).length) {
  console.error(
    `No signed updater artifacts were found in ${bundleDir}. Make sure TAURI_SIGNING_PRIVATE_KEY is set during the release build.`,
  );
  process.exit(1);
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  ...(notes ? { notes } : {}),
  platforms,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote updater manifest fragment to ${outFile}.`);
