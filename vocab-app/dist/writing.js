import { WRITING_FIELDS, blankWritingDraft, countWords, isWritingAssessment, sameWritingInput, validateWritingInput } from './writing-data.js';
import { createServerWritingStore } from './persistence.js';
import { prepareImage } from './image-input.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export async function readWritingResponse(response) {
  let data;
  try { data = JSON.parse(await response.text()); }
  catch {
    throw new Error([404, 405].includes(response.status) ? 'Restart Wordwell with npm run dev and refresh this page to enable Writing feedback.' : 'The server returned unreadable feedback. Your draft is kept; please try again.');
  }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Writing feedback is unavailable. Please try again.');
  if (!isWritingAssessment(data)) throw new Error('The feedback is incomplete. Your draft is kept; please try again.');
  return data;
}

export async function initWriting() {
  let draft = blankWritingDraft();
  let store = null;
  let ready = false;
  let saveTimer;
  let saveQueue = Promise.resolve();
  let saveVersion = 0;
  let dirty = false;
  let active = null;
  let imageVersion = 0;
  let imagePending = false;
  let selectedTab = 'assessment';
  const form = $('writing-form');
  const controls = { task: $('writing-task'), question: $('writing-question'), essay: $('writing-essay'), feedbackLanguage: $('writing-language') };
  const input = () => Object.fromEntries(WRITING_FIELDS.map(name => [name, name === 'image' ? draft.image : controls[name].value]));
  const status = (id, message, error = false) => {
    const node = $(id);
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle('error', error);
  };
  const updateButton = () => { $('writing-assess').disabled = !ready || imagePending || Boolean(active); };
  const updateCounts = () => {
    const words = countWords(controls.essay.value);
    const minimum = controls.task.value === 'task1' ? 150 : 250;
    $('writing-word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'} · aim for at least ${minimum}`;
    $('writing-short-note').hidden = !words || words >= minimum;
    $('writing-stale-note').hidden = !draft.assessment || sameWritingInput(input(), draft.assessedInput);
  };
  const updateImage = () => {
    $('writing-image-empty').hidden = Boolean(draft.image);
    $('writing-image-preview').hidden = !draft.image;
    if (draft.image) $('writing-image-preview').src = draft.image;
    else $('writing-image-preview').removeAttribute('src');
    $('writing-remove-image').hidden = !draft.image;
    $('writing-image-help').textContent = draft.image ? `${draft.imageName || 'Pasted image'} · click the image to replace it` : 'PNG, JPEG, or WebP. Images are resized locally to fit within 2 MB.';
  };
  function saveNow() {
    clearTimeout(saveTimer);
    if (!ready || !store || !dirty) return;
    Object.assign(draft, input(), { updatedAt: Date.now() });
    const snapshot = structuredClone(draft);
    const version = ++saveVersion;
    status('writing-save-status', 'Saving draft…');
    saveQueue = saveQueue.then(() => store.save(snapshot)).then(() => {
      if (version === saveVersion) { dirty = false; status('writing-save-status', store.migrationWarning || 'Saved to data/wordwell.sqlite.', Boolean(store.migrationWarning)); }
    }).catch(error => {
      if (version === saveVersion) status('writing-save-status', error.message, true);
    });
  }
  function scheduleSave() {
    dirty = true;
    if (!ready || !store) return;
    clearTimeout(saveTimer);
    // Invalidate an earlier save's status while the next edit is pending.
    saveVersion++;
    status('writing-save-status', 'Saving draft…');
    saveTimer = setTimeout(saveNow, 350);
  }
  function stop(message = 'Review stopped. Your draft is kept.') {
    if (!active) return;
    const request = active;
    active = null;
    clearTimeout(request.timer);
    request.controller.abort();
    $('writing-cancel').hidden = true;
    updateButton();
    status('writing-request-status', message);
  }
  function edited() {
    if (!ready) return;
    stop('Draft changed. Submit again when you are ready.');
    Object.assign(draft, input());
    updateCounts();
    scheduleSave();
  }
  function selectTab(name, focus = false) {
    selectedTab = name;
    for (const button of document.querySelectorAll('[data-writing-tab]')) {
      const selected = button.dataset.writingTab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`writing-panel-${button.dataset.writingTab}`).hidden = !selected;
      if (selected && focus) button.focus();
    }
  }
  const items = (title, values, ordered = false, className = '') => values.length ? `<section class="feedback-block ${className}"><h3>${escape(title)}</h3><${ordered ? 'ol' : 'ul'}>${values.map(value => `<li>${escape(value)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}></section>` : '';
  function renderFeedback() {
    const report = draft.assessment;
    $('writing-feedback-empty').hidden = Boolean(report);
    $('writing-feedback-results').hidden = !report;
    if (!report) return;
    const task1 = draft.assessedInput.task === 'task1';
    const names = { task: task1 ? 'Task Achievement' : 'Task Response', coherence: 'Coherence & Cohesion', vocabulary: 'Lexical Resource', grammar: 'Grammatical Range & Accuracy' };
    $('writing-panel-assessment').innerHTML = `<div class="writing-band"><div><p>Estimated task band</p><strong>${report.overallBand.toFixed(1)}</strong></div><div class="band-meta"><p>${task1 ? 'Academic Task 1' : 'Task 2'}</p><small>${report.wordCount} words<br>${escape(report.confidence)} confidence</small></div></div>
      <p class="writing-summary">${escape(report.summary)}</p>
      <div class="writing-criteria">${Object.entries(names).map(([key, label]) => `<div class="criterion"><div class="criterion-title"><span>${label}</span><strong>${report.criteria[key].band.toFixed(1)}</strong></div><p>${escape(report.criteria[key].reason)}</p></div>`).join('')}</div>
      ${items('What you did well', report.strengths)}${items('Focus on these next', report.priorities, true)}
      ${report.imageSummary ? `<details class="writing-image-reading"><summary>How AI read your image</summary><p>${escape(report.imageSummary)}</p></details>` : ''}
      ${items('Assessment limitations', report.limitations, false, 'writing-limitations')}`;
    $('writing-panel-corrections').innerHTML = `<p class="writing-section-intro">Specific phrases from your essay, with suggested changes. Style suggestions are optional.</p>${report.corrections.length ? report.corrections.map(item => `<article class="correction-card"><span class="badge">${escape(item.category)}</span><p class="correction-original">${escape(item.original)}</p><p class="correction-replacement">${escape(item.replacement)}</p><p class="correction-reason">${escape(item.reason)}</p></article>`).join('') : '<p class="writing-no-corrections">No specific corrections were returned. Check the assessment for broader improvements.</p>'}`;
    $('writing-panel-revision').innerHTML = `<div class="revision-heading"><h3>Suggested improved version</h3><button type="button" id="writing-copy-revision" class="button secondary">Copy</button></div><p class="writing-section-intro">Compare the changes with your draft. This is a learning example, not a guaranteed band score.</p><div class="writing-revision">${escape(report.revisedEssay)}</div><p id="writing-copy-status" class="revision-note" role="status"></p>`;
    $('writing-copy-revision').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(report.revisedEssay); $('writing-copy-status').textContent = 'Copied.'; }
      catch { $('writing-copy-status').textContent = 'Select the suggested essay and copy it manually.'; }
    });
    selectTab(selectedTab);
    updateCounts();
  }
  for (const control of Object.values(controls)) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', edited);
  for (const button of document.querySelectorAll('[data-writing-tab]')) {
    button.addEventListener('click', () => selectTab(button.dataset.writingTab));
    button.addEventListener('keydown', event => {
      const names = ['assessment', 'corrections', 'revision'];
      let index = names.indexOf(selectedTab);
      if (event.key === 'ArrowRight') index = (index + 1) % names.length;
      else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = names.length - 1;
      else return;
      event.preventDefault();
      selectTab(names[index], true);
    });
  }
  async function attachImage(file) {
    if (!file || !ready) return;
    const version = ++imageVersion;
    imagePending = true;
    stop('Question image changed. Submit again when you are ready.');
    updateButton();
    status('writing-image-status', 'Preparing image…');
    try {
      const image = await prepareImage(file);
      if (version !== imageVersion) return;
      draft.image = image;
      draft.imageName = (file.name || 'Pasted image').slice(0, 200);
      updateImage();
      edited();
      status('writing-image-status', 'Image ready. Check that the labels and figures are readable.');
    } catch (error) {
      if (version === imageVersion) status('writing-image-status', error.message, true);
    } finally {
      if (version === imageVersion) { imagePending = false; updateButton(); }
      $('writing-image-file').value = '';
    }
  }
  const imageZone = $('writing-image-zone');
  imageZone.addEventListener('click', () => { if (ready) $('writing-image-file').click(); });
  imageZone.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (ready) $('writing-image-file').click(); }
  });
  $('writing-image-file').addEventListener('change', event => { void attachImage(event.target.files[0]); });
  document.addEventListener('paste', event => {
    if (!ready || $('writing-view').hidden || document.querySelector('dialog[open]')) return;
    const item = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    void attachImage(item.getAsFile());
  });
  $('writing-remove-image').addEventListener('click', () => {
    imageVersion++;
    imagePending = false;
    draft.image = '';
    draft.imageName = '';
    updateImage();
    edited();
    updateButton();
    status('writing-image-status', '');
  });
  $('writing-cancel').addEventListener('click', () => stop());
  document.addEventListener('ai-settings-changed', () => stop('AI provider settings changed. Submit again when you are ready.'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready || active || imagePending) return;
    const snapshot = input();
    let payload;
    try { payload = validateWritingInput(snapshot); }
    catch (error) { status('writing-request-status', error.message, true); return; }
    saveNow();
    const request = { controller: new AbortController(), timer: null };
    active = request;
    request.timer = setTimeout(() => {
      if (active === request) stop('The review took too long. Your draft is kept; please try again.');
    }, 100_000);
    updateButton();
    $('writing-cancel').hidden = false;
    status('writing-request-status', 'Reading your essay and preparing feedback… This can take about a minute.');
    try {
      const response = await fetch('/api/writing/assess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: request.controller.signal });
      const report = await readWritingResponse(response);
      if (active !== request || !sameWritingInput(snapshot, input())) return;
      draft.assessment = report;
      draft.assessedInput = snapshot;
      dirty = true;
      selectedTab = 'assessment';
      renderFeedback();
      saveNow();
      status('writing-request-status', 'Feedback ready. Review the assessment, corrections, and improved version.');
    } catch (error) {
      if (active === request) status('writing-request-status', error.name === 'AbortError' ? 'Review stopped. Your draft is kept.' : error instanceof TypeError ? 'Could not reach Wordwell. Keep the local server running and try again.' : error.message, true);
    } finally {
      clearTimeout(request.timer);
      if (active === request) { active = null; $('writing-cancel').hidden = true; updateButton(); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', () => { saveNow(); stop(''); });
  window.addEventListener('beforeunload', event => { if (dirty) { saveNow(); event.preventDefault(); event.returnValue = ''; } });
  updateButton();
  try {
    store = createServerWritingStore();
    draft = await store.read();
    status('writing-save-status', store.migrationWarning || 'Saved to data/wordwell.sqlite.', Boolean(store.migrationWarning));
  } catch (error) {
    store?.close();
    store = null;
    status('writing-save-status', `${error.message} Automatic saving is unavailable; copy your essay before leaving.`, true);
  }
  for (const [name, control] of Object.entries(controls)) control.value = draft[name];
  updateImage();
  updateCounts();
  renderFeedback();
  ready = true;
  $('writing-fields').disabled = false;
  updateButton();
  return {
    async flush() {
      saveNow();
      await saveQueue;
      if (dirty) throw new Error('Your latest Writing changes have not been saved. Check the Writing save message before downloading the database.');
    },
  };
}
