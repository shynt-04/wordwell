export const WRITING_FIELDS = ['task', 'question', 'essay', 'image', 'feedbackLanguage'];
export const IMAGE_LIMIT = 2 * 1024 * 1024;
export const IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u;

export function countWords(text) {
  return text.trim().split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

export function blankWritingDraft() {
  return { version: 1, task: 'task2', question: '', essay: '', image: '', imageName: '', feedbackLanguage: 'vi', assessment: null, assessedInput: null, updatedAt: Date.now() };
}

export function validateWritingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !WRITING_FIELDS.includes(key))) throw new Error('Send your question, essay, and task type.');
  if (!['task1', 'task2'].includes(input.task)) throw new Error('Choose Writing Task 1 or Task 2.');
  if (!['vi', 'en'].includes(input.feedbackLanguage)) throw new Error('Choose English or Vietnamese feedback.');
  const result = { task: input.task, feedbackLanguage: input.feedbackLanguage };
  for (const [name, limit] of [['question', 6000], ['essay', 16000], ['image', Math.ceil(IMAGE_LIMIT * 4 / 3) + 100]]) {
    if (typeof input[name] !== 'string' || input[name].length > limit) throw new Error(`${name === 'image' ? 'Image' : name === 'essay' ? 'Essay' : 'Question'} is missing or too large.`);
    result[name] = name === 'image' ? input[name] : input[name].trim();
  }
  if (!result.question && !result.image) throw new Error('Enter a question or attach the question image.');
  if (!result.essay) throw new Error('Write or paste your essay first.');
  if (result.image) {
    const match = result.image.match(IMAGE_PATTERN);
    if (!match || match[2].length % 4 !== 0 || match[2].length * 3 / 4 - (match[2].match(/=+$/u)?.[0].length || 0) > IMAGE_LIMIT) throw new Error('Use a PNG, JPEG, or WebP image up to 2 MB.');
  }
  return result;
}

export function sameWritingInput(a, b) {
  return Boolean(a && b && WRITING_FIELDS.every(name => a[name] === b[name]));
}

export function isWritingAssessment(value) {
  const string = (item, limit) => typeof item === 'string' && item.length <= limit;
  const band = item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 9 && item * 2 % 1 === 0;
  const list = (items, limit = 8) => Array.isArray(items) && items.length <= limit && items.every(item => string(item, 1200));
  return Boolean(value && band(value.overallBand) && ['task', 'coherence', 'vocabulary', 'grammar'].every(name => band(value.criteria?.[name]?.band) && string(value.criteria[name].reason, 2000))
    && string(value.summary, 2500) && ['low', 'medium', 'high'].includes(value.confidence) && list(value.strengths) && list(value.priorities)
    && list(value.limitations, 12) && string(value.revisedEssay, 20000) && string(value.imageSummary, 2500)
    && Number.isInteger(value.wordCount) && value.wordCount >= 0 && Number.isFinite(value.evaluatedAt)
    && Array.isArray(value.corrections) && value.corrections.length <= 20 && value.corrections.every(item => item
      && ['grammar', 'vocabulary', 'spelling', 'punctuation', 'style'].includes(item.category)
      && string(item.original, 1000) && string(item.replacement, 1500) && string(item.reason, 1200)));
}

export function validateWritingDraft(input) {
  if (!input || input.version !== 1 || !['task1', 'task2'].includes(input.task) || !['en', 'vi'].includes(input.feedbackLanguage)) throw new Error('This Writing draft cannot be loaded.');
  const draft = { ...blankWritingDraft(), ...input };
  if (typeof draft.question !== 'string' || draft.question.length > 6000 || typeof draft.essay !== 'string' || draft.essay.length > 16000 || typeof draft.image !== 'string' || draft.image.length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 100 || (draft.image && !IMAGE_PATTERN.test(draft.image)) || typeof draft.imageName !== 'string' || draft.imageName.length > 200) throw new Error('This Writing draft cannot be loaded.');
  if (draft.assessment) {
    if (!isWritingAssessment(draft.assessment)) throw new Error('Saved Writing feedback cannot be loaded. Your stored draft has been preserved.');
    validateWritingInput(draft.assessedInput);
  } else draft.assessedInput = null;
  return draft;
}

// Images use a separate database so they do not consume vocabulary local-storage space.
export async function createWritingStore(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw new Error('Your browser does not support saving Writing drafts.');
  const database = await new Promise((resolve, reject) => {
    const request = indexedDBImpl.open('wordwell-writing', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open the Writing draft storage.'));
    request.onblocked = () => reject(new Error('Close other Wordwell tabs and refresh to open Writing drafts.'));
  });
  database.onversionchange = () => database.close();
  return {
    read: () => new Promise((resolve, reject) => {
      const request = database.transaction('drafts', 'readonly').objectStore('drafts').get('current');
      request.onsuccess = () => { try { resolve(request.result ? validateWritingDraft(request.result) : blankWritingDraft()); } catch (error) { reject(error); } };
      request.onerror = () => reject(new Error('Could not read your saved Writing draft.'));
    }),
    save: draft => new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put(draft, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Your Writing draft could not be saved. Copy your essay before leaving.'));
      transaction.onabort = () => reject(new Error('Your Writing draft could not be saved. Copy your essay before leaving.'));
    }),
    close: () => database.close(),
  };
}
