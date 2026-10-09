export const STORAGE_KEY = 'wordwell.notebook.v1';
export const DAY = 86_400_000;
const LIMITS = { word: 120, meaning: 2000, pronunciation: 160, synonyms: 500, example: 3000, note: 3000 };

export function cleanFields(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter a word and its meaning.');
  const fields = {};
  for (const [name, limit] of Object.entries(LIMITS)) {
    if (input[name] !== undefined && typeof input[name] !== 'string') throw new Error(`Invalid ${name}.`);
    fields[name] = (input[name] || '').trim();
    if (fields[name].length > limit) throw new Error(`${name} is too long (maximum ${limit} characters).`);
  }
  if (!fields.word || !fields.meaning) throw new Error('A word and meaning are required.');
  return fields;
}

export function createWord(input, now = Date.now()) {
  return { ...cleanFields(input), id: crypto.randomUUID(), createdAt: now, updatedAt: now, dueAt: now, interval: 0, repetitions: 0, lapses: 0, lastReviewedAt: null, production: freshProgress(now) };
}

function freshProgress(now) { return { updatedAt: now, dueAt: now, interval: 0, repetitions: 0, lapses: 0, lastReviewedAt: null }; }

export function reviewProgress(word, direction = 'meaning') {
  if (!['meaning', 'word'].includes(direction)) throw new Error('Choose a valid review direction.');
  return direction === 'word' ? word.production || freshProgress(word.createdAt) : word;
}

export function normalizedWord(word) { return word.trim().normalize('NFKC').toLocaleLowerCase('en'); }

export function nextInterval(word, rating) {
  const interval = Math.max(0, word.interval || 0);
  switch (rating) {
    case 'again': return 60_000 / DAY;
    case 'hard': return Math.max(1, Math.round(interval * 1.2));
    case 'good': return word.repetitions === 0 || interval < 1 ? 1 : word.repetitions === 1 ? Math.max(3, Math.round(interval * 2.5)) : Math.max(1, Math.round(interval * 2.5));
    case 'easy': return Math.max(4, Math.round(interval * 3.2));
    default: throw new Error('Choose Again, Hard, Good, or Easy.');
  }
}

export function scheduleWord(word, rating, now = Date.now(), direction = 'meaning') {
  const progress = reviewProgress(word, direction);
  const interval = nextInterval(progress, rating);
  const scheduled = { interval, dueAt: now + Math.round(interval * DAY), lastReviewedAt: now, updatedAt: now, repetitions: rating === 'again' ? 0 : progress.repetitions + 1, lapses: progress.lapses + (rating === 'again' ? 1 : 0) };
  return direction === 'word' ? { ...word, production: scheduled } : { ...word, ...scheduled };
}

