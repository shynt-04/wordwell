import { normalizedWord, cleanFields } from './notebook.js';
import { prepareImage } from './image-input.js';
import { MAX_PASSAGE_IMAGES, PASSAGE_LIMITS, PRIORITIES, RELATIONSHIPS, validatePassageInput, validatePassageResult, validateExtractionResult, passageCardFields } from './passage-data.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const marked = (quote, phrase) => {
  const at = phrase ? quote.indexOf(phrase) : -1;
  return at < 0 ? escape(quote) : `${escape(quote.slice(0, at))}<mark>${escape(phrase)}</mark>${escape(quote.slice(at + phrase.length))}`;
};

export async function readPassageResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server returned unreadable material. Restart Wordwell and try again; your input is kept.'); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'This AI request could not finish. Your input is kept.');
  return data;
}

export function initPassage({ getNotebook, saveCards, canSave, setView }) {
  const sections = Object.fromEntries(['passage', 'questions'].map(name => [name, { mode: 'text', images: [], revision: 0, extractedRevision: -1, prepareVersion: 0 }]));
  let active = null;
  let preparing = 0;
  let saving = false;
  let vision = false;
  let suggestions = [];
  let resultInput = null;
  let editIndex = null;
  let dirty = false;
  let settingsVersion = 0;
  const status = (message = '', error = false) => {
    $('passage-status').textContent = message;
    $('passage-status').hidden = !message;
    $('passage-status').classList.toggle('error', error);
  };
  const input = () => ({ type: $('passage-type').value, ...Object.fromEntries(Object.keys(PASSAGE_LIMITS).map(name => [name, $(name === 'passage' || name === 'questions' ? `material-${name}` : `passage-${name}`).value])) });
  const stale = () => !resultInput || JSON.stringify(input()) !== JSON.stringify(resultInput) || ['passage', 'questions'].some(name => sections[name].mode === 'image' && sections[name].images.length && sections[name].extractedRevision !== sections[name].revision);
  const imagePending = () => ['passage', 'questions'].some(name => sections[name].mode === 'image' && sections[name].images.length && sections[name].extractedRevision !== sections[name].revision);

  $('passage-inputs').innerHTML = ['passage', 'questions'].map(name => {
    const label = name === 'passage' ? 'Passage or transcript' : 'Questions';
    return `<section class="material-panel" data-material="${name}" aria-labelledby="material-heading-${name}"><div class="material-heading"><h2 id="material-heading-${name}">${label}${name === 'questions' ? ' <small>optional</small>' : ''}</h2><div class="material-modes" role="group" aria-label="${label} input format"><button type="button" data-material-mode="text" data-section="${name}" aria-pressed="true">Text</button><button type="button" data-material-mode="image" data-section="${name}" aria-pressed="false">Images</button></div></div><div id="material-images-${name}" class="material-images" hidden><input id="material-files-${name}" type="file" multiple accept="image/png,image/jpeg,image/webp" hidden><button id="material-drop-${name}" type="button" class="material-drop" data-upload="${name}"><svg aria-hidden="true"><use href="#i-plus"/></svg><strong>Paste a screenshot or choose images</strong><span>Ctrl+V here, or drag files onto this panel. Up to 4 images, in order.</span></button><ol id="material-previews-${name}" class="material-previews"></ol><button type="button" class="button secondary material-extract" data-extract="${name}">Extract to editable text</button><p id="material-image-status-${name}" class="material-image-status" role="status"></p></div><label for="material-${name}" id="material-label-${name}">${name === 'passage' ? 'Paste your passage or listening transcript' : 'Paste questions, including numbers and answer options'}</label><textarea id="material-${name}" rows="${name === 'passage' ? 11 : 7}" maxlength="${PASSAGE_LIMITS[name]}" placeholder="${name === 'passage' ? 'Bring in the passage you just studied…' : 'Questions help reveal synonyms and paraphrases…'}" ${name === 'passage' ? 'required' : ''}></textarea><p class="material-text-help" id="material-help-${name}">Text stays editable. Only submitted material is sent to your AI provider.</p></section>`;
  }).join('');

  function update() {
    const busy = Boolean(active) || preparing > 0 || saving;
    $('passage-analyse').disabled = busy || imagePending();
    $('passage-stop').hidden = !active;
    $('passage-clear').disabled = saving;
    $('passage-stale').hidden = !resultInput || !stale();
    const existing = new Set(getNotebook().words.map(word => normalizedWord(word.word)));
    let selected = 0;
    suggestions.forEach((item, index) => {
      const duplicate = existing.has(normalizedWord(item.fields.word));
      if (duplicate) item.selected = false;
      const checkbox = $(`passage-select-${index}`);
      if (checkbox) { checkbox.checked = item.selected; checkbox.disabled = busy || duplicate || stale(); }
      const duplicateLabel = $(`passage-duplicate-${index}`);
      if (duplicateLabel) duplicateLabel.hidden = !duplicate;
      const edit = $(`passage-edit-${index}`);
      if (edit) edit.disabled = busy || stale();
      if (item.selected && !duplicate) selected++;
    });
    $('passage-save').textContent = selected ? `Save ${selected} selected ${selected === 1 ? 'card' : 'cards'}` : 'Choose cards to save';
    $('passage-save').disabled = busy || stale() || !selected || !canSave();
    $('passage-select-recommended').disabled = busy || stale();
    $('passage-select-none').disabled = busy;
    $('passage-save-note').textContent = canSave() ? 'Existing words are skipped; their notes and review schedules are never replaced.' : 'Notebook saving is unavailable. Load or restore your database before saving cards.';
    for (const [name, section] of Object.entries(sections)) {
      const button = document.querySelector(`[data-extract="${name}"]`);
      button.disabled = busy || !vision || !section.images.length;
      $(`material-image-status-${name}`).textContent = !vision ? 'To extract images, choose an image-capable model and enable image input in Settings. Text still works.' : section.images.length && section.extractedRevision !== section.revision ? 'Extract these images, then check the text below before analysing.' : section.images.length ? 'Extracted text is ready to check and edit below.' : 'Images are resized locally to fit within 2 MB each. Nothing is sent until you click Extract.';
    }
    document.querySelectorAll('#passage-inputs [data-upload], #passage-inputs [data-image-action], #passage-inputs [data-material-mode]').forEach(button => {
      const edge = button.dataset.imageAction === 'up' && button.dataset.index === '0'
        || button.dataset.imageAction === 'down' && Number(button.dataset.index) === sections[button.dataset.section].images.length - 1;
      button.disabled = preparing > 0 || saving || Boolean(edge);
    });
  }

  function stop(message = '') {
    active?.controller.abort(); active = null;
    if (message) status(message);
    update();
  }
  function changed(message) {
    dirty = true;
    stop();
    status(message ?? (resultInput ? 'Your material changed. Analyse again before saving previous suggestions.' : 'Your material stays in this tab. Find words when you are ready.'));
    update();
  }
  function renderImages(name) {
    const section = sections[name];
    $(`material-previews-${name}`).innerHTML = section.images.map((image, index) => `<li><button type="button" class="image-preview-button" data-image-preview="${name}" data-index="${index}" aria-label="Enlarge ${name} screenshot ${index + 1}"><img src="${escape(image.data)}" alt="${name === 'passage' ? 'Passage' : 'Questions'} screenshot ${index + 1}"></button><div><strong>${index + 1}. ${escape(image.name)}</strong><div class="image-order-controls"><button type="button" data-image-action="up" data-section="${name}" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move screenshot ${index + 1} earlier">↑ Earlier</button><button type="button" data-image-action="down" data-section="${name}" data-index="${index}" ${index === section.images.length - 1 ? 'disabled' : ''} aria-label="Move screenshot ${index + 1} later">↓ Later</button><button type="button" data-image-action="remove" data-section="${name}" data-index="${index}" aria-label="Remove screenshot ${index + 1}">Remove</button></div></div></li>`).join('');
    update();
  }
  function setMode(name, mode) {
    sections[name].mode = mode;
    $(`material-images-${name}`).hidden = mode !== 'image';
    document.querySelectorAll(`[data-material-mode][data-section="${name}"]`).forEach(button => button.setAttribute('aria-pressed', String(button.dataset.materialMode === mode)));
    $(`material-label-${name}`).textContent = mode === 'image' ? 'Check and edit extracted text before finding words' : name === 'passage' ? 'Paste your passage or listening transcript' : 'Paste questions, including numbers and answer options';
    $(`material-help-${name}`).textContent = mode === 'image' ? 'Extraction replaces this text only after confirmation. Check numbers, spelling, and [unclear] fragments.' : 'Text mode uses only the text below. Retained screenshots are not sent.';
    stop(); update();
  }
  async function addImages(name, files) {
    if (saving || !files.length) return;
    if (preparing) { status('Screenshots are still being prepared. Please add the next images when that finishes.'); return; }
    const section = sections[name];
    if (section.images.length + files.length > MAX_PASSAGE_IMAGES) { status('Use at most 4 screenshots per section. Remove an image or split the passage into smaller sessions.', true); return; }
    stop(); setMode(name, 'image');
    const version = ++section.prepareVersion;
    preparing++; status('Preparing screenshots locally…'); update();
    try {
      const prepared = await Promise.all(files.map(async file => ({ data: await prepareImage(file), name: (file.name || 'Pasted screenshot').slice(0, 120) })));
      if (version !== section.prepareVersion) return;
      section.images.push(...prepared); section.revision++;
      changed('Screenshots added. Check their order, then extract the text.'); renderImages(name);
    } catch (error) { if (version === section.prepareVersion) status(error.message, true); }
    finally { preparing--; update(); }
  }
  async function request(path, payload, task) {
    const response = await fetch(`/api/passage/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: task.controller.signal });
    return readPassageResponse(response);
  }
  async function extract(name) {
    if (active || preparing || saving || !vision || !sections[name].images.length) return;
    if ($(`material-${name}`).value.trim() && !window.confirm('Replace the text in this section with a new extraction? Copy any edits you want to keep first.')) return;
    const section = sections[name];
    const revision = section.revision;
    const task = { controller: new AbortController() }; active = task;
    status('Reading your screenshots. You will check the extracted text before making cards…'); update();
    try {
      const data = validateExtractionResult(await request('extract', { section: name, images: section.images.map(image => image.data) }, task), name);
      if (active !== task || revision !== section.revision) return;
      $(`material-${name}`).value = data.text;
      section.extractedRevision = revision; dirty = true;
      status(`Text extracted. Check and edit it below.${data.warnings.length ? ` ${data.warnings.join(' ')}` : ''}`, data.warnings.length > 0);
      $(`material-${name}`).focus();
    } catch (error) { if (active === task && !task.controller.signal.aborted) status(error.message, true); }
    finally { if (active === task) active = null; update(); }
  }
  function renderSuggestions() {
    $('passage-candidates').innerHTML = suggestions.map((item, index) => {
      const s = item.suggestion;
      return `<article class="passage-candidate"><div class="candidate-heading"><label class="candidate-choice" for="passage-select-${index}"><input id="passage-select-${index}" type="checkbox" data-select-card="${index}"><strong>${escape(item.fields.word)}</strong></label><span class="priority-badge ${s.priority}">${PRIORITIES[s.priority]}</span></div><p class="candidate-meaning">${escape(item.fields.meaning)}</p><p class="candidate-reason">${escape(s.reason)}</p><div class="source-connection"><div><span class="detail-label">IN YOUR ${resultInput.type === 'listening' ? 'TRANSCRIPT' : 'PASSAGE'}</span><p>${marked(s.sourceQuote, s.sourcePhrase)}</p></div>${s.relationship !== 'none' ? `<div><span class="detail-label">QUESTION WORDING</span><p>${marked(s.questionQuote, s.questionPhrase)}</p></div><div class="connection-explanation"><strong>${RELATIONSHIPS[s.relationship]}</strong><p>${escape(s.connection)}</p></div>` : '<p class="no-connection">No verified question connection. Useful vocabulary can still be worth keeping.</p>'}</div><div class="candidate-footer"><span id="passage-duplicate-${index}" class="badge" hidden>Already in your notebook</span><button id="passage-edit-${index}" type="button" class="text-button" data-edit-card="${index}">Preview / edit card</button></div></article>`;
    }).join('');
    update();
  }
  async function analyse(event) {
    event.preventDefault();
    if (active || preparing || saving) return;
    if (imagePending()) { status('Extract the attached images and check their text first, or switch to Text to use only your pasted text.', true); return; }
    let submitted;
    try { submitted = validatePassageInput(input()); }
    catch (error) { status(error.message, true); return; }
    const snapshot = input();
    const task = { controller: new AbortController() }; active = task;
    status('Looking for a small, useful shortlist and supported question connections…'); update();
    try {
      const data = validatePassageResult(await request('analyse', submitted, task), submitted);
      if (active !== task || JSON.stringify(input()) !== JSON.stringify(snapshot)) return;
      resultInput = snapshot;
      suggestions = data.suggestions.map(suggestion => ({ suggestion, fields: passageCardFields(suggestion, submitted), selected: false }));
      $('passage-summary').textContent = data.summary;
      $('passage-limitations').replaceChildren(...data.limitations.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
      $('passage-limitations').hidden = !data.limitations.length;
      $('passage-results').hidden = false;
      $('passage-no-results').hidden = suggestions.length > 0;
      renderSuggestions();
      status(suggestions.length ? `${suggestions.length} suggestions ready. Choose what you want to keep; nothing has been saved yet.` : 'No grounded vocabulary suggestions were found. Try a clearer excerpt or mark unfamiliar words.');
      $('passage-results').focus({ preventScroll: true });
      $('passage-results').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) { if (active === task && !task.controller.signal.aborted) status(error.message, true); }
    finally { if (active === task) active = null; update(); }
  }
  function editCard(index) {
    if (active || saving || stale()) return;
    editIndex = index;
    for (const name of ['word', 'meaning', 'pronunciation', 'synonyms', 'example', 'note']) $(`passage-edit-${name}`).value = suggestions[index].fields[name];
    $('passage-edit-error').hidden = true;
    $('passage-card-dialog').showModal(); $('passage-edit-word').focus();
  }
  $('passage-card-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editIndex === null || !suggestions[editIndex] || stale()) return;
    try {
      suggestions[editIndex].fields = cleanFields(Object.fromEntries(new FormData(event.target)));
      $('passage-card-dialog').close(); renderSuggestions();
      status('Card preview updated. Select it when you are ready to save.');
    } catch (error) { $('passage-edit-error').textContent = error.message; $('passage-edit-error').hidden = false; }
  });
  $('passage-save').addEventListener('click', async () => {
    if (saving || active || preparing || stale() || !canSave()) return;
    const selected = suggestions.filter(item => item.selected).map(item => ({ ...item.fields }));
    if (!selected.length) return;
    saving = true; update();
    try {
      const { added, skipped } = await saveCards(selected);
      status(`${added} ${added === 1 ? 'card' : 'cards'} saved to your notebook.${skipped ? ` ${skipped} existing or duplicate ${skipped === 1 ? 'word was' : 'words were'} skipped.` : ''} Ready for your next small practice.`);
      suggestions.forEach(item => { item.selected = false; });
    } catch (error) { status(error.message, true); }
    finally { saving = false; update(); }
  });
  $('passage-select-recommended').addEventListener('click', () => { if (active || saving || stale()) return; suggestions.forEach(item => { item.selected = item.suggestion.priority === 'learn-now'; }); update(); });
  $('passage-select-none').addEventListener('click', () => { if (saving) return; suggestions.forEach(item => { item.selected = false; }); update(); });
  $('passage-clear').addEventListener('click', () => {
    if (saving || dirty && !window.confirm('Clear the working material, screenshots and unsaved suggestions? Cards already saved in your notebook will stay.')) return;
    stop();
    $('passage-form').reset();
    for (const [name, section] of Object.entries(sections)) { section.images = []; section.revision++; section.prepareVersion++; section.extractedRevision = -1; setMode(name, 'text'); renderImages(name); }
    suggestions = []; resultInput = null; dirty = false;
    editIndex = null; $('passage-card-form').reset();
    $('passage-summary').textContent = ''; $('passage-limitations').replaceChildren();
    $('passage-image-large').removeAttribute('src'); $('passage-image-title').textContent = 'Your screenshot';
    $('passage-results').hidden = true; $('passage-candidates').replaceChildren(); status(); update();
  });
  $('passage-form').addEventListener('submit', analyse);
  $('passage-form').addEventListener('input', () => changed());
  $('passage-type').addEventListener('change', () => changed());
  $('passage-stop').addEventListener('click', () => stop('Stopped. Your material is kept in this tab.'));
  $('passage-settings-link').addEventListener('click', () => setView('settings'));
  $('passage-inputs').addEventListener('click', event => {
    const mode = event.target.closest('[data-material-mode]'); if (mode) { setMode(mode.dataset.section, mode.dataset.materialMode); return; }
    const upload = event.target.closest('[data-upload]'); if (upload) { $(`material-files-${upload.dataset.upload}`).click(); return; }
    const extractButton = event.target.closest('[data-extract]'); if (extractButton) { void extract(extractButton.dataset.extract); return; }
    const preview = event.target.closest('[data-image-preview]');
    if (preview) {
      const image = sections[preview.dataset.imagePreview].images[Number(preview.dataset.index)];
      if (!image) return;
      $('passage-image-title').textContent = image.name;
      $('passage-image-large').src = image.data;
      $('passage-image-dialog').showModal(); return;
    }
    const imageAction = event.target.closest('[data-image-action]'); if (!imageAction || saving) return;
    const name = imageAction.dataset.section; const section = sections[name]; const index = Number(imageAction.dataset.index);
    if (!section.images[index]) return;
    if (imageAction.dataset.imageAction === 'remove') section.images.splice(index, 1);
    else { const target = index + (imageAction.dataset.imageAction === 'up' ? -1 : 1); if (!section.images[target]) return; [section.images[index], section.images[target]] = [section.images[target], section.images[index]]; }
    section.revision++; section.prepareVersion++; changed('Image order changed. Extract again before analysing, or switch to Text.'); renderImages(name);
  });
  for (const name of ['passage', 'questions']) {
    $(`material-files-${name}`).addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; void addImages(name, files); });
    const panel = document.querySelector(`[data-material="${name}"]`);
    panel.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); void addImages(name, files); }
    });
    panel.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
    panel.addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); void addImages(name, [...event.dataTransfer.files]); } });
  }
  $('passage-candidates').addEventListener('change', event => { if (event.target.dataset.selectCard !== undefined && !saving && !stale()) { suggestions[Number(event.target.dataset.selectCard)].selected = event.target.checked; update(); } });
  $('passage-candidates').addEventListener('click', event => { const edit = event.target.closest('[data-edit-card]'); if (edit) editCard(Number(edit.dataset.editCard)); });
  $('passage-image-dialog').addEventListener('close', () => $('passage-image-large').removeAttribute('src'));
  async function refreshSettings() {
    const version = ++settingsVersion;
    try {
      const response = await fetch('/api/settings/ai');
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (version !== settingsVersion) return;
      vision = Boolean(state.configured && state.profiles?.[state.activeProvider]?.vision === true);
      $('passage-ai-note').textContent = state.configured ? 'Uses your saved AI provider. Review its suggestions before saving.' : 'Set up AI in Settings to extract images and suggest cards. You can prepare text here first.';
    } catch { if (version !== settingsVersion) return; vision = false; $('passage-ai-note').textContent = 'AI settings could not be loaded. Keep the server running; text preparation still works.'; }
    update();
  }
  document.addEventListener('ai-settings-changed', () => { stop('AI settings changed. Submit again when ready.'); void refreshSettings(); });
  window.addEventListener('beforeunload', event => { if (dirty || active || preparing || saving) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { active?.controller.abort(); Object.values(sections).forEach(section => { section.prepareVersion++; }); });
  void refreshSettings(); update();
  return { refresh: update };
}
