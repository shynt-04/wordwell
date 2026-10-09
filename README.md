# Wordwell

A local IELTS practice app for building vocabulary with spaced repetition and getting AI feedback on Academic Writing Tasks 1 and 2.

## Features

- **Vocabulary notebook:** Save words, meanings, British IPA, synonyms, examples, and notes. Search, edit, and hear pronunciation.
- **Two-way recall:** Choose **Understand** (word → meaning) or optional **Use it** (meaning → typed word), with separate spaced-repetition schedules and daily progress. Rate your own recall; synonyms need not be wrong. **Again** retries wait one minute while you practice other words or take a breather.
- **AI autofill:** Generate English and Vietnamese meanings, pronunciation, synonyms, and IELTS-style examples.
- **From a passage:** Paste a reading passage or listening transcript and optional questions as text or ordered screenshots. Check extracted text, explore supported synonym/paraphrase connections, and preview only the cards you choose to save.
- **Writing practice:** Submit a question, essay, and optional image for estimated bands, corrections, and an improved response. Feedback is available in English or Vietnamese.
- **Local storage:** Keep vocabulary, review history, and your current Writing draft in SQLite, with database and vocabulary JSON backups.

## Quick start

Requires **Node.js 24+** and a modern desktop browser. No dependency installation or build step is needed.

```sh
git clone https://github.com/shynt-04/wordwell.git
cd wordwell
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Keep the terminal running while using the app; press `Ctrl+C` to stop it.

On Windows, you can also double-click `start-wordwell.cmd`.

## AI setup

In **Settings**:

1. Choose a provider and enter its API key, or configure a local endpoint.
2. Click **Connect & load models** and select an available model.
3. Click **Save AI settings** to enable vocabulary autofill and Writing feedback.

Supported providers: **DeepSeek, Google Gemini, Claude, CLIProxyAPI, Ollama**, and other **OpenAI-compatible APIs**. Local services must already be running; Ollama also needs a downloaded model. Compatible endpoints must support model listing at `GET /models`. Image questions require a model that accepts images.

API keys stay masked by default. To enable the **Show / Hide** button, set `ENABLE_API_KEY_REVEAL=true` in `.env`, restart Wordwell, and refresh the browser.

Choose **Continue without AI** to use manual vocabulary entry and reviews offline. AI suggestions may contain mistakes, and Writing bands are practice estimates rather than official IELTS results.

For screenshots, select an image-capable model and **Enable image input**. In **From a passage**, paste with `Ctrl+V`, upload, or drag in up to four images per section. Extract and correct the text before finding cards. Unsaved material stays in the open tab only; saved cards retain context and question connections. Submissions go to your provider and may incur usage charges.

## Data and backups

Wordwell creates these files locally; both are excluded from Git:

| File | Contents |
| --- | --- |
| `data/wordwell.sqlite` | Vocabulary, review history, and the current Writing draft, image, and feedback |
| `data/ai-settings.json` | Provider settings and API keys, stored in plain text |

Use **Backup & restore → Download SQLite backup** for a complete learning-data backup. To restore, stop Wordwell, keep a copy of the current database, replace `data/wordwell.sqlite` with your backup, and restart. Vocabulary JSON backups cover vocabulary and reviews only; neither backup includes AI credentials.

Upgrades preserve existing Understand progress and start Use it as new. Older JSON and SQLite backups are supported; new backups include both directions and require this version or later. Back up before upgrading.

Cloud AI requests send the word being looked up, or the Writing question, essay, and attached image, to your chosen provider. Keep local credential files private. When upgrading from an older browser-storage version, first open the app in the same browser and at the same address to migrate your data.

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Run the local server |
| `npm run dev` | Run with automatic server restarts on source changes |
| `npm test` | Run the test suite |

Refresh the browser after editing frontend files. To change the default port, copy `.env.example` to `.env`, set `PORT`, and restart the server. Configure AI through Settings.

```text
vocab-app/
  dist/          Editable HTML, CSS, and browser JavaScript
  tests/         Automated tests
  server.mjs     Local HTTP server
  database.mjs   SQLite storage and backups
  ai-*.mjs       Provider settings, model discovery, and requests
  deepseek.mjs   Vocabulary prompts and validation
  writing.mjs    Writing assessment and validation
  passage.mjs    Image extraction and vocabulary connections
```

The app uses ES modules and Node.js built-ins, including SQLite. Despite its name, `vocab-app/dist/` contains editable frontend source.

## License

[GNU General Public License v3.0](LICENSE).
