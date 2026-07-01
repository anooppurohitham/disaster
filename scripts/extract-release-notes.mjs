import { readFileSync, writeFileSync } from "node:fs";

const requestedVersion = process.argv[2]?.replace(/^v/, "");
if (!requestedVersion) {
  throw new Error("Usage: node scripts/extract-release-notes.mjs <version>");
}

const changelog = readFileSync("CHANGELOG.md", "utf8").replace(/\r\n/g, "\n");
const heading = `## ${requestedVersion}`;
const sectionStart = changelog.indexOf(`${heading}\n`);
if (sectionStart < 0) {
  throw new Error(
    `CHANGELOG.md is missing "${heading}". Add this release before pushing its tag.`,
  );
}

const contentStart = sectionStart + heading.length + 1;
const nextHeading = changelog.indexOf("\n## ", contentStart);
const section = changelog
  .slice(contentStart, nextHeading < 0 ? changelog.length : nextHeading)
  .trim();

if (!section) {
  throw new Error(`The ${heading} changelog section has no release notes.`);
}

writeFileSync(
  "RELEASE_NOTES.md",
  `## Recent changes\n\n${section}\n`,
  "utf8",
);
