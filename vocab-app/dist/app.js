import { DAY, STORAGE_KEY, cleanFields, createWord, normalizedWord, nextInterval, scheduleWord, localDate, practiceStreak, emptyNotebook, validateNotebook, mergeNotebooks } from './notebook.js';
import { wireAutofill } from './autofill.js';
import { initWriting } from './writing.js';
import { createNotebookStore } from './persistence.js';
import { initSettings } from './settings.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let notebook = emptyNotebook();
let storageBlocked = true;
let storageError = 'Loading the local database…';
let commitPending = false;
let loadPending = false;
const notebookStore = createNotebookStore();
let activeFilter = 'all';
let editId = null;
let session = null;
let toastTimer;
let undoDelete = null;

function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}

async function commit(next) {
  if (storageBlocked) { notify('Saving is unavailable. Export a recovery copy or restore a valid backup first.', true); return false; }
  if (commitPending) { notify('A save is already running. Please try again after it finishes.'); return false; }
  commitPending = true;
  const buttons = $$('button[type="submit"], [data-action="rate"]').filter(button => !button.disabled && !button.closest('#writing-form') && !button.closest('#settings-form'));
  buttons.forEach(button => { button.disabled = true; });
  try {
    await notebookStore.save(next);
    notebook = next;
    render();
    return true;
  } catch (error) { notify(`Could not save: ${error.message}`, true); return false; }
  finally { commitPending = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
}

async function loadDatabase() {
  if (loadPending || commitPending || session || $('#edit-dialog').open) return;
  loadPending = true;
  storageBlocked = true;
  storageError = 'Loading the local database…';
  try {
    notebook = await notebookStore.read();
    storageBlocked = false;
    storageError = '';
    if (notebookStore.migrationWarning) notify(notebookStore.migrationWarning, true);
  } catch (error) { storageBlocked = true; storageError = error.message; }
  finally { loadPending = false; render(); }
}

function setView(view) {
  if (!['today', 'library', 'writing', 'backup', 'settings'].includes(view)) view = 'today';
  for (const section of $$('.view')) section.hidden = section.id !== `${view}-view`;
  for (const button of $$('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${view}`);
  if (view === 'library') renderLibrary();
  $('#workspace-title').textContent = view === 'settings' ? 'AI settings' : view === 'writing' ? 'IELTS writing' : 'IELTS vocabulary';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function focusAdd() { setView('today'); $('#word').focus(); $('#word').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
function dueWords() { return notebook.words.filter(word => word.dueAt <= Date.now()).sort((a, b) => a.dueAt - b.dueAt); }
function getWord(id) { return notebook.words.find(word => word.id === id); }
function badge(word) { return word.repetitions === 0 ? '<span class="badge due">New</span>' : word.dueAt <= Date.now() ? '<span class="badge due">Due now</span>' : '<span class="badge">Learning</span>'; }
function nextReviewLabel(word) {
  if (word.dueAt <= Date.now()) return 'Ready to review';
  const remaining = word.dueAt - Date.now();
  if (remaining < 3_600_000) return `In ${Math.max(1, Math.ceil(remaining / 60_000))} min`;
  if (remaining < DAY) return `In ${Math.ceil(remaining / 3_600_000)} hours`;
  return `Review ${new Date(word.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function emptyState(search = false) {
  return `<div class="empty-notebook">${icon('book')}<h3>${search ? 'No words match just yet.' : 'Your notebook starts with one word.'}</h3><p>${search ? 'Try another search or choose All words.' : 'Add something you want to remember using the quick entry form.'}</p>${search ? '' : '<button class="text-button" data-action="samples">Try 3 IELTS starter words</button>'}</div>`;
}

function render() {
  const due = dueWords().length;
  const reviewed = new Set(notebook.reviews.filter(review => localDate(review.at) === localDate()).map(review => review.wordId)).size;
  $('#nav-due').textContent = due;
  $('#nav-total').textContent = notebook.words.length;
  $('#total-stat').textContent = notebook.words.length;
  $('#reviews-stat').textContent = reviewed;
  $('#streak-stat').innerHTML = `${practiceStreak(notebook.reviews)} <small>days</small>`;
  $('#due-number').textContent = due;
  $('#today-date').textContent = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  $('#review-title').textContent = !notebook.words.length ? 'Make it stick.' : due ? 'Make it stick.' : 'You’re all caught up.';
  $('#review-description').textContent = !notebook.words.length ? 'Add your first word to begin your practice.' : due ? `${due} ${due === 1 ? 'word is' : 'words are'} ready. Take a few minutes for your future self.` : `Your next review is ${nextDueDescription()}. Add a new word while you’re here.`;
  $('#start-review').textContent = due ? `Start review · ${due} ${due === 1 ? 'word' : 'words'}` : !notebook.words.length ? 'Add your first word' : 'Catch a new word';
  $('#recent-count').textContent = notebook.words.length;
  const recent = [...notebook.words].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  $('#recent-words').innerHTML = recent.length ? recent.map(word => `<button class="word-row" data-action="detail" data-id="${escape(word.id)}"><span class="word-initial">${escape(word.word[0].toUpperCase())}</span><div class="word-info"><div class="word-title"><strong>${escape(word.word)}</strong>${word.pronunciation ? `<span class="ipa">${escape(word.pronunciation)}</span>` : ''}</div><p class="word-summary">${escape(word.meaning)}</p></div>${badge(word)}</button>`).join('') : emptyState();
  renderLibrary();
  updateStorageBanner();
}

function nextDueDescription() {
  if (!notebook.words.length) return 'not scheduled yet';
  const next = Math.min(...notebook.words.map(word => word.dueAt));
  return new Date(next).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderLibrary() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const words = notebook.words.filter(word => (!query || [word.word, word.meaning, word.pronunciation, word.synonyms, word.example, word.note].join(' ').toLocaleLowerCase().includes(query)) && (activeFilter === 'all' || activeFilter === 'due' && word.dueAt <= Date.now() || activeFilter === 'new' && word.repetitions === 0));
  const sort = $('#sort').value;
  words.sort(sort === 'alphabetical' ? (a, b) => a.word.localeCompare(b.word) : sort === 'due' ? (a, b) => a.dueAt - b.dueAt : (a, b) => b.createdAt - a.createdAt);
  $('#library-count').textContent = `${words.length} ${words.length === 1 ? 'word' : 'words'}${query || activeFilter !== 'all' ? ` of ${notebook.words.length}` : ' in your notebook'}`;
  $('#library-words').innerHTML = words.length ? words.map(word => `<button class="library-card" data-action="detail" data-id="${escape(word.id)}">${badge(word)}<div class="word-title"><strong>${escape(word.word)}</strong></div>${word.pronunciation ? `<p class="ipa">${escape(word.pronunciation)}</p>` : ''}<p class="definition">${escape(word.meaning)}</p><div class="card-footer"><span>${escape(nextReviewLabel(word))}</span>${icon('book')}</div></button>`).join('') : emptyState(Boolean(query || activeFilter !== 'all'));
}

function updateStorageBanner() {
  const existing = $('#storage-error');
  if (!storageBlocked) { existing?.remove(); return; }
  const banner = existing || document.createElement('div');
  banner.id = 'storage-error'; banner.className = 'storage-error'; banner.setAttribute('role', 'alert');
  banner.innerHTML = `${escape(storageError || 'Your database could not be loaded.')} Saved data has not been overwritten. <button class="text-button" id="retry-database">Retry</button> <button class="text-button" id="recover-data">Download browser recovery copy</button>`;
  if (!existing) $('.content').prepend(banner);
  $('#recover-data').onclick = exportBrowserRecovery;
  $('#retry-database').onclick = () => { void loadDatabase(); };
}

async function addWord(fields) {
  const word = createWord(fields);
  if (notebook.words.some(existing => normalizedWord(existing.word) === normalizedWord(word.word))) throw new Error('This word is already in your notebook. Find it in My vocabulary to edit it.');
  if (!await commit({ ...notebook, words: [...notebook.words, word] })) throw new Error('Your word could not be saved. Please check the storage message.');
  return word;
}

async function handleAdd(event) {
  event.preventDefault(); $('#add-error').hidden = true;
  try {
    const fields = Object.fromEntries(new FormData($('#add-form')));
    const word = await addWord(fields);
    if (Object.entries(fields).every(([name, value]) => $('#add-form').elements.namedItem(name)?.value === value)) $('#add-form').reset();
    $('#word').focus();
    notify(`“${word.word}” is in your notebook. Ready to review.`);
  } catch (failure) { $('#add-error').textContent = failure.message; $('#add-error').hidden = false; }
}

function details(word) {
  return `<span class="detail-label">MEANING</span><p class="detail-text">${escape(word.meaning)}</p>${word.synonyms ? `<span class="detail-label">SYNONYMS</span><p class="detail-text">${escape(word.synonyms)}</p>` : ''}${word.example ? `<span class="detail-label">IN A SENTENCE</span><p class="detail-text example-block">${escape(word.example)}</p>` : ''}${word.note ? `<span class="detail-label">YOUR NOTE</span><p class="detail-text">${escape(word.note)}</p>` : ''}`;
}

function showDetail(id) {
  const word = getWord(id); if (!word) return;
  $('#word-detail').innerHTML = `<div class="dialog-heading">${badge(word)}<button class="icon-button" data-close="word-dialog" aria-label="Close word details">${icon('close')}</button></div><div class="detail-title"><h2>${escape(word.word)}</h2><button class="icon-button" data-action="speak" data-id="${escape(word.id)}" aria-label="Listen to ${escape(word.word)}">${icon('audio')}</button></div>${word.pronunciation ? `<p class="detail-ipa">${escape(word.pronunciation)}</p>` : ''}${details(word)}<p class="detail-meta">${escape(nextReviewLabel(word))} · ${word.repetitions} successful ${word.repetitions === 1 ? 'review' : 'reviews'} since last reset</p><div class="detail-actions"><button class="button secondary" data-action="edit" data-id="${escape(word.id)}">${icon('edit')}Edit word</button><button class="button danger" data-action="delete" data-id="${escape(word.id)}">${icon('trash')}Delete</button></div>`;
  $('#word-dialog').showModal();
}

function speak(word) {
  if (!('speechSynthesis' in window)) { notify('Audio is unavailable in this browser. You can still add pronunciation as text.', true); return; }
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(item => item.lang.toLowerCase() === 'en-gb') || voices.find(item => item.lang.toLowerCase().startsWith('en'));
  const utterance = new SpeechSynthesisUtterance(word.word);
  utterance.lang = 'en-GB'; utterance.rate = 0.86; if (voice) utterance.voice = voice;
  utterance.onerror = event => { if (event.error !== 'interrupted' && event.error !== 'canceled') notify('Audio could not play. Check that an English voice is installed.', true); };
  speechSynthesis.cancel(); speechSynthesis.speak(utterance);
}

function showEditor(id) {
  const word = getWord(id); if (!word) return;
  editId = id; $('#word-dialog').close();
  for (const name of ['word', 'meaning', 'pronunciation', 'synonyms', 'example', 'note']) $(`#edit-${name}`).value = word[name];
  $('#edit-error').hidden = true; $('#edit-dialog').showModal(); $('#edit-word').focus();
}

async function handleEdit(event) {
  event.preventDefault(); const word = getWord(editId); if (!word) return;
  try {
    const fields = cleanFields(Object.fromEntries(new FormData($('#edit-form'))));
    if (notebook.words.some(existing => existing.id !== editId && normalizedWord(existing.word) === normalizedWord(fields.word))) throw new Error('Another entry already has this word.');
    const edited = { ...word, ...fields, updatedAt: Date.now() };
    if (!await commit({ ...notebook, words: notebook.words.map(item => item.id === editId ? edited : item) })) return;
    $('#edit-dialog').close(); notify('Changes saved. Your review schedule stays the same.');
  } catch (failure) { $('#edit-error').textContent = failure.message; $('#edit-error').hidden = false; }
}

function confirmAction(title, description, actions) {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-actions').replaceChildren();
  const cancel = document.createElement('button'); cancel.className = 'button secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => $('#confirm-dialog').close(); $('#confirm-actions').append(cancel);
  for (const action of actions) {
    const button = document.createElement('button'); button.className = `button ${action.danger ? 'danger' : 'primary'}`; button.textContent = action.label;
    button.onclick = () => { $('#confirm-dialog').close(); action.run(); }; $('#confirm-actions').append(button);
  }
  $('#confirm-dialog').showModal(); cancel.focus();
}

function requestDelete(id) {
  const word = getWord(id); if (!word) return;
  confirmAction(`Delete “${word.word}”?`, 'This removes the word and its schedule. Your practice history stays. You can undo the deletion until you close or reload the app.', [{ label: 'Delete word', danger: true, run: async () => {
    if (!await commit({ ...notebook, words: notebook.words.filter(item => item.id !== id) })) return;
    undoDelete = word; $('#word-dialog').close(); $('#backup-status').textContent = 'A word was deleted. You can undo it here before reloading.';
    if (!$('#undo-delete')) {
      const undo = document.createElement('button'); undo.id = 'undo-delete'; undo.className = 'button secondary'; undo.textContent = 'Undo last deletion';
      undo.onclick = async () => {
        if (!undoDelete) return;
        if (notebook.words.some(item => normalizedWord(item.word) === normalizedWord(undoDelete.word))) { notify('A word with this name already exists. Rename it before restoring.', true); return; }
        if (await commit({ ...notebook, words: [...notebook.words, undoDelete] })) { undoDelete = null; undo.remove(); $('#backup-status').textContent = 'Deleted word restored.'; notify('Word restored.'); }
      };
      $('#backup-status').after(undo);
    }
    notify('Word deleted. Undo is available in Backup & restore.');
  } }]);
}

function startReview() {
  if (storageBlocked) { notify('Restore your notebook before starting a review.', true); return; }
  const queue = dueWords().map(word => word.id); if (!queue.length) { focusAdd(); return; }
  session = { queue, total: queue.length, completed: 0, revealed: false }; renderReview(); $('#review-dialog').showModal(); $('[data-action="reveal"]').focus();
}

function renderReview() {
  if (!session) return;
  const word = getWord(session.queue[0]);
  if (!word && session.queue.length) { session.queue.shift(); session.total--; renderReview(); return; }
  if (!session.queue.length) {
    $('#review-content').innerHTML = `<div class="session-complete"><div class="success-circle">${icon('check')}</div><h2>A little more remembered.</h2><p>You worked through ${session.completed} ${session.completed === 1 ? 'word' : 'words'}. Your next reviews are scheduled. Come back for another small session.</p><button class="button primary" data-action="finish-review">Back to my notebook</button></div>`;
    if ($('#review-dialog').open) $('[data-action="finish-review"]').focus();
    return;
  }
  const percentage = session.total ? session.completed / session.total * 100 : 0;
  $('#review-content').innerHTML = `<div class="review-header"><h2>Daily practice</h2><button class="icon-button" data-action="exit-review" aria-label="End review session">${icon('close')}</button></div><div class="review-progress" role="progressbar" aria-label="Words completed" aria-valuemin="0" aria-valuemax="${session.total}" aria-valuenow="${session.completed}"><div style="width:${percentage}%"></div></div><div class="review-body"><div class="review-counter">${session.completed} OF ${session.total} WORDS COMPLETED</div><h2 class="review-word">${escape(word.word)}</h2>${session.revealed ? `<div class="review-audio">${word.pronunciation ? `<span>${escape(word.pronunciation)}</span>` : ''}<button class="icon-button" data-action="speak" data-id="${escape(word.id)}" aria-label="Listen to pronunciation">${icon('audio')}</button></div><div class="review-answer">${details(word)}</div>` : '<p class="review-prompt">What does it mean? Recall it before you reveal it.</p>'}</div><div class="review-bottom">${session.revealed ? `<p>How well did you remember it?</p><div class="ratings">${['again', 'hard', 'good', 'easy'].map(rating => `<button class="rating ${rating}" data-action="rate" data-rating="${rating}"><strong>${rating[0].toUpperCase() + rating.slice(1)}</strong><span>${rating === 'again' ? 'Repeat this session' : intervalLabel(nextInterval(word, rating))}</span></button>`).join('')}</div><div class="review-shortcuts"><kbd>1</kbd> Again &nbsp; <kbd>2</kbd> Hard &nbsp; <kbd>3</kbd> Good &nbsp; <kbd>4</kbd> Easy</div>` : '<button class="button primary reveal-button" data-action="reveal">Reveal meaning</button><div class="review-shortcuts">Press <kbd>Space</kbd> to reveal</div>'}</div>`;
  if ($('#review-dialog').open) $(session.revealed ? '[data-rating="good"]' : '[data-action="reveal"]').focus();
}

function intervalLabel(interval) { return interval < 1 ? '1 minute' : interval === 1 ? '1 day' : `${interval} days`; }
function reveal() { if (!session || !session.queue.length) return; session.revealed = true; renderReview(); }
async function rate(rating) {
  if (!session?.revealed || !session.queue.length) return;
  const reviewedSession = session;
  const id = session.queue[0]; const word = getWord(id); if (!word) return;
  const now = Date.now(); const scheduled = scheduleWord(word, rating, now);
  const next = { ...notebook, words: notebook.words.map(item => item.id === id ? scheduled : item), reviews: [...notebook.reviews, { id: crypto.randomUUID(), wordId: id, rating, at: now }] };
  if (!await commit(next)) return;
  if (session !== reviewedSession) return;
  session.queue.shift(); if (rating === 'again') session.queue.push(id); else session.completed++;
  session.revealed = false; renderReview();
}

function finishReview() { $('#review-dialog').close(); session = null; render(); }
function exitReview() {
  if (!session?.queue.length) { finishReview(); return; }
  confirmAction('Finish for now?', 'Your completed reviews are saved. Unfinished words stay in your review queue.', [{ label: 'Finish for now', run: finishReview }]);
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBackup() {
  if (storageBlocked) {
    exportBrowserRecovery(); return;
  }
  download(JSON.stringify({ ...notebook, exportedAt: new Date().toISOString() }, null, 2), `wordwell-backup-${localDate()}.json`); notify('Backup downloaded. Keep it somewhere safe.');
}

function exportBrowserRecovery() {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { download(raw, 'wordwell-browser-recovery.json'); notify('Old browser data downloaded.'); } else notify('No old browser notebook was found.', true); }
  catch { notify('Your browser is blocking access to the old notebook.', true); }
}

async function exportDatabase() {
  if (commitPending || loadPending) { notify('Wait for the current database operation to finish before downloading a backup.'); return; }
  const button = $('#export-database');
  button.disabled = true;
  try {
    const writing = await writingReady;
    await writing.flush();
    const response = await fetch('/api/storage/backup');
    if (!response.ok) throw new Error('Could not download the database. Keep Wordwell’s server running and try again.');
    const blob = await response.blob();
    if (blob.type !== 'application/vnd.sqlite3') throw new Error('Restart Wordwell to enable database backups.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `wordwell-${localDate()}.sqlite`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('SQLite backup downloaded, including vocabulary and saved Writing data.');
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
}

async function importBackup(file) {
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose a backup smaller than 20 MB.');
    const incoming = validateNotebook(JSON.parse(await file.text()));
    const apply = async mode => {
      if (commitPending || loadPending) { notify('Wait for the current database operation to finish before restoring.'); return; }
      commitPending = true;
      try {
        const merged = mode === 'merge' ? mergeNotebooks(notebook, incoming) : { notebook: incoming, added: incoming.words.length };
        await notebookStore.save(merged.notebook); notebook = merged.notebook; storageBlocked = false; undoDelete = null; $('#undo-delete')?.remove(); render();
        $('#backup-status').textContent = mode === 'merge' ? `Backup combined. ${merged.added} new words added; newer entries and progress retained.` : `Notebook restored: ${notebook.words.length} words.`;
        notify('Your notebook is ready.');
      } catch (failure) { notify(`Backup could not be restored: ${failure.message}`, true); }
      finally { commitPending = false; }
    };
    confirmAction('Restore this notebook?', `This backup contains ${incoming.words.length} words and ${incoming.reviews.length} reviews. Combining keeps the most recently updated entries. Replacing removes your current notebook; download a backup first if you need it.`, [
      ...(!storageBlocked ? [{ label: 'Combine notebooks', run: () => apply('merge') }] : []), { label: 'Replace notebook', danger: true, run: () => apply('replace') },
    ]);
  } catch (failure) { notify(`Could not open backup: ${failure.message}`, true); }
  finally { $('#import-file').value = ''; }
}

async function addSamples() {
  const samples = [
    { word: 'compelling', meaning: 'So interesting or convincing that it holds your attention.', pronunciation: '/kəmˈpelɪŋ/', example: 'The report presents a compelling argument for investing in public transport.', note: 'Useful in IELTS Writing: a compelling argument, compelling evidence.' },
    { word: 'mitigate', meaning: 'To make something harmful or unpleasant less serious.', pronunciation: '/ˈmɪtɪɡeɪt/', example: 'Planting more trees can help mitigate the effects of urban air pollution.', note: 'Useful with: mitigate the impact, mitigate the effects, mitigate a risk.' },
    { word: 'ubiquitous', meaning: 'Present or found everywhere.', pronunciation: '/juːˈbɪkwɪtəs/', example: 'Smartphones have become ubiquitous in modern society.', note: 'Think “everywhere.” A precise word for IELTS topics about technology.' },
  ];
  try {
    const words = samples.filter(sample => !notebook.words.some(word => normalizedWord(word.word) === normalizedWord(sample.word))).map(sample => createWord(sample));
    if (!words.length) { notify('The starter words are already in your notebook.'); return; }
    if (await commit({ ...notebook, words: [...notebook.words, ...words] })) notify(`${words.length} IELTS starter words added. Try your first review.`);
  } catch (failure) { notify(failure.message, true); }
}

const addAutofill = wireAutofill({
  form: $('#add-form'), wordInput: $('#word'), button: $('#autofill'), status: $('#autofill-status'), autoToggle: $('#auto-fill'),
  fields: Object.fromEntries(['meaning', 'pronunciation', 'synonyms', 'example'].map(name => [name, $(`#${name}`)])),
});
const editAutofill = wireAutofill({
  form: $('#edit-form'), wordInput: $('#edit-word'), button: $('#edit-autofill'), status: $('#edit-autofill-status'),
  fields: Object.fromEntries(['meaning', 'pronunciation', 'synonyms', 'example'].map(name => [name, $(`#edit-${name}`)])),
});
$('#edit-dialog').addEventListener('close', () => editAutofill.reset());
$('#add-form').addEventListener('submit', handleAdd); $('#edit-form').addEventListener('submit', handleEdit);
$('#start-review').addEventListener('click', () => dueWords().length ? startReview() : focusAdd());
$('#see-library').addEventListener('click', () => setView('library')); $('#library-add').addEventListener('click', focusAdd);
$('#search').addEventListener('input', renderLibrary); $('#sort').addEventListener('change', renderLibrary);
$('#export-backup').addEventListener('click', exportBackup); $('#import-backup').addEventListener('click', () => $('#import-file').click());
$('#export-database').addEventListener('click', exportDatabase);
$('#export-browser-recovery').addEventListener('click', exportBrowserRecovery);
$('#import-file').addEventListener('change', event => importBackup(event.target.files[0]));
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-filter]').forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  $$('[data-filter]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); }); renderLibrary();
}));

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]'); if (close) { document.getElementById(close.dataset.close).close(); return; }
  const action = event.target.closest('[data-action]'); if (!action) return;
  switch (action.dataset.action) {
    case 'detail': showDetail(action.dataset.id); break;
    case 'speak': { const word = getWord(action.dataset.id); if (word) speak(word); break; }
    case 'edit': showEditor(action.dataset.id); break;
    case 'delete': requestDelete(action.dataset.id); break;
    case 'samples': addSamples(); break;
    case 'reveal': reveal(); break;
    case 'rate': rate(action.dataset.rating); break;
    case 'exit-review': exitReview(); break;
    case 'finish-review': finishReview(); break;
  }
});

