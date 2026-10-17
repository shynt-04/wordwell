const $ = id => document.getElementById(id);

export async function telegramRequest(method = 'GET', value, suffix = '') {
  let response;
  try { response = await fetch(`/api/settings/telegram${suffix}`, { method, headers: value ? { 'Content-Type': 'application/json' } : {}, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(35000) }); }
  catch { throw new Error('Cannot reach Telegram settings. Keep Wordwell running and try again.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Restart Wordwell and refresh to enable Telegram settings.'); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'The Telegram action failed.');
  return data;
}

export function initTelegramSettings() {
  let state = null, busy = false, dirty = false, pollPending = false, pairingExpiry = 0;
  const status = (text, error = false) => { $('telegram-status').textContent = text; $('telegram-status').classList.toggle('error', error); $('telegram-status').hidden = !text; };
  function controls() {
    $('telegram-fields').disabled = busy || !state;
    $('telegram-save').disabled = busy || !state;
    $('telegram-reload').disabled = busy;
    $('telegram-pair').disabled = busy || dirty || !state?.enabled || state.linked;
    $('telegram-test').disabled = busy || dirty || !state?.enabled || !state.linked;
    $('telegram-disconnect').disabled = busy || !state?.hasToken;
  }
  function clearPairing() { pairingExpiry = 0; $('telegram-pairing').hidden = true; $('telegram-pair-code').textContent = ''; }
  function render(fill = false) {
    $('telegram-current').textContent = state.enabled ? state.running ? `@${state.username} · ${state.linked ? 'Account linked' : 'Waiting for account link'}` : `@${state.username} · Not connected` : 'Telegram is off';
    $('telegram-runtime-status').textContent = state.error || (state.linked ? state.paused ? 'Daily reminders are paused. /resume turns them back on.' : 'Your private account can use /help, /review, /review use, /add, /suggest, and /stats.' : 'Save and enable your bot, then generate a private account-linking code.');
    $('telegram-runtime-status').classList.toggle('error', Boolean(state.error));
    $('telegram-token').placeholder = state.hasToken ? 'A token is saved. Leave blank to keep it.' : 'Paste the token from BotFather';
    $('telegram-background-row').hidden = !state.desktop;
    if (state.linked || !state.enabled || !state.pairingExpiresAt || pairingExpiry && Date.now() >= pairingExpiry) clearPairing();
    if (fill) {
      $('telegram-token').value = '';
      for (const [id, field] of [['telegram-enabled', 'enabled'], ['telegram-reminders', 'reminders'], ['telegram-ai', 'allowAI'], ['telegram-background', 'keepRunningTray']]) $(id).checked = state[field];
      $('telegram-time').value = state.reminderTime; $('telegram-zone').value = state.timeZone;
    }
    controls();
  }
  async function perform(action) {
    if (busy) return;
    busy = true; controls(); status('Working…');
    try { await action(); } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
  }
  async function load() { await perform(async () => { state = await telegramRequest(); dirty = false; clearPairing(); render(true); status(''); }); }
  $('telegram-form').addEventListener('input', () => { dirty = true; status('Changes are not saved yet.'); controls(); });
  $('telegram-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!state || busy || !$('telegram-time').reportValidity() || !$('telegram-zone').reportValidity()) return;
    void perform(async () => {
      state = await telegramRequest('PUT', { revision: state.revision, token: $('telegram-token').value.trim(), enabled: $('telegram-enabled').checked, reminders: $('telegram-reminders').checked, reminderTime: $('telegram-time').value, timeZone: $('telegram-zone').value.trim(), allowAI: $('telegram-ai').checked, keepRunningTray: state.desktop && $('telegram-background').checked });
      dirty = false; render(true); status('Telegram settings saved.');
    });
  });
  $('telegram-reload').addEventListener('click', () => { if (!dirty || confirm('Discard unsaved Telegram settings and reload?')) void load(); });
  $('telegram-pair').addEventListener('click', () => {
    if (!state || busy || dirty) return;
    void perform(async () => {
      const result = await telegramRequest('POST', { revision: state.revision }, '/pair');
      state = result; pairingExpiry = result.pairing.expiresAt; render(false);
      $('telegram-pair-code').textContent = `/start ${result.pairing.code}`; $('telegram-pairing').hidden = false;
      status('Open your bot in Telegram and send this command. Keep this code private.');
    });
  });
  $('telegram-test').addEventListener('click', () => {
    if (!state || busy || dirty) return;
    void perform(async () => { state = await telegramRequest('POST', { revision: state.revision }, '/test'); render(false); status('Test message sent to your linked account.'); });
  });
  $('telegram-disconnect').addEventListener('click', () => {
    if (!state || busy || !confirm('Disconnect Telegram and remove its saved token and account link? Your notebook will be kept.')) return;
    void perform(async () => { state = await telegramRequest('POST', { revision: state.revision }, '/disconnect'); dirty = false; clearPairing(); render(true); status('Telegram disconnected. Your notebook is unchanged.'); });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
  async function poll() {
    if (document.hidden || busy || pollPending || !state) return;
    pollPending = true;
    try { const next = await telegramRequest(); if (busy) return; if (dirty) { if (next.revision !== state.revision) status('Telegram settings changed elsewhere. Reload before saving your changes.', true); return; } state = next; render(true); }
    catch { /* Preserve the user's form during transient connection failures. */ }
    finally { pollPending = false; }
  }
  setInterval(() => { void poll(); }, 10000);
  void load();
}
