# Wordwell

A personal desktop IELTS practice app. Capture vocabulary for spaced repetition and get AI feedback on your Writing Task 1 reports and Task 2 essays.

## Start locally

Install Node.js 24 or later (this app uses its built-in SQLite module), open this folder in a terminal, and run:

```sh
npm run dev
```

Open **http://127.0.0.1:4173** in your usual browser. No package installation is required. On first launch, choose an AI provider and enter your API key in **Settings**, click **Connect & load models**, choose a returned model, then save. You can also select **Continue without AI**. Manual learning works without internet access; cloud AI requires a connection, while local Ollama requires a running local model. Keep the terminal open while you use it. Press `Ctrl+C` to stop the server. On Windows, you can also double-click `start-wordwell.cmd`.

After upgrading from browser storage, first refresh in the same browser and address you previously used so the app can migrate your old data. After migration, browsers using this local server share the same database.

The development command and Windows launcher restart the server when its source changes. Refresh the browser after updates to load the new interface. Use `npm start` if you want to run without file watching. Restart manually after changing `.env`.

## Using your notebook

- **Capture:** Only word and meaning are required. Add phonetic pronunciation, an example, or a memory cue when useful. `Ctrl+Enter` saves from a field and returns focus to the next word.
- **Auto-fill:** Enter a word, then press Tab or Enter to suggest a meaning in English and Vietnamese, British IPA, English synonyms, and an English IELTS-style example. The Meaning field contains the English definition followed by a new line, e.g. `-> Đương thời`. Synonyms match the generated definition and appear in word details and review answers. You can turn automatic filling off or use **Fill with AI**. Existing text and notes are preserved; text edited during a request is also kept. Suggestions remain editable and are saved only when you add the word. The word editor can fill missing details too. **Stop autofill** cancels a request.
- **Review:** Recall the meaning before revealing it with `Space`. Rate your recall using `1` Again, `2` Hard, `3` Good, or `4` Easy. Saved ratings survive closing a session or restarting the app.
- **Collect:** Search across words, meanings, examples, and notes. Filter by due or new words, sort, and edit entries without losing their schedule.
- **Listen:** The speaker button uses your browser’s speech synthesis, preferring a British English voice. Voice availability and offline audio depend on your browser and installed voices. Audio is synthetic, not dictionary audio.
- **Try it:** The empty notebook offers three optional IELTS starter words. Nothing is preloaded into your personal collection.

## Local data and backups

All saved application data lives in **`data/wordwell.sqlite`**, inside this repository. The server creates the folder and database automatically, regardless of the terminal's working directory. SQLite stores vocabulary, scheduling, review history, and the current Writing question, essay, image, and feedback. The database is outside the served website files and ignored by Git. Clearing browser data does not remove it.

On refresh, old vocabulary from `wordwell.notebook.v1` and the old IndexedDB Writing draft are automatically migrated. Vocabulary is merged while preserving newer entries and review history. Each legacy snapshot is imported once, so refreshes cannot resurrect deleted words. Existing SQLite Writing data is retained; a different legacy draft is preserved in the `writing_archive` table. Original browser data is retained as a recovery copy. Close old app tabs before upgrading, and wait for the saved message before closing the app.

**Backup & restore → Download SQLite backup** downloads a consistent copy of the whole database, including Writing data. To restore: stop the server, keep a separate copy of the current database, replace `data/wordwell.sqlite` with your saved copy, then restart and refresh the app. Vocabulary JSON export/import remains available and does not replace Writing data. **Download old browser notebook** recovers the original browser vocabulary if migration failed.

Saves use transactions and revision checks. An outdated tab cannot replace newer database changes; refresh that tab before saving again. A failed save leaves the interface's previous notebook intact and shows an error. Keep the local server running for saving. Autofill sends only the word or phrase to your selected AI provider, not your notebook, personal notes, or review history.

JSON restore can combine notebooks (retaining the more recently updated entries) or replace vocabulary and review history. Invalid backups are rejected before any saved data changes. The last deleted word can be restored before a reload.

Older notebooks and backups without a Synonyms field remain supported. Edit an existing word and use **Fill with AI** to fill its empty Synonyms field; your other filled fields are kept. Synonyms are searchable and included in future backups.

## Writing practice

