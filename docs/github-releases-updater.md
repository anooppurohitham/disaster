# Disaster GitHub Releases updater

This project is set up so a tagged GitHub release can:

- build signed desktop bundles
- upload them to GitHub Releases
- publish `updates/latest.json` to GitHub Pages
- let installed copies of Disaster download updates in-app

## One-time GitHub setup

1. Generate a Tauri updater signing key locally:

```bash
npm run tauri signer generate -- -w disaster-updater.key
```

2. Save these GitHub repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
  - contents of `disaster-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  - only if you protected the key with a password
- `TAURI_SIGNING_PUBLIC_KEY`
  - the public key output printed by the signer command

3. In GitHub repository settings, enable Pages and set the source to GitHub Actions.

## How releases work

The release workflow lives at:

- [.github/workflows/release.yml](</C:/Projects/DMX Project/dmx-timeline/.github/workflows/release.yml>)

When you push a tag like `v0.0.3-alpha`, GitHub Actions will:

1. sync the app version to `0.0.3-alpha`
2. build signed Tauri bundles on Windows and macOS
3. upload the release assets to GitHub Releases
4. generate an updater manifest at `updates/latest.json`
5. deploy that manifest to GitHub Pages

The built app embeds this updater endpoint at build time:

`https://<owner>.github.io/<repo>/updates/latest.json`

## Releasing a new version

1. Update the version locally:

```bash
node scripts/set-version.mjs 0.0.3-alpha
```

2. Commit the version change:

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "release: 0.0.3-alpha"
```

3. Tag it:

```bash
git tag v0.0.3-alpha
```

4. Push branch and tag:

```bash
git push origin main --follow-tags
```

After the workflow finishes, Disaster clients built from this release line will be able to update in-app.

## Manifest format

Tauri updater v2 expects a static manifest shaped like:

```json
{
  "version": "0.0.3-alpha",
  "pub_date": "2026-06-29T00:00:00.000Z",
  "platforms": {
    "windows-x86_64-nsis": {
      "url": "https://github.com/OWNER/REPO/releases/download/v0.0.3-alpha/Disaster_0.0.3-alpha_x64-setup.exe",
      "signature": "..."
    }
  }
}
```

The scripts that generate this are:

- [scripts/build-updater-manifest.mjs](</C:/Projects/DMX Project/dmx-timeline/scripts/build-updater-manifest.mjs>)
- [scripts/merge-updater-manifests.mjs](</C:/Projects/DMX Project/dmx-timeline/scripts/merge-updater-manifests.mjs>)
- [scripts/set-version.mjs](</C:/Projects/DMX Project/dmx-timeline/scripts/set-version.mjs>)

## Notes

- The updater only works for builds that were compiled with the embedded updater public key and endpoint.
- Older local builds made before this GitHub release flow was added will not magically know where to update from.
- If you change repository owner or repository name later, rebuild and ship a fresh version so the baked updater endpoint stays correct.
