# Releasing Calendar Pro

This checklist covers a public plugin release. It does not submit the plugin to the Community directory; initial directory submission is a separate step after the release is ready.

## Before release

1. Confirm the version in `manifest.json` and the release tag are identical (`0.1.0` for the initial release).
2. Review the public README, release notes, license, attribution, privacy disclosures, manifest compatibility fields, and release-code audit.
3. Run the checks supported by the repository:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run package
   ```

4. The package build checks that every runtime dependency has a license file and writes the notices into `main.js` and `THIRD_PARTY_LICENSES.txt`. Inspect the generated archive and verify it contains `calendar-pro/main.js`, `calendar-pro/manifest.json`, `calendar-pro/styles.css`, `calendar-pro/LICENSE`, and `calendar-pro/THIRD_PARTY_LICENSES.txt`.
5. Compare `manifest.json`, `package.json`, and `versions.json`: the plugin versions must match, and the `versions.json` entry for that version must equal `manifest.json`'s `minAppVersion`. For 0.1.0, these values are `0.1.0` and `1.14.5`.
6. Verify the release build against the documented native QA scope in [development and QA](DEVELOPMENT.md). Report only checks actually performed; automated tests do not replace native Obsidian checks.

## GitHub release

Create a GitHub Release with tag `0.1.0`, matching `manifest.json`. Attach the three plugin assets as individual files at the release root: `main.js`, `manifest.json`, and `styles.css`. The downloadable ZIP may be attached as an extra convenience, but it does not replace those three assets. Use [the 0.1.0 release notes](../releases/0.1.0.md) as the release description.

The **Release** workflow (`.github/workflows/release.yml`) publishes automatically: it runs on every push to `main` (and can be run from the Actions tab), and acts only when the `manifest.json` version has no GitHub Release yet. Merging the version bump and its release notes therefore publishes the release. It checks that `manifest.json`, `package.json`, and `versions.json` agree and that `docs/releases/<version>.md` exists, runs the type check, tests, and package build, then creates the annotated tag and the GitHub Release with `main.js`, `manifest.json`, `styles.css`, and the ZIP attached. Any run for a version that is already released stops after the version check.

The official Obsidian guide requires the release tag to match the manifest version and lists `main.js`, `manifest.json`, and `styles.css` as release attachments: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin).

## Community directory submission

After the repository and release are ready, sign in at [community.obsidian.md](https://community.obsidian.md), connect the GitHub account that owns the repository, and submit the plugin using the directory's current submission flow. The directory reads `manifest.json` from the default branch and downloads the three release assets from the matching version tag. Community listing and in-app installation remain unavailable until review is complete and the entry is published.

Follow the current [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) and [plugin submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins). Directory submission is an owner action and is not part of this repository release checklist.
