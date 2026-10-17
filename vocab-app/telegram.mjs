import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createTelegramStore, validateTelegramConfig, tokenNamespace } from './telegram-settings.mjs';
import { telegramCall, TelegramError } from './telegram-api.mjs';
import { LookupError, completeVocabulary, validateLookup } from './deepseek.mjs';
import { createWord, cleanFields, normalizedWord, scheduleWord, reviewProgress, practiceStreak } from './dist/notebook.js';
import { createReviewSession, readyCard, completeCard, answerMatches } from './dist/review-session.js';

const HELP = 'Wordwell commands:\n/review - review up to 5 due words\n/review use - type the word from its meaning\n/add word | meaning - preview a new card\n/suggest word - optional AI card preview\n/stats - progress and due counts\n/pause /resume - daily reminders\n/stop - end the current review\n/help - this message';
const nonce = () => randomBytes(12).toString('hex');
const dayParts = (now, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
const dateKey = (now, zone) => { const p = dayParts(now, zone); return `${p.year}-${p.month}-${p.day}`; };
const progressKey = (word, direction) => {
  const progress = reviewProgress(word, direction);
  return createHash('sha256').update(JSON.stringify({ content: ['word', 'meaning', 'pronunciation', 'synonyms', 'example', 'note'].map(key => word[key]), progress: ['dueAt', 'interval', 'repetitions', 'lapses', 'lastReviewedAt'].map(key => progress[key]) })).digest('hex');
};

export async function createTelegramGateway({ database, path = null, desktop = false, fetchImpl = fetch, clock = Date.now, getAI, aiCompleter = completeVocabulary, autoPoll = true, onChange = () => {} } = {}) {
  const store = await createTelegramStore({ path, desktop, clock });
  let controller = null, loop = null, timer = null, closed = false, runtimeError = '', running = false;
  let operations = Promise.resolve(), review = null, card = null, draft = null;
  let reminderError = '';
  const serial = task => { const result = operations.then(task); operations = result.catch(() => {}); return result; };
  function alive(signal) { if (closed || signal?.aborted) throw new TelegramError('Telegram request stopped.'); }
  const call = (method, payload, signal = controller?.signal, token = store.active().token) => telegramCall(token, method, payload, { fetchImpl, signal });
  const state = () => ({ ...store.publicState(), running, error: store.publicState().error || runtimeError || reminderError });
  const changed = () => { try { onChange({ keepRunningTray: store.active().keepRunningTray }); } catch { /* Native view failure must not expose secrets. */ } };
  function authorized(message, from = message?.from) {
    const owner = store.active().owner;
    return Boolean(owner && message?.chat?.type === 'private' && message.chat.id === owner.chatId && from?.id === owner.userId && from.is_bot === false);
  }
  async function send(text, buttons = [], signal = controller?.signal) {
    alive(signal);
    const owner = store.active().owner;
    if (!owner) throw new TelegramError('Link your Telegram account first.', 400);
    return call('sendMessage', { chat_id: owner.chatId, text: text.slice(0, 4000), ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }, signal);
  }
  const button = (text, action, id) => ({ text, callback_data: `${id}:${action}` });
  async function removeButtons(messageId, signal) {
    try { await call('editMessageReplyMarkup', { chat_id: store.active().owner.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, signal); }
    catch { /* Old messages may have been deleted. Their nonce is invalid anyway. */ }
  }
  async function preview(fields, signal) {
    alive(signal);
    fields = cleanFields(fields);
    if (database.read('notebook').notebook.words.some(word => normalizedWord(word.word) === normalizedWord(fields.word))) { await send('This word is already in your notebook. Its notes and progress were not changed.', [], signal); return; }
    const pending = { fields, id: nonce(), expiresAt: clock() + 10 * 60_000, messageId: null };
    const details = [fields.word, fields.meaning, fields.pronunciation, fields.synonyms && `Synonyms: ${fields.synonyms}`, fields.example].filter(Boolean).join('\n\n').slice(0, 3400);
    const response = await send(`Card preview (not saved):\n\n${details}\n\nCheck it before saving. To edit, use /add word | corrected meaning. This preview expires in 10 minutes.`, [[button('Save card', 'save', pending.id), button('Cancel', 'cancel', pending.id)]], signal);
    alive(signal); pending.messageId = response.message_id; draft = pending;
  }
  async function showNext(signal) {
    if (!review || card) return;
    if (review.expiresAt <= clock()) { review = null; return; }
    const words = database.read('notebook').notebook.words;
    review.queue = review.queue.filter(item => words.some(word => word.id === item.id));
    // Skip queued words reviewed on the desktop after this Telegram session began.
    review.queue = review.queue.filter(item => {
      const word = words.find(word => word.id === item.id);
      return reviewProgress(word, review.direction).dueAt <= clock() || item.readyAt > clock();
    });
    const next = readyCard(review, clock());
    if (!next) {
      if (!review.queue.length) { const count = review.completed; review = null; await send(`Session finished. ${count} words completed. Small sessions count!`, [], signal); }
      return;
    }
    const word = words.find(word => word.id === next.id);
    const pending = { id: nonce(), wordId: word.id, direction: review.direction, fingerprint: progressKey(word, review.direction), messageId: null, revealed: false, expiresAt: review.expiresAt };
    review.currentId = word.id;
    const text = review.direction === 'word' ? `Use it\n\n${word.meaning}\n\nType the English word, or choose Show answer. Rate your own recall afterward.` : `Understand\n\n${word.word}\n\nRemember its meaning, then reveal the answer.`;
    const response = await send(text, [[button('Show answer', 'reveal', pending.id)]], signal);
    alive(signal); pending.messageId = response.message_id; card = pending;
  }
  async function reveal(answer, signal) {
    if (!card || card.revealed || !review) return;
    const word = database.read('notebook').notebook.words.find(word => word.id === card.wordId);
    if (!word || progressKey(word, card.direction) !== card.fingerprint) { await staleCard(signal); return; }
    const original = card;
    const feedback = answer ? `Your answer: ${answer}\n${answerMatches(answer, word.word) ? 'Exact match.' : 'Not an exact match. A synonym may still be a good answer; rate your own recall.'}\n\n` : '';
    const details = [word.word, word.meaning, word.pronunciation, word.synonyms, word.example].filter(Boolean).join('\n\n').slice(0, 3300);
    const response = await send(`${feedback}${details}\n\nHow well did you remember?`, [[button('Again', 'again', original.id), button('Hard', 'hard', original.id)], [button('Good', 'good', original.id), button('Easy', 'easy', original.id)]], signal);
    alive(signal); original.revealed = true; const previous = original.messageId; original.messageId = response.message_id;
    await removeButtons(previous, signal);
  }
  async function staleCard(signal) {
    card = null; review = null;
    await send('This card changed or was reviewed elsewhere. Nothing was overwritten. Use /review to start a fresh session.', [], signal);
  }
  async function callback(update, signal) {
    const query = update.callback_query;
    if (!query || !authorized(query.message, query.from) || typeof query.id !== 'string' || query.id.length > 200 || typeof query.data !== 'string' || query.data.length > 64) return;
    const [id, action, extra] = query.data.split(':');
    const pending = draft?.id === id ? draft : card?.id === id ? card : null;
    const valid = !extra && pending && pending.expiresAt > clock() && pending.messageId === query.message.message_id;
    await call('answerCallbackQuery', { callback_query_id: query.id, ...(valid ? {} : { text: 'This button has expired or was already used.' }) }, signal);
    alive(signal);
    if (!valid) return;
    if (pending === draft) {
      if (!['save', 'cancel'].includes(action)) return;
      if (action === 'cancel') { draft = null; await removeButtons(pending.messageId, signal); await send('Preview cancelled. No card was saved.', [], signal); return; }
      const namespace = tokenNamespace(store.active().token);
      const result = database.mutateNotebook(namespace, update.update_id, notebook => {
        if (notebook.words.some(word => normalizedWord(word.word) === normalizedWord(pending.fields.word))) return { status: 'exists' };
        return { notebook: { ...notebook, words: [...notebook.words, createWord(pending.fields, clock())] }, status: 'saved' };
      });
      draft = null;
      await removeButtons(pending.messageId, signal);
      await send(result.duplicate || result.status === 'exists' ? 'Already saved. Existing notes and progress were kept.' : `Saved: ${pending.fields.word}.`, [], signal);
      return;
    }
    if (!review) return;
    if (action === 'reveal') { await reveal('', signal); return; }
    if (!pending.revealed || !['again', 'hard', 'good', 'easy'].includes(action)) return;
    const result = database.mutateNotebook(tokenNamespace(store.active().token), update.update_id, notebook => {
      const word = notebook.words.find(word => word.id === pending.wordId);
      if (!word || progressKey(word, pending.direction) !== pending.fingerprint) return { status: 'stale' };
      const scheduled = scheduleWord(word, action, clock(), pending.direction);
      return { notebook: { ...notebook, words: notebook.words.map(item => item.id === word.id ? scheduled : item), reviews: [...notebook.reviews, { id: randomUUID(), wordId: word.id, rating: action, at: clock(), direction: pending.direction }] }, status: 'reviewed', dueAt: reviewProgress(scheduled, pending.direction).dueAt };
    });
    if (result.duplicate) { card = null; review = null; return; }
    if (result.status === 'stale') { await staleCard(signal); return; }
    completeCard(review, pending.wordId, action, result.dueAt); card = null;
    await removeButtons(pending.messageId, signal);
    if (action === 'again') await send('Saved. This word can return after one minute. Keep Wordwell running, or use /stop to finish for now.', [], signal);
    await showNext(signal);
  }
  async function message(update, signal) {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string' || msg.text.length > 4096) return;
    const text = msg.text.trim();
    const match = text.match(/^\/(\w+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/u);
    if (match?.[2] && match[2].toLowerCase() !== store.active().username.toLowerCase()) return;
    if (match?.[1] === 'start' && !store.active().owner) {
      if (await store.claim(match[3], msg)) { alive(signal); changed(); await send(`Your private Wordwell notebook is linked. Only this Telegram account can use it.\n\n${HELP}`, [], signal); }
      return;
    }
    if (!authorized(msg)) return;
    if (!match) {
      if (card?.direction === 'word' && !card.revealed && text && text.length <= 120) await reveal(text, signal);
      else await send('Use /help for commands. Add a card with /add word | meaning.', [], signal);
      return;
    }
    const command = match[1].toLowerCase(), args = (match[3] || '').trim();
    if (['start', 'help'].includes(command)) { await send(HELP, [], signal); return; }
    if (['pause', 'resume'].includes(command)) {
      await store.update(next => { next.paused = command === 'pause'; }, true); changed();
      await send(command === 'pause' ? 'Daily reminders paused. Reviews and adding cards still work.' : store.active().reminders ? 'Daily reminders resumed. Keep Wordwell running and your computer awake.' : 'Reminders are unpaused. Turn on daily reminders in Wordwell to receive them.', [], signal); return;
    }
    if (command === 'stop') { card = null; review = null; await send('Review stopped. Completed reviews are saved. Use /review whenever you are ready.', [], signal); return; }
    if (command === 'stats') {
      const config = store.active(), notebook = database.read('notebook').notebook, now = clock();
      const understand = notebook.words.filter(word => reviewProgress(word, 'meaning').dueAt <= now).length;
      const productive = notebook.words.filter(word => reviewProgress(word, 'word').dueAt <= now).length;
      const today = notebook.reviews.filter(item => dateKey(item.at, config.timeZone) === dateKey(now, config.timeZone)).length;
      await send(`${notebook.words.length} words saved\nUnderstand: ${understand} due\nUse it: ${productive} due\nReviews today (${config.timeZone}): ${today}\nPractice streak: ${practiceStreak(notebook.reviews, now)} days`, [], signal); return;
    }
    if (command === 'review') {
      if (!['', 'use', 'understand'].includes(args.toLowerCase())) { await send('Use /review or /review use.', [], signal); return; }
      if (review) { await send('A review is already active. Answer the current card or use /stop first.', [], signal); return; }
      review = { ...createReviewSession(database.read('notebook').notebook.words, args.toLowerCase() === 'use' ? 'word' : 'meaning', clock()), expiresAt: clock() + 30 * 60_000 };
      review.queue = review.queue.slice(0, 5); review.total = review.queue.length;
      if (!review.total) { review = null; await send('No words are due in this direction. Take a breather or add a new word.', [], signal); return; }
      await showNext(signal); return;
    }
    if (command === 'add') {
      const separator = args.indexOf('|');
      if (separator < 1) { await send('Use /add word | meaning\nExample: /add portable | Easy to carry. -> Có thể mang theo', [], signal); return; }
      let fields;
      try { fields = cleanFields({ word: validateLookup({ word: args.slice(0, separator) }), meaning: args.slice(separator + 1), note: 'Added via Telegram.' }); }
      catch { await send('Enter a word (up to 120 characters) and a meaning (up to 2000 characters), separated by |.', [], signal); return; }
      await preview(fields, signal); return;
    }
    if (command === 'suggest') {
      if (!store.active().allowAI || !getAI) { await send('AI suggestions are off. Enable Allow /suggest in Wordwell Settings, or use /add word | meaning without AI.', [], signal); return; }
      let word;
      try { word = validateLookup({ word: args }); } catch { await send('Use /suggest followed by an English word or phrase (up to 120 characters).', [], signal); return; }
      if (database.read('notebook').notebook.words.some(item => normalizedWord(item.word) === normalizedWord(word))) { await send('This word already exists. No AI request was made, and its notes and progress were kept.', [], signal); return; }
      // Claim the update before a potentially paid call so a restart/replayed
      // update cannot silently charge the same suggestion twice.
      const receipt = database.mutateNotebook(tokenNamespace(store.active().token), update.update_id, () => ({}));
      if (receipt.duplicate) return;
      await send('Preparing an AI preview. Your configured provider may charge for this request. Nothing will be saved automatically.', [], signal);
      try {
        const configuration = await getAI(); alive(signal);
        const fields = await aiCompleter(word, { ...configuration, signal }); alive(signal);
        await preview({ ...fields, word, note: 'AI suggestion reviewed and saved via Telegram.' }, signal);
      } catch { alive(signal); await send('AI could not complete this word. Check your AI Settings, or use /add word | meaning.', [], signal); }
      return;
    }
    await send('Unknown command. Use /help to see the available commands.', [], signal);
  }
  async function handle(update, signal = controller?.signal) {
    alive(signal);
    if (!store.active().enabled || !Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id < store.active().offset) return;
    if (database.hasGatewayReceipt(tokenNamespace(store.active().token), update.update_id)) return;
    if (update.callback_query) await callback(update, signal);
    else if (update.message) await message(update, signal);
  }
  async function tick(signal = controller?.signal) {
    alive(signal);
    const config = store.active();
    if (!config.enabled || !config.owner) return;
    if (draft && draft.expiresAt <= clock()) draft = null;
    if (review && review.expiresAt <= clock()) { review = null; card = null; }
    await showNext(signal);
    if (!config.reminders || config.paused) return;
    const parts = dayParts(clock(), config.timeZone), day = `${parts.year}-${parts.month}-${parts.day}`;
    if (`${parts.hour}:${parts.minute}` < config.reminderTime || config.lastReminder === day) return;
    const words = database.read('notebook').notebook.words;
    const understand = words.filter(word => reviewProgress(word, 'meaning').dueAt <= clock()).length;
    const use = words.filter(word => reviewProgress(word, 'word').dueAt <= clock()).length;
    if (!understand && !use) return;
    // At most one daily attempt, including across restarts. A failed delivery is
    // visible in Settings; use Send test to check connectivity manually.
    await store.update(next => { next.lastReminder = day; }); alive(signal);
    await send(`A few words, every day.\n\nUnderstand: ${understand} ready\nUse it: ${use} ready\n\nUse /review for a small session, /review use for a challenge, or /pause to mute reminders.`, [], signal);
  }
  function stop() { controller?.abort(); controller = null; clearInterval(timer); timer = null; running = false; card = null; draft = null; review = null; }
  function start() {
    stop(); if (closed || !store.active().enabled || store.publicState().error) return;
    const current = new AbortController(); controller = current;
    if (!autoPoll) return;
    const token = store.active().token;
    running = true; runtimeError = ''; reminderError = '';
    let scheduled = false;
    timer = setInterval(() => {
      if (scheduled || current.signal.aborted) return;
      scheduled = true;
      void serial(() => tick(current.signal)).catch(error => { if (!current.signal.aborted) reminderError = error instanceof TelegramError ? error.message : 'Telegram reminders could not be processed. Check the local data folder.'; }).finally(() => { scheduled = false; });
    }, 5000); timer.unref();
    loop = (async () => {
      while (!current.signal.aborted && !closed) {
        try {
          const updates = await call('getUpdates', { offset: store.active().offset, timeout: 25, limit: 30, allowed_updates: ['message', 'callback_query'] }, current.signal, token);
          alive(current.signal);
          if (!Array.isArray(updates) || updates.length > 100) throw new TelegramError('Telegram returned unreadable updates.');
          runtimeError = '';
          for (const update of updates) {
            alive(current.signal);
            if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) continue;
            await serial(() => handle(update, current.signal)); alive(current.signal);
            await store.update(next => { next.offset = Math.max(next.offset, update.update_id + 1); });
          }
          // Avoid a tight loop with empty immediate responses or mock transports.
          await wait(200, current.signal);
        } catch (error) {
          if (current.signal.aborted || closed) break;
          runtimeError = error instanceof TelegramError ? error.message : 'Telegram could not process an update. Check the local data folder and try again.';
          if (error instanceof TelegramError && [401, 409, 403].includes(error.status)) break;
          await wait(Math.max(5000, (error.retryAfter || 0) * 1000), current.signal);
        }
      }
      if (controller === current) { current.abort(); running = false; clearInterval(timer); timer = null; }
    })().catch(() => { if (controller === current) { running = false; runtimeError = 'Telegram stopped. Reload and save its settings to reconnect.'; } });
  }
  return {
    state, start,
    stop() { closed = true; stop(); },
    idle: () => Promise.allSettled([loop, operations]),
    handleUpdate: update => serial(() => handle(update)),
    tick: () => serial(() => tick()),
    async configure(payload) {
      if (store.publicState().error) throw new LookupError(store.publicState().error, 500);
      const input = validateTelegramConfig(payload, desktop);
      store.checkRevision(input.revision);
      const previous = store.active(), token = input.token || previous.token;
      if (input.enabled && !token) throw new LookupError('Enter a bot token before enabling Telegram.', 400);
      let username = previous.username;
      if (input.enabled) {
        const me = await telegramCall(token, 'getMe', {}, { fetchImpl });
        if (me?.is_bot !== true || !/^[A-Za-z0-9_]{5,32}$/u.test(me.username || '')) throw new TelegramError('Telegram did not return a valid bot account.');
        const webhook = await telegramCall(token, 'getWebhookInfo', {}, { fetchImpl });
        if (typeof webhook?.url !== 'string' || webhook.url) throw new LookupError('This bot has a webhook. Wordwell will not remove it. Create a separate bot in BotFather.', 400);
        username = me.username;
      } else if (token !== previous.token) username = '';
      alive();
      await store.save(input, username); runtimeError = ''; reminderError = ''; start(); changed(); return state();
    },
    async pair(revision) { alive(); const result = await store.pair(revision); changed(); return { ...state(), pairing: result }; },
    async disconnect(revision) { alive(); await store.disconnect(revision); stop(); runtimeError = ''; reminderError = ''; changed(); return state(); },
    async test(revision) { alive(); store.checkRevision(revision); if (!store.active().enabled || !store.active().owner) throw new LookupError('Enable Telegram and link your account first.', 400); await send('Wordwell is connected. Use /help to see your commands.'); reminderError = ''; return state(); },
  };
}

function wait(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds); timer.unref();
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
