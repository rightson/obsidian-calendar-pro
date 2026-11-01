# Install Calendar Pro

Calendar Pro requires desktop Obsidian 1.14.5 or later. It has not been submitted to the Obsidian Community Plugins directory, so it cannot yet be found in Obsidian's built-in plugin browser. Choose a manual ZIP install or install it with BRAT.

## Manual install from the GitHub ZIP

1. [Download the latest Calendar Pro ZIP](https://github.com/rightson/obsidian-calendar-pro/releases/latest/download/calendar-pro.zip). Choose the `calendar-pro.zip` release asset, not GitHub's automatically generated **Source code (zip)** download.
2. Quit Obsidian and extract the ZIP. It contains a `calendar-pro` folder with the plugin files.
3. Copy the **whole `calendar-pro` folder** into your Vault's `.obsidian/plugins/` folder. The resulting path should be `<Vault>/.obsidian/plugins/calendar-pro/`, with `main.js`, `manifest.json`, and `styles.css` directly inside `calendar-pro`.
4. Reopen Obsidian. Open **Settings → Community plugins**. If prompted, enable community plugins, then enable **Calendar Pro**. Reload if prompted.

If `.obsidian` is hidden in your file manager, enable its option to show hidden files. The `.obsidian` directory belongs to the Vault; do not put the plugin folder beside the Vault or inside a notes folder.

### Update a manual install

Quit Obsidian, download and extract the latest ZIP, then replace only `main.js`, `manifest.json`, and `styles.css` inside the existing `<Vault>/.obsidian/plugins/calendar-pro/` folder. Keep the existing `data.json` and any other plugin data files so Calendar Pro retains its settings, history, link tracking, and recovery data. Do not replace, move, or delete your Vault notes. Reopen Obsidian after replacing the files.

## Install with BRAT

BRAT installs beta plugins from their GitHub repositories. Calendar Pro is public, so you normally do not need a GitHub token.

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **BRAT**, and install and enable it.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter the repository as `rightson/obsidian-calendar-pro` and add the plugin. If a version selector is shown, choose the latest release, or choose `0.1.0` to stay on that release.
4. In **Settings → Community plugins**, enable **Calendar Pro** if it is not already enabled. Reload Obsidian if prompted.

After BRAT is installed, you can copy this URI and paste it into your web browser's address bar:

```text
obsidian://brat?plugin=rightson/obsidian-calendar-pro
```

If opening the URI does not work, use the command palette steps above. For additional BRAT guidance, see the [BRAT Quick Guide](https://tfthacker.com/brat-quick-guide) and [BRAT Protocol](https://tfthacker.com/brat-protocol).

### Update or pin a BRAT install

Use BRAT's update controls in **Settings → BRAT**, or search for **BRAT** or **update** in the command palette. If you selected a specific release version, BRAT will keep that version until you change the selection; choose the latest release to receive updates. BRAT's update-check timing and controls can vary by version; see the BRAT guide linked above if the controls differ.

## Troubleshooting

- **Calendar Pro is not listed in Community Plugins:** The plugin is not yet published in the Community directory. Use the ZIP method or BRAT.
- **Obsidian does not detect the manual install:** Check that the folder is exactly `<Vault>/.obsidian/plugins/calendar-pro/` and that the three runtime files are directly inside it, not in an extra nested folder. Then reload Obsidian and check **Settings → Community plugins** again.
- **The plugin is disabled:** Open **Settings → Community plugins** and enable Calendar Pro. Community plugins must be enabled in the Vault.
- **An update appears to have reset plugin state:** Restore the existing `data.json` from your backup and reload. For manual updates, replace only the three runtime files and preserve plugin data as described above.

For release-specific compatibility and verification details, see the [0.1.0 release notes](../releases/0.1.0.md). Calendar Pro 0.1.0 requires Obsidian 1.14.5 or later and supports desktop Obsidian; mobile behavior has not been verified.