1. Open **Writing** and choose **Academic Task 1** (chart, map, or process report) or **Task 2** (essay).
2. Paste the question into **The question**. If it includes a chart or another image, press `Ctrl+V` anywhere in the Writing tab or click the image area to upload a PNG, JPEG, or WebP. You can submit an image without question text. Images are prepared locally with a maximum dimension of 1,800 pixels and a 2 MB limit; check that labels remain readable.
3. Write your response in **Your essay**. The live word count shows the 150-word Task 1 or 250-word Task 2 target. Short drafts can still receive provisional feedback.
4. Choose Vietnamese (default) or English explanations and select **Get writing feedback** (`Ctrl+Enter`). Assessment includes an estimated task band, four criterion estimates with reasons, strengths, improvement priorities, specific vocabulary/grammar corrections, and a complete improved English version you can copy.

The assessment follows the four equally weighted [IELTS Writing criteria](https://ielts.org/take-a-test/preparation-resources/writing-test-resources). Bands are AI practice estimates for one submitted task, not official results or a combined Writing score. Corrections that cannot be matched exactly to your essay are omitted. Image interpretation appears in the assessment so you can check what AI read.

Your current question, essay, image, and most recent feedback save to SQLite as you work. There is one current draft, not an essay history. Editing a draft marks existing feedback as belonging to the earlier version; edits during a review stop that review. AI's revision never replaces your essay. **Stop review** cancels the request and keeps your draft.

Only requesting feedback sends the question, essay, and attached image to your selected AI provider. Writing requests are not cached for AI reuse on the local server; the draft and returned feedback are persisted in SQLite. SQLite backups include Writing data; vocabulary JSON backups do not. If draft saving fails, an error appears beside the Writing heading. Wait for **Saved to data/wordwell.sqlite** before closing; unsaved changes trigger a browser reminder.

## Scheduling

This v1 uses a small, transparent scheduler rather than FSRS or RemNote’s algorithm:

- New words are immediately due. Good schedules a new word in 1 day, then 3 days, then grows its interval by approximately 2.5×.
- Hard uses at least 1 day and grows the previous interval by approximately 1.2×.
- Easy uses at least 4 days and grows the previous interval by approximately 3.2×.
- Again resets successful repetitions, saves a review for 1 minute later, and repeats the word at the end of the current session. With a one-word session, this repeat is immediate.

Intervals are elapsed 24-hour days; daily statistics use your device’s local calendar. The streak counts consecutive review days and stays active if you practised yesterday. Reviews today count distinct words, including Again ratings.

## AI providers and Settings

Open **Settings** or the AI button in the top bar:

1. Choose a provider, enter its API key, and set the base URL for a custom service. An existing key appears masked and is reused when connecting to its saved endpoint. **Show / Hide** reveals or masks that key. Choose **Change key** to enter a replacement, or **Cancel change** to return to the saved key. Providers without a saved key have an empty field for adding one. For a keyless local service, select **This endpoint does not require an API key**.
2. Click **Connect & load models**. The server checks access using the provider's model-list API; a failed check shows an error and no model selector. This makes no text-generation request.
3. Choose an **Available model**, then **Save AI settings** to activate it for vocabulary and Writing immediately.

The dropdown uses returned model IDs, not a fixed list. Gemini includes models supporting text generation, excluding embedding, image-only, and audio-only models. Native Gemini and Claude catalogs are paginated; compatible services must support `GET /models` at their API base URL. Ollama lists downloaded models. A successful connection confirms catalog access, not generation permissions, balance, or quota; some services expose a public catalog even when a key is supplied. A connection check expires after ten minutes. Editing credentials or the endpoint clears the list and requires reconnecting; stopping a check or switching providers ignores any late response.

Checks do not save or activate entered credentials. Existing AI settings stay active until you save a verified model. Each provider retains its saved profile. Settings loads only key-presence metadata; clicking **Show** explicitly fetches that provider's saved key from the local server. Hiding it, leaving Settings, or hiding the browser tab clears the revealed value from the field. Viewing a key does not mark the form as changed or send it back during connection checks. **Remove the saved key** can be saved without connecting; it disables that profile and retains its existing model and endpoint.

| Provider | Setup |
| --- | --- |
| DeepSeek | Your DeepSeek API key; default `deepseek-flash`. [API documentation](https://api-docs.deepseek.com/api/create-chat-completion/). |
| Google Gemini | Your [Google AI Studio key](https://ai.google.dev/gemini-api/docs/api-key) and an available model; default `gemini-3.5-flash-lite`. Uses the native Gemini API. |
| Claude | Your Anthropic API key and model ID; default `claude-sonnet-5-5`. Uses the native [Messages API](https://platform.claude.com/docs/en/api/messages/create). A Claude app subscription does not itself configure API access. |
| CLIProxyAPI | Start and configure [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) separately. Default base URL `http://127.0.0.1:8317/v1`; enter its client key and an exposed model alias. |
| Ollama | Install [Ollama](https://docs.ollama.com/api/openai-compatibility) and download a model, e.g. `ollama pull qwen3-vl:4b`. Default endpoint `http://127.0.0.1:11434/v1`; local mode requires no API key. |
| Other compatible API | Supply an OpenAI-compatible base URL, model ID, and API key. Select **This endpoint does not require an API key** only for a service configured that way. |

**Enable image questions** requires a model that accepts images. When a catalog explicitly reports text-only input, the image option is disabled. Where image support is not reported, check the provider's model documentation before enabling it. For compatible endpoints that reject `response_format`, turn off **Request JSON mode**; valid JSON answers are still required. Proxy support does not grant access to an upstream model or account. Model discovery follows the [DeepSeek](https://api-docs.deepseek.com/api/list-models/), [Gemini](https://ai.google.dev/api/models), and [Claude](https://platform.claude.com/docs/en/api/models/list) catalog APIs.

Credentials and provider profiles are stored in **`data/ai-settings.json`**, separately from the learning database. Keys are stored in plain text on your local machine and excluded from Git and SQLite/JSON backups. Ordinary settings responses omit them; the same-origin JSON POST reveal endpoint returns only the selected saved key when you click **Show**, with caching disabled. An entered replacement is sent to the local server when connecting and saving; provider requests run on the server. The displayed mask is never submitted as a key. Saved keys are reused only at the same endpoint. Remote custom endpoints require HTTPS; plain HTTP is allowed only on localhost. Changing an endpoint requires re-entering its key. Keep the settings file private when copying the project; after restoring a SQLite backup on another installation, configure AI again.

An existing `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` in `.env` or the environment is imported once when no settings file exists, preserving older installations. The existing `.env` is retained, but saved UI settings take precedence afterward. `.env.example` contains no key. New GitHub checkouts show setup automatically; choosing **Continue without AI** dismisses first-run setup, and Settings stays available. `PORT` can still be configured in `.env`; restart after changing it.

The server accepts requests only from the local app, validates inputs and AI JSON results, and redacts provider errors. Vocabulary requests time out after 45 seconds; Writing after 90 seconds. Successful vocabulary results are cached for 30 minutes (up to 200 entries), separately for each settings revision, and switching providers clears the cache. The server permits two simultaneous AI requests. Changing settings stops current browser AI requests so you can submit them again with the new provider.

AI suggestions can contain mistakes. Check the definition, IPA, and example before saving. Authentication, balance, connection, and limit errors appear next to the form; you can always enter vocabulary manually.

If the app reports an unsupported API route, stop the old Wordwell process with `Ctrl+C`, run `start-wordwell.cmd` or `npm run dev` again, and refresh. A static file server cannot run AI or SQLite endpoints; use Wordwell's own server.

## Project structure and checks

```text
vocab-app/dist/       HTML, CSS, browser modules (editable source)
vocab-app/server.mjs  Local server using Node built-ins
vocab-app/database.mjs SQLite schema, transactions, migration, and backups
data/wordwell.sqlite Persistent local database (created at startup)
vocab-app/deepseek.mjs Vocabulary prompt and entry validation
vocab-app/ai-client.mjs Provider-specific requests and response parsing
vocab-app/ai-settings.mjs Private provider settings and legacy migration
vocab-app/ai-models.mjs Authenticated model catalogs and pagination
vocab-app/dist/settings.js First-run setup and Settings UI
data/ai-settings.json Private credentials (created locally, never commit)
vocab-app/writing.mjs IELTS assessment and image validation
vocab-app/dist/writing*.js Writing UI, draft storage, and input validation
vocab-app/tests/      Scheduling, storage, and backup tests
```

```sh
npm test
node --check vocab-app/dist/app.js
```

There is no build step or third-party runtime dependency. Code uses two-space indentation, ES modules, and descriptive names. The app expects a modern desktop browser with native dialogs. Browser storage is read only to migrate older data. SQLite uses [Node's built-in module](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