export function localDate(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function practiceStreak(log, now = Date.now()) {
  const days = new Set(log.map(item => localDate(item.at)));
  const cursor = new Date(now);
  if (!days.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(localDate(cursor))) { count++; cursor.setDate(cursor.getDate() - 1); }
  return count;
}

export function emptyNotebook() { return { version: 2, words: [], reviews: [] }; }

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid backup: ${name}.`);
  return value;
}

export function validateNotebook(input) {
  if (!input || typeof input !== 'object' || ![1, 2].includes(input.version) || !Array.isArray(input.words) || !Array.isArray(input.reviews)) throw new Error('This is not a supported Wordwell backup.');
  if (input.words.length > 50_000 || input.reviews.length > 200_000) throw new Error('This backup is too large.');
  const ids = new Set();
  const names = new Set();
  const words = input.words.map(word => {
    if (!word || typeof word.id !== 'string' || !word.id || word.id.length > 100 || ids.has(word.id)) throw new Error('Invalid backup: duplicate or missing word ID.');
    ids.add(word.id);
    const clean = { ...cleanFields(word), id: word.id };
    const name = normalizedWord(clean.word);
    if (names.has(name)) throw new Error('Invalid backup: duplicate vocabulary entries.');
    names.add(name);
    for (const field of ['createdAt', 'updatedAt', 'dueAt', 'interval', 'repetitions', 'lapses']) clean[field] = finite(word[field], field);
    for (const field of ['createdAt', 'updatedAt', 'dueAt']) if (Number.isNaN(new Date(clean[field]).getTime())) throw new Error('Invalid backup: date outside supported range.');
    if (!Number.isInteger(clean.repetitions) || !Number.isInteger(clean.lapses)) throw new Error('Invalid backup: review counts.');
    clean.lastReviewedAt = word.lastReviewedAt === null ? null : finite(word.lastReviewedAt, 'lastReviewedAt');
    if (clean.lastReviewedAt !== null && Number.isNaN(new Date(clean.lastReviewedAt).getTime())) throw new Error('Invalid backup: review date outside supported range.');
    const production = word.production ?? (input.version === 1 ? freshProgress(clean.createdAt) : null);
    if (!production || typeof production !== 'object') throw new Error('Invalid backup: word recall progress.');
    clean.production = {};
    for (const field of ['updatedAt', 'dueAt', 'interval', 'repetitions', 'lapses']) clean.production[field] = finite(production[field], `word recall ${field}`);
    for (const field of ['updatedAt', 'dueAt']) if (Number.isNaN(new Date(clean.production[field]).getTime())) throw new Error('Invalid backup: word recall date.');
    if (!Number.isInteger(production.repetitions) || !Number.isInteger(production.lapses)) throw new Error('Invalid backup: word recall counts.');
    clean.production.lastReviewedAt = production.lastReviewedAt === null ? null : finite(production.lastReviewedAt, 'word recall lastReviewedAt');
    if (clean.production.lastReviewedAt !== null && Number.isNaN(new Date(clean.production.lastReviewedAt).getTime())) throw new Error('Invalid backup: word recall review date.');
    return clean;
  });
  const reviewIds = new Set();
  const reviews = input.reviews.map(review => {
    if (!review || typeof review.id !== 'string' || !review.id || review.id.length > 100 || reviewIds.has(review.id) || typeof review.wordId !== 'string' || !review.wordId || review.wordId.length > 100 || !['again', 'hard', 'good', 'easy'].includes(review.rating)) throw new Error('Invalid backup: review history.');
    reviewIds.add(review.id);
    const direction = review.direction ?? 'meaning';
    if (!['meaning', 'word'].includes(direction)) throw new Error('Invalid backup: review direction.');
    return { id: review.id, wordId: review.wordId, rating: review.rating, at: finite(review.at, 'review timestamp'), direction };
  });
  return { version: 2, words, reviews };
}

export function mergeNotebooks(current, incoming) {
  current = validateNotebook(current);
  incoming = validateNotebook(incoming);
  const words = current.words.map(word => ({ ...word }));
  const byId = new Map(words.map(word => [word.id, word]));
  const byName = new Map(words.map(word => [normalizedWord(word.word), word]));
  const aliases = new Map();
  let added = 0;
  for (const word of incoming.words) {
    const existing = byId.get(word.id) || byName.get(normalizedWord(word.word));
    if (existing) {
      aliases.set(word.id, existing.id);
      // Content edits must not overwrite newer practice in either direction.
      const recognition = (word.lastReviewedAt ?? -1) > (existing.lastReviewedAt ?? -1) ? word : existing;
      const production = word.production.updatedAt > existing.production.updatedAt ? word.production : existing.production;
      const schedule = Object.fromEntries(['dueAt', 'interval', 'repetitions', 'lapses', 'lastReviewedAt'].map(key => [key, recognition[key]]));
      if (word.updatedAt > existing.updatedAt) {
        byName.delete(normalizedWord(existing.word));
        Object.assign(existing, word, { id: existing.id });
        byName.set(normalizedWord(existing.word), existing);
      }
      Object.assign(existing, schedule, { production });
    } else {
      const copy = { ...word };
      words.push(copy);
      byId.set(copy.id, copy);
      byName.set(normalizedWord(copy.word), copy);
      added++;
    }
  }
  const reviews = new Map(current.reviews.map(review => [review.id, { ...review }]));
  for (const review of incoming.reviews) if (!reviews.has(review.id)) reviews.set(review.id, { ...review, wordId: aliases.get(review.wordId) || review.wordId });
  const notebook = validateNotebook({ version: 2, words, reviews: [...reviews.values()].sort((a, b) => a.at - b.at) });
  return { notebook, added };
}

export function loadNotebook(storage) {
  const saved = storage.getItem(STORAGE_KEY);
  return saved === null ? emptyNotebook() : validateNotebook(JSON.parse(saved));
}

export function saveNotebook(storage, notebook) { storage.setItem(STORAGE_KEY, JSON.stringify(notebook)); }
