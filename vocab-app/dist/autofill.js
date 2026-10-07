const FIELD_NAMES = ['meaning', 'pronunciation', 'synonyms', 'example'];

export async function readAutofillResponse(response) {
  const restartMessage = 'This server does not support autofill. Restart Wordwell using start-wordwell.cmd or npm run dev, then refresh this page.';
  if (response.status === 404 || response.status === 405) throw new Error(restartMessage);
  let data;
  try { data = JSON.parse(await response.text()); }
  catch {
    throw new Error(response.ok ? 'Wordwell returned an unexpected response. Restart the app and refresh this page, then try again.' : `Autofill could not complete the request (HTTP ${response.status}). Try again, or restart Wordwell and refresh this page.`);
  }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Autofill is unavailable. Try again or enter the details yourself.');
  return data;
}

export function fillEmptyFields(fields, snapshots, suggestions) {
  // Validate the entire response before touching any field.
  for (const name of FIELD_NAMES) {
    if (typeof suggestions?.[name] !== 'string' || !suggestions[name].trim() || suggestions[name].length > fields[name].maxLength) throw new Error('The suggested entry is incomplete. Please try again.');
  }
  let filled = 0;
  for (const name of FIELD_NAMES) {
    if (!snapshots[name].trim() && fields[name].value === snapshots[name]) {
      fields[name].value = suggestions[name].trim();
      fields[name].dispatchEvent(new Event('input', { bubbles: true }));
      filled++;
    }
  }
  return filled;
}

export function wireAutofill({ form, wordInput, fields, button, status, autoToggle, fetchImpl = fetch }) {
  let active = null;
  const generated = new Map();
  const saveButton = form.querySelector('button[type="submit"]');
  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
    status.hidden = !message;
  }
  function busy(value) {
    form.setAttribute('aria-busy', String(value));
    saveButton.disabled = value;
    button.textContent = value ? 'Stop autofill' : 'Fill with AI';
    button.classList.toggle('loading', value);
  }
  function cancel(message = '') {
    if (!active) return;
    active.abort(); active = null; busy(false); showStatus(message);
  }
  async function complete() {
    if (active) return;
    const word = wordInput.value.trim();
    if (!word) { showStatus('Enter a word first.', true); wordInput.focus(); return; }
    const snapshots = Object.fromEntries(FIELD_NAMES.map(name => [name, fields[name].value]));
    if (FIELD_NAMES.every(name => snapshots[name].trim())) { showStatus('These fields are already filled. Clear one to get a new suggestion.'); return; }
    const controller = new AbortController();
    active = controller; busy(true); showStatus('Finding meanings, pronunciation, synonyms, and an example…');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 50_000);
    try {
      const response = await fetchImpl('/api/vocabulary/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word }), signal: controller.signal });
      const data = await readAutofillResponse(response);
      if (active !== controller || wordInput.value.trim() !== word || controller.signal.aborted) return;
      const toFill = FIELD_NAMES.filter(name => !snapshots[name].trim() && fields[name].value === snapshots[name]);
      const filled = fillEmptyFields(fields, snapshots, data);
      for (const name of toFill) generated.set(name, fields[name].value);
      showStatus(filled ? 'Suggestions ready. Check them, make them yours, then save.' : 'Your edits were kept. Clear a field to request a suggestion.');
    } catch (error) {
      if (active !== controller) return;
      showStatus(timedOut ? 'Autofill took too long. Please try again.' : error.name === 'AbortError' ? 'Autofill stopped.' : error.message || 'Could not connect. Check your internet connection.', true);
    } finally {
      clearTimeout(timer);
      if (active === controller) { active = null; busy(false); }
    }
  }
  button.addEventListener('click', () => active ? cancel('Autofill stopped. You can enter the details yourself.') : complete());
  wordInput.addEventListener('input', () => {
    cancel(); showStatus('');
    for (const [name, value] of generated) if (fields[name].value === value) fields[name].value = '';
    generated.clear();
  });
  wordInput.addEventListener('blur', event => {
    if (autoToggle?.checked && event.relatedTarget !== button && event.relatedTarget !== autoToggle && wordInput.value.trim() && FIELD_NAMES.some(name => !fields[name].value.trim())) complete();
  });
  wordInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); complete(); }
    else if (event.key === 'Tab' && autoToggle?.checked && wordInput.value.trim() && FIELD_NAMES.some(name => !fields[name].value.trim())) complete();
  });
  autoToggle?.addEventListener('change', () => { if (!autoToggle.checked) cancel('Automatic filling is off. You can still use Fill with AI.'); });
  if (typeof document !== 'undefined') document.addEventListener('ai-settings-changed', () => cancel('AI provider settings changed. Request suggestions again.'));
  form.addEventListener('submit', event => {
    if (active) { event.preventDefault(); event.stopImmediatePropagation(); showStatus('Wait for autofill, or stop it to enter details yourself.'); }
  }, { capture: true });
  function reset() { cancel(); generated.clear(); showStatus(''); }
  form.addEventListener('reset', () => {
    const autoEnabled = autoToggle?.checked;
    reset();
    if (autoToggle) queueMicrotask(() => { autoToggle.checked = autoEnabled; });
  });
  return { cancel, complete, reset };
}
