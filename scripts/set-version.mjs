import fs from "node:fs";
import path from "node:path";

const version = process.argv[2]?.trim().replace(/^v/i, "");

if (!version) {
  console.error("Usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semantic version: ${version}`);
  process.exit(1);
}

const root = process.cwd();

function writeJson(filePath, mutate) {
  const absolutePath = path.join(root, filePath);
  const data = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  mutate(data);
  fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeText(filePath, mutate) {
  const absolutePath = path.join(root, filePath);
  const current = fs.readFileSync(absolutePath, "utf8");
  const next = mutate(current);
  fs.writeFileSync(absolutePath, next);
}

writeJson("package.json", (data) => {
  data.version = version;
});

writeJson("package-lock.json", (data) => {
  data.version = version;
  if (data.packages?.[""]) {
    data.packages[""].version = version;
  }
});

writeJson(path.join("src-tauri", "tauri.conf.json"), (data) => {
  data.version = version;
});

writeText(path.join("src-tauri", "Cargo.toml"), (content) =>
  content.replace(
    /^version = ".*?"$/m,
    `version = "${version}"`,
  ),
);

writeText(path.join("src-tauri", "Cargo.lock"), (content) =>
  content.replace(
    /(name = "dmx-timeline"\r?\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  ),
);

console.log(`Synchronized Disaster version to ${version}.`);
