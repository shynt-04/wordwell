import { STORAGE_KEY, validateNotebook } from './notebook.js';
import { blankWritingDraft, validateWritingDraft, createWritingStore as openBrowserWritingStore } from './writing-data.js';

async function request(path, options = {}) {
  let response;
  try { response = await fetch(`/api/storage/${path}`, options); }
  catch { throw new Error('Cannot reach the local database. Keep Wordwell’s server running and try again.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Restart Wordwell with npm run dev and refresh to enable SQLite storage.'); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'The database request failed. Your saved data has not been replaced.');
  return data;
}

const send = (path, method, value) => {
  const body = JSON.stringify(value);
  return request(path, { method, headers: { 'Content-Type': 'application/json' }, body, keepalive: new TextEncoder().encode(body).length < 60_000 });
};

export function createNotebookStore() {
  let revision = null;
  return {
    migrationWarning: '',
    async read() {
      let data = await request('notebook');
      revision = data.revision;
      this.migrationWarning = '';
      let old;
      try { old = localStorage.getItem(STORAGE_KEY); }
      catch { this.migrationWarning = 'Browser storage could not be read for migration. Existing SQLite data is available.'; }
      if (old !== null && old !== undefined) {
        let incoming;
        try { incoming = validateNotebook(JSON.parse(old)); }
        catch { this.migrationWarning = 'Your old browser notebook could not be imported. It has been preserved; download a browser recovery copy from Backup & restore.'; }
        if (incoming) {
          data = await send('migrate', 'POST', { kind: 'notebook', value: incoming });
          revision = data.revision;
        }
      }
      return validateNotebook(data.notebook);
    },
    async save(value) {
      if (revision === null) throw new Error('Load the local database before saving. Refresh Wordwell and try again.');
      const result = await send('notebook', 'PUT', { revision, value });
      revision = result.revision;
    },
  };
}

export function createServerWritingStore() {
  let revision = null;
  return {
    migrationWarning: '',
    async read() {
      let data = await request('writing');
      revision = data.revision;
      let legacyStore;
      let legacy;
      try {
        const browserDatabase = globalThis.indexedDB;
        const databases = browserDatabase && typeof browserDatabase.databases === 'function' ? await browserDatabase.databases() : null;
        if (browserDatabase && (!databases || databases.some(database => database.name === 'wordwell-writing'))) {
          legacyStore = await openBrowserWritingStore();
          legacy = await legacyStore.read();
        }
      } catch { this.migrationWarning = 'The old browser Writing draft could not be imported. It has been preserved.'; }
      finally { legacyStore?.close(); }
      if (legacy && (legacy.question || legacy.essay || legacy.image || legacy.assessment)) {
        data = await send('migrate', 'POST', { kind: 'writing', value: legacy });
        revision = data.revision;
        if (data.archived) this.migrationWarning = 'Your browser draft was archived in SQLite. The current database draft is shown.';
      }
      return data.draft ? validateWritingDraft(data.draft) : blankWritingDraft();
    },
    async save(value) {
      if (revision === null) throw new Error('Refresh to load the database before saving your Writing draft.');
      const data = await send('writing', 'PUT', { revision, value });
      revision = data.revision;
    },
    close() {},
  };
}
