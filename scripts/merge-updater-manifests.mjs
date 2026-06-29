import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const inputDir = args.get("--input-dir");
const version = args.get("--version");
const outFile = args.get("--out");
const notes = args.get("--notes") || undefined;

if (!inputDir || !version || !outFile) {
  console.error(
    "Usage: node scripts/merge-updater-manifests.mjs --input-dir <dir> --version <version> --out <file> [--notes <text>]",
  );
  process.exit(1);
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = walk(inputDir);
if (!files.length) {
  console.error(`No manifest fragments found in ${inputDir}.`);
  process.exit(1);
}

const platforms = {};
for (const file of files) {
  const fragment = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [target, platform] of Object.entries(fragment.platforms ?? {})) {
    if (platforms[target]) {
      console.error(`Duplicate updater platform "${target}" while merging ${file}.`);
      process.exit(1);
    }
    platforms[target] = platform;
  }
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  ...(notes ? { notes } : {}),
  platforms,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Merged updater manifest written to ${outFile}.`);