document.addEventListener('keydown', event => {
  if (event.repeat) return;
  const editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && editing) {
    const form = event.target.closest('form'); if (form) { event.preventDefault(); form.requestSubmit(); } return;
  }
  if (editing || $('#confirm-dialog').open || !$('#review-dialog').open || !session?.queue.length) return;
  if (event.code === 'Space' && !session.revealed && event.target.dataset.action !== 'exit-review') { event.preventDefault(); reveal(); }
  else if (session.revealed && /^[1-4]$/.test(event.key)) { event.preventDefault(); rate(['again', 'hard', 'good', 'easy'][Number(event.key) - 1]); }
});

$('#review-dialog').addEventListener('cancel', event => { event.preventDefault(); exitReview(); });
$('#review-dialog').addEventListener('close', () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); });
$('#word-dialog').addEventListener('close', () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
setInterval(() => { if (!document.hidden && !$('#review-dialog').open) render(); }, 60_000);
render(); setView(location.hash.slice(1) || 'today');
void loadDatabase();
const writingReady = initWriting();
void initSettings(setView);
window.addEventListener('beforeunload', event => { if (commitPending) { event.preventDefault(); event.returnValue = ''; } });

// Optional browser tool support uses the same actions as the visible app.
const context = document.modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  const tools = [
    { name: 'read_vocabulary', title: 'Read vocabulary', description: 'Read this notebook’s vocabulary and due review count without changing it.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ words: notebook.words.map(({ id, word, meaning, pronunciation, synonyms, example, note, dueAt }) => ({ id, word, meaning, pronunciation, synonyms, example, note, dueAt })), due: dueWords().length }) },
    { name: 'add_vocabulary_word', title: 'Add vocabulary word', description: 'Save a new vocabulary entry to this local notebook and make it ready for review.', inputSchema: { type: 'object', properties: Object.fromEntries(['word', 'meaning', 'pronunciation', 'synonyms', 'example', 'note'].map(name => [name, { type: 'string' }])), required: ['word', 'meaning'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => { const word = await addWord(input); return { id: word.id, word: word.word, saved: true }; } },
    { name: 'start_vocabulary_review', title: 'Start vocabulary review', description: 'Open the due vocabulary review session. This does not grade or complete a review.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: () => { if (!dueWords().length) return { started: false, reason: 'No words due.' }; if (!$('#review-dialog').open) startReview(); return { started: $('#review-dialog').open, words: session?.total || 0 }; } },
  ];
  for (const tool of tools) {
    try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(error => console.warn('Browser tool registration unavailable:', error.message)); }
    catch (error) { console.warn('Browser tool registration unavailable:', error.message); }
  }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
