# Wordwell Portable

Standalone Windows x64 application using the same Wordwell source as the website. It includes Electron's browser and Node.js runtime; users do not need Node.js, a separate browser, an installer, or administrator rights.

## Run

Download `Wordwell-1.0.0-portable-x64.exe` from the [latest GitHub Release](https://github.com/shynt-04/wordwell/releases/latest), or build it locally in `release/`. Double-click the executable from a writable folder. First launch may take a few seconds while the runtime extracts. The app opens its own window and stops its local server when closed. Manual vocabulary and reviews work offline; cloud AI requires internet and your own provider setup. Local models/proxies still need to be installed and running separately.

An unsigned development build may show a Windows SmartScreen warning. Only run builds from a source you trust. Code signing is not configured in this repository.

## Portable data

The app creates `data/` **beside the portable executable**, not in the runtime's temporary extraction directory. Keep this folder with the executable when moving your personal installation. Use a writable local folder or USB drive, not Program Files, a read-only drive, or a ZIP archive. Do not unplug a drive while Wordwell is open.

- `data/wordwell.sqlite`: notebook, both review schedules, and saved Writing material.
- `data/ai-settings.json`: provider profiles and API keys in plain text. Keep it private.
- `data/browser/` and `data/logs/`: desktop browser profile and runtime files.

To share a fresh copy, send **only the portable `.exe`**, never your `data/` folder or `.env`. The build does not include personal website data or credentials. Unsaved passage material stays in the open window only.

The website and desktop app have separate data. To transfer existing learning data, close both, back up both databases, then copy the website's `data/wordwell.sqlite` to the desktop app's `data/wordwell.sqlite`. Do not overwrite a notebook you need without a backup. Set up AI again in Settings, or privately copy `ai-settings.json` while both apps are closed. Old browser-only data must first be migrated by opening the website in its original browser.

An optional `.env` beside the portable executable supports the existing legacy AI variables and `ENABLE_API_KEY_REVEAL=true`. The desktop copy ignores `PORT` and uses a free loopback-only port. It does not inherit shell AI credentials. Reveal remains disabled by default.

## Develop and build

From the repository root, with Node.js 24+:

```sh
npm --prefix portable-app ci
npm run app:dev
npm run app:build
npm test
npm run app:test
```

`app:build` creates the portable executable and an unpacked runtime in `portable-app/release/`. `app:test` launches the unpacked build and the actual portable executable with isolated temporary data, checks persistence, UI startup, and desktop security, then closes them. Its temporary QA folder contains a screenshot and test notebook, never personal data. Build before running this check. Build output, personal data, and dependency caches are excluded from Git. Building downloads development dependencies and Electron; the released application does not need those downloads to start.

The renderer has no Node.js integration or preload bridge; context isolation, sandboxing, a content security policy, restricted navigation, and denied device permissions protect the desktop window. The existing server's static-file allowlist and traversal protections remain in use. There is no automatic update mechanism: replace the executable with a trusted newer build after backing up and closing the app.

Licensed under the repository's GPL-3.0 license. Distribution of binaries must also provide the corresponding source and license notices, including Electron's third-party notices shipped with its runtime.
