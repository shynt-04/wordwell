import { cleanFields, normalizedWord } from './notebook.js';
import { IMAGE_LIMIT, IMAGE_PATTERN } from './writing-data.js';

export const MAX_PASSAGE_IMAGES = 4;
export const PASSAGE_LIMITS = { title: 120, passage: 24000, questions: 10000, answerNotes: 6000, unfamiliar: 1200 };
export const PRIORITIES = { 'learn-now': 'Learn now', 'consider-later': 'Consider later', 'context-only': 'Understand here only' };
export const RELATIONSHIPS = { synonym: 'Contextual synonym', paraphrase: 'Paraphrase', related: 'Related, not equivalent', none: 'No question connection' };

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function bounded(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || required && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('Some passage fields are missing or too long.');
  return value.trim();
}

export function validatePassageInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['type', ...Object.keys(PASSAGE_LIMITS)].includes(key)) || !['reading', 'listening'].includes(input.type)) throw new Error('Choose Reading or Listening and provide your material.');
  const result = { type: input.type };
  for (const [key, limit] of Object.entries(PASSAGE_LIMITS)) result[key] = bounded(input[key] ?? '', limit, key === 'passage');
  return result;
}

export function validateExtractionInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['section', 'images'].includes(key)) || !['passage', 'questions'].includes(input.section)
    || !Array.isArray(input.images) || !input.images.length || input.images.length > MAX_PASSAGE_IMAGES) throw new Error('Attach 1 to 4 screenshots for the passage or questions.');
  const images = input.images.map(image => {
    if (typeof image !== 'string' || image.length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 100) throw new Error('Each prepared image must be smaller than 2 MB.');
    const match = image.match(IMAGE_PATTERN);
    if (!match || match[2].length % 4 !== 0 || match[2].length * 3 / 4 - (match[2].match(/=+$/u)?.[0].length || 0) > IMAGE_LIMIT) throw new Error('Use PNG, JPEG, or WebP screenshots up to 2 MB each.');
    return image;
  });
  return { section: input.section, images };
}

export function validateExtractionResult(input, section) {
  if (!object(input) || !Array.isArray(input.warnings) || input.warnings.length > 6) throw new Error('The extracted text is incomplete. Try clearer screenshots or paste text instead.');
  return { text: bounded(input.text, PASSAGE_LIMITS[section], true), warnings: input.warnings.map(item => bounded(item, 400, true)) };
}

export function validatePassageResult(input, request) {
  if (!object(input) || !Array.isArray(input.suggestions) || input.suggestions.length > 8 || !Array.isArray(input.limitations) || input.limitations.length > 10) throw new Error('The vocabulary suggestions are incomplete. Please try again.');
  const result = { summary: bounded(input.summary, 1000, true), limitations: input.limitations.map(item => bounded(item, 400, true)), suggestions: [] };
  const seen = new Set();
  let omitted = 0;
  let unmatched = 0;
  for (const item of input.suggestions) {
    if (!object(item) || !Object.hasOwn(PRIORITIES, item.priority) || !Object.hasOwn(RELATIONSHIPS, item.relationship)) throw new Error('The AI returned an invalid vocabulary priority or connection.');
    const fields = cleanFields({ word: item.word, meaning: item.meaning, pronunciation: item.pronunciation ?? '', synonyms: item.synonyms ?? '', example: '', note: '' });
    if (/[\r\n]/u.test(fields.word) || !/\p{L}/u.test(fields.word) || !/^[^\r\n]+\r?\n->\s*[^\r\n]+$/u.test(fields.meaning)) throw new Error('The AI returned an incomplete word or Vietnamese meaning.');
    const suggestion = {
      word: fields.word, meaning: fields.meaning, pronunciation: fields.pronunciation, synonyms: fields.synonyms,
      priority: item.priority, reason: bounded(item.reason, 400, true),
      sourceQuote: bounded(item.sourceQuote, 800, true), sourcePhrase: bounded(item.sourcePhrase, 120, true),
      questionQuote: bounded(item.questionQuote ?? '', 600), questionPhrase: bounded(item.questionPhrase ?? '', 120),
      relationship: item.relationship, connection: bounded(item.connection ?? '', 400),
    };
    // Source evidence must actually occur in the reviewed text. Never create
    // cards from fabricated quotes, even when the rest of the answer looks valid.
    const name = normalizedWord(suggestion.word);
    if (!request.passage.includes(suggestion.sourceQuote) || !suggestion.sourceQuote.includes(suggestion.sourcePhrase) || seen.has(name)) { omitted++; continue; }
    if (suggestion.relationship !== 'none' && (!suggestion.questionQuote || !suggestion.questionPhrase || !suggestion.connection
      || !request.questions.includes(suggestion.questionQuote) || !suggestion.questionQuote.includes(suggestion.questionPhrase))) {
      unmatched++;
      suggestion.relationship = 'none';
    }
    if (suggestion.relationship === 'none') Object.assign(suggestion, { questionQuote: '', questionPhrase: '', connection: '' });
    seen.add(name);
    result.suggestions.push(suggestion);
  }
  if (omitted) result.limitations.push('Some duplicate suggestions or unsupported source quotations were omitted.');
  if (unmatched) result.limitations.push('Some question connections could not be verified against your text and were removed.');
  return result;
}

export function passageCardFields(suggestion, input) {
  const note = [`${input.type === 'listening' ? 'Listening transcript' : 'Reading passage'}${input.title ? `: ${input.title}` : ''}`,
    `${PRIORITIES[suggestion.priority]}: ${suggestion.reason}`];
  if (suggestion.relationship !== 'none') note.push(`Question: ${suggestion.questionQuote}`, `${RELATIONSHIPS[suggestion.relationship]}: ${suggestion.questionPhrase} ↔ ${suggestion.sourcePhrase}`, suggestion.connection);
  return cleanFields({ word: suggestion.word, meaning: suggestion.meaning, pronunciation: suggestion.pronunciation, synonyms: suggestion.synonyms, example: suggestion.sourceQuote, note: note.join('\n\n') });
}

export function newPassageCards(fields, existingWords) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 8) throw new Error('Choose 1 to 8 cards to save.');
  const names = new Set(existingWords.map(word => normalizedWord(word.word)));
  const fresh = [];
  let skipped = 0;
  for (const input of fields) {
    const clean = cleanFields(input);
    const name = normalizedWord(clean.word);
    if (names.has(name)) { skipped++; continue; }
    names.add(name); fresh.push(clean);
  }
  return { fields: fresh, skipped };
}
