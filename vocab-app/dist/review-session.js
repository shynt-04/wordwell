import { reviewProgress, normalizedWord } from './notebook.js';

export function createReviewSession(words, direction = 'meaning', now = Date.now()) {
  const queue = words.filter(word => reviewProgress(word, direction).dueAt <= now)
    .map(word => ({ id: word.id, readyAt: reviewProgress(word, direction).dueAt }))
    .sort((a, b) => a.readyAt - b.readyAt);
  return { direction, queue, total: queue.length, completed: 0, revealed: false, answer: '', forgot: false };
}

export function readyCard(session, now = Date.now()) {
  if (session.currentId) return session.queue.find(card => card.id === session.currentId && card.readyAt <= now) || null;
  return session.queue.find(card => card.readyAt <= now) || null;
}

export function retryDelay(session, now = Date.now()) {
  return session.queue.length ? Math.max(0, Math.min(...session.queue.map(card => card.readyAt)) - now) : 0;
}

// Only call after the rating has been saved successfully.
export function completeCard(session, id, rating, dueAt) {
  session.queue = session.queue.filter(card => card.id !== id);
  if (rating === 'again') session.queue.push({ id, readyAt: dueAt });
  else session.completed++;
  session.revealed = false;
  session.answer = '';
  session.forgot = false;
  session.currentId = null;
}

export function answerMatches(answer, word) {
  return normalizedWord(answer).replace(/\s+/g, ' ') === normalizedWord(word).replace(/\s+/g, ' ');
}
