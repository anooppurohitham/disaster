import fs from "node:fs";
import path from "node:path";

const version = process.argv[2]?.trim();

if (!version) {
  console.error("Usage: node scripts/set-version.mjs <version>");
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

writeJson(path.join("src-tauri", "tauri.conf.json"), (data) => {
  data.version = version;
});

writeText(path.join("src-tauri", "Cargo.toml"), (content) =>
  content.replace(
    /^version = ".*?"$/m,
    `version = "${version}"`,
  ),
);

console.log(`Synchronized Disaster version to ${version}.`);
