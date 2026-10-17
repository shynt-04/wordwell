import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { LookupError } from './ai-errors.mjs';

export const tokenValid = value => typeof value === 'string' && /^\d{5,20}:[A-Za-z0-9_-]{20,150}$/u.test(value);
export const tokenNamespace = token => createHash('sha256').update(token).digest('hex');
const blank = () => ({ version: 1, revision: 0, token: '', username: '', enabled: false, owner: null, pairing: null, offset: 0, reminders: false, reminderTime: '19:00', timeZone: 'Asia/Bangkok', lastReminder: '', paused: false, allowAI: false, keepRunningTray: false });

export function validateTelegramConfig(input, desktop = false) {
  const keys = ['revision', 'token', 'enabled', 'reminders', 'reminderTime', 'timeZone', 'allowAI', 'keepRunningTray'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new LookupError('Reload Telegram settings before saving.', 400);
  for (const key of ['enabled', 'reminders', 'allowAI', 'keepRunningTray']) if (typeof input[key] !== 'boolean') throw new LookupError('Choose the Telegram options.', 400);
  if (typeof input.token !== 'string' || input.token.length > 180 || input.token && !tokenValid(input.token.trim())) throw new LookupError('Enter the bot token provided by BotFather.', 400);
  if (typeof input.reminderTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(input.reminderTime)) throw new LookupError('Choose a reminder time, such as 19:00.', 400);
  if (typeof input.timeZone !== 'string' || input.timeZone.length > 80) throw new LookupError('Choose a valid time zone.', 400);
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(); }
  catch { throw new LookupError('Enter a time zone such as Asia/Bangkok or Europe/London.', 400); }
  if (input.keepRunningTray && !desktop) throw new LookupError('Background tray mode is available only in the portable app.', 400);
  return { ...input, token: input.token.trim() };
}

export async function createTelegramStore({ path = null, desktop = false, clock = Date.now } = {}) {
  let state = blank(), failure = '', queue = Promise.resolve();
  if (path) {
    try {
      const input = JSON.parse(await readFile(path, 'utf8'));
      const preferences = validateTelegramConfig({ ...Object.fromEntries(['revision', 'enabled', 'reminders', 'reminderTime', 'timeZone', 'allowAI', 'keepRunningTray'].map(key => [key, input[key]])), token: input.token }, true);
      if (input.version !== 1 || typeof input.username !== 'string' || input.username && !/^[A-Za-z0-9_]{5,32}$/u.test(input.username) || !Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.paused !== 'boolean' || typeof input.lastReminder !== 'string' || input.lastReminder.length > 100 || input.owner !== null && (!Number.isSafeInteger(input.owner?.userId) || input.owner.userId <= 0 || input.owner.chatId !== input.owner.userId) || input.pairing !== null && (!/^[a-f0-9]{64}$/u.test(input.pairing?.hash) || !Number.isSafeInteger(input.pairing?.expiresAt) || !Number.isSafeInteger(input.pairing?.createdAt))) throw new Error('Invalid Telegram settings');
      state = { ...blank(), ...preferences, username: input.username, owner: input.owner && { userId: input.owner.userId, chatId: input.owner.chatId }, pairing: input.pairing, offset: input.offset, paused: input.paused, lastReminder: input.lastReminder };
      if (state.enabled && (!state.token || !state.username)) throw new Error('Incomplete Telegram settings');
    } catch (error) { if (error.code !== 'ENOENT') failure = 'Telegram settings could not be read. The file has not been overwritten. Recover data/telegram-settings.json and restart Wordwell.'; }
  }
  async function persist(next) {
    if (path) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await rename(temporary, path); }
      catch { throw new LookupError('Telegram settings could not be saved. Check write access to the data folder.', 500); }
      finally { await unlink(temporary).catch(() => {}); }
    }
    state = next;
  }
  function update(change, configuration = false) {
    const task = queue.then(async () => {
      if (failure) throw new LookupError(failure, 500);
      const next = structuredClone(state);
      const result = change(next);
      if (configuration) next.revision++;
      if (JSON.stringify(next) !== JSON.stringify(state)) await persist(next);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }
  function checkRevision(revision) { if (!Number.isSafeInteger(revision) || revision !== state.revision) throw new LookupError('Telegram settings changed. Reload them before trying again.', 409); }
  return {
    active: () => structuredClone(state),
    publicState: () => ({ revision: state.revision, hasToken: Boolean(state.token), username: state.username, enabled: state.enabled, linked: Boolean(state.owner), reminders: state.reminders, reminderTime: state.reminderTime, timeZone: state.timeZone, paused: state.paused, allowAI: state.allowAI, keepRunningTray: state.keepRunningTray, desktop, pairingExpiresAt: state.pairing?.expiresAt > clock() ? state.pairing.expiresAt : null, error: failure }),
    checkRevision,
    update,
    async save(input, username) {
      return update(next => {
        checkRevision(input.revision);
        const token = input.token || next.token;
        if (token !== next.token) Object.assign(next, { owner: null, pairing: null, offset: 0, lastReminder: '', paused: false });
        Object.assign(next, Object.fromEntries(['enabled', 'reminders', 'reminderTime', 'timeZone', 'allowAI', 'keepRunningTray'].map(key => [key, input[key]])), { token, username });
      }, true);
    },
    async pair(revision) {
      const code = randomBytes(18).toString('hex');
      const expiresAt = clock() + 10 * 60_000;
      await update(next => {
        checkRevision(revision);
        if (!next.enabled || !next.token || !next.username) throw new LookupError('Save and enable your bot before linking an account.', 400);
        if (next.owner) throw new LookupError('An account is already linked. Disconnect it first.', 400);
        next.pairing = { hash: tokenNamespace(code), createdAt: clock(), expiresAt };
      }, true);
      return { code, expiresAt, url: `https://t.me/${state.username}?start=${code}` };
    },
    async claim(code, message) {
      let claimed = false;
      await update(next => {
        const pair = next.pairing;
        if (next.owner || !next.enabled || !pair || clock() >= pair.expiresAt || typeof code !== 'string' || !/^[a-f0-9]{36}$/u.test(code) || !Number.isSafeInteger(message?.date) || message.date < Math.floor(pair.createdAt / 1000) - 5 || message.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) || message.from.id <= 0 || message.from.is_bot !== false || message.chat.id !== message.from.id) return;
        if (!timingSafeEqual(Buffer.from(pair.hash, 'hex'), Buffer.from(tokenNamespace(code), 'hex'))) return;
        next.owner = { userId: message.from.id, chatId: message.chat.id }; next.pairing = null; next.revision++; claimed = true;
      });
      return claimed;
    },
    async disconnect(revision) {
      await update(next => { checkRevision(revision); const previousRevision = next.revision; Object.assign(next, blank(), { revision: previousRevision }); }, true);
    },
  };
}
