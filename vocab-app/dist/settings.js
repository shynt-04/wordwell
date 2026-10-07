const $ = id => document.getElementById(id);
const SAVED_KEY_MASK = '••••••••••••••••';

async function settingsRequest(method = 'GET', value, suffix = '', signal) {
  let response;
  try { response = await fetch(`/api/settings/ai${suffix}`, { method, signal, headers: value ? { 'Content-Type': 'application/json' } : {}, body: value ? JSON.stringify(value) : undefined }); }
  catch { if (signal?.aborted) throw new Error('Connection check stopped.'); throw new Error('Cannot reach Wordwell. Keep the local server running and try again.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Restart Wordwell with npm run dev and refresh to enable AI Settings.'); }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'The AI settings request failed.');
  return data;
}

export async function initSettings(setView) {
  let state = null;
  let loading = false;
  let saving = false;
  let firstSetup = false;
  let formDirty = false;
  let checking = null;
  let discovered = null;
  let expiryTimer;
  let editingKey = true;
  let keyReveal = null;
  const definition = () => state?.providers.find(provider => provider.id === $('settings-provider').value);
  const profile = () => state?.profiles[$('settings-provider').value];
  const enteredKey = () => editingKey && !$('settings-key').disabled ? $('settings-key').value.trim() : '';
  function sameEndpoint() {
    try { return profile()?.baseUrl === new URL($('settings-base-url').value.trim()).href.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, ''); }
    catch { return false; }
  }
  function hideKey() {
    keyReveal?.abort();
    keyReveal = null;
    $('settings-key').type = 'password';
    if (!editingKey) $('settings-key').value = profile()?.hasKey && !$('settings-key').disabled ? SAVED_KEY_MASK : '';
    $('settings-key-toggle').textContent = 'Show';
    $('settings-key-toggle').setAttribute('aria-pressed', 'false');
  }
  const message = (id, text, error = false) => {
    $(id).textContent = text;
    $(id).hidden = !text;
    $(id).classList.toggle('error', error);
  };
  const status = (text, error = false) => message('settings-status', text, error);
  const connectionStatus = (text, error = false) => message('settings-connection-status', text, error);
  function controls() {
    const clear = $('settings-clear-key').checked;
    const usable = discovered && discovered.expiresAt > Date.now();
    $('settings-save').disabled = loading || saving || Boolean(checking) || !definition() || !(clear && profile()?.hasKey || usable && $('settings-model').value);
    $('settings-connect').disabled = loading || saving || !definition() || clear;
    $('settings-connect').textContent = checking ? 'Stop checking' : discovered ? 'Reconnect & refresh models' : 'Connect & load models';
    $('settings-model').disabled = !usable || clear;
    $('settings-skip').disabled = saving || loading;
    $('settings-reload').disabled = saving || loading;
  }
  function invalidateConnection() {
    checking?.abort();
    checking = null;
    discovered = null;
    clearTimeout(expiryTimer);
    $('settings-model').replaceChildren();
    $('settings-model-section').hidden = true;
    $('settings-model').disabled = true;
    connectionStatus('');
    controls();
  }
  function keyState() {
    const provider = definition();
    const saved = profile();
    const clear = $('settings-clear-key').checked;
    if (clear) $('settings-no-key').checked = false;
    const noKey = Boolean(provider?.optionalKey && $('settings-no-key').checked);
    $('settings-no-key').disabled = clear;
    $('settings-key').disabled = noKey || clear;
    $('settings-key').readOnly = Boolean(saved?.hasKey && !editingKey);
    if (noKey || clear) { hideKey(); $('settings-key').value = ''; }
    else if (!editingKey && $('settings-key').type === 'password') $('settings-key').value = SAVED_KEY_MASK;
    const reuse = saved?.hasKey && sameEndpoint() && !editingKey;
    $('settings-key').required = Boolean(provider && !noKey && !clear && !reuse);
    $('settings-key-toggle').disabled = noKey || clear || editingKey && !$('settings-key').value;
    $('settings-key-change').hidden = !saved?.hasKey || editingKey || noKey || clear;
    $('settings-key-cancel').hidden = !saved?.hasKey || !editingKey || noKey || clear;
    $('settings-key').placeholder = editingKey && saved?.hasKey ? 'Paste your replacement API key' : 'Paste your API key';
    $('settings-key-note').textContent = noKey ? 'No key will be sent to this endpoint.' : clear ? 'Saving removes this key and disables AI for this profile. Its saved model and endpoint are kept.' : editingKey && saved?.hasKey ? 'Enter a new key, then connect and save. Your saved key stays active until you save the replacement.' : reuse ? 'A key is saved. Show / Hide lets you view it; Change key lets you replace it. Connect uses this saved key.' : saved?.hasKey ? 'The endpoint changed. Choose Change key and re-enter a key before connecting.' : 'Paste your API key, then connect to see its models.';
    controls();
  }
  function changeKey() {
    if (!state || saving || loading || $('settings-key').disabled) return;
    hideKey();
    editingKey = true;
    $('settings-key').value = '';
    invalidateConnection();
    keyState();
    formDirty = true;
    status('Enter a new key, connect to load its models, then save.');
    $('settings-key').focus();
  }
  function providerState() {
    invalidateConnection();
    const provider = definition();
    const saved = profile();
    hideKey();
    editingKey = !saved?.hasKey;
    $('settings-provider-fields').hidden = !provider;
    $('settings-key').value = '';
    $('settings-key').type = 'password';
    $('settings-key-toggle').textContent = 'Show';
    $('settings-clear-key').checked = false;
    $('settings-clear-key-row').hidden = !saved?.hasKey;
    if (!provider) { controls(); return; }
    $('settings-help').textContent = provider.help;
    $('settings-base-url').value = saved?.baseUrl ?? provider.baseUrl;
    $('settings-base-url').readOnly = !provider.customEndpoint;
    $('settings-endpoint-help').textContent = provider.customEndpoint ? 'Use the API base URL, not a full chat/completions URL. This endpoint must support /models. Remote endpoints require HTTPS; HTTP is allowed on localhost.' : 'Official provider endpoint. Select CLIProxyAPI or Other for a custom endpoint.';
    $('settings-json-row').hidden = provider.protocol !== 'compatible';
    $('settings-json-help').hidden = provider.protocol !== 'compatible';
    $('settings-json-mode').checked = saved?.jsonMode ?? provider.jsonMode;
    $('settings-vision').checked = saved?.vision ?? provider.vision;
    $('settings-vision').disabled = false;
    $('settings-no-key-row').hidden = !provider.optionalKey;
    $('settings-no-key').checked = saved?.allowNoKey ?? provider.id === 'ollama';
    keyState();
  }
  function renderState() {
    const active = state.providers.find(provider => provider.id === state.activeProvider);
    $('ai-settings-shortcut').textContent = state.configured ? `AI: ${active.name}` : 'Set up AI';
    $('settings-current').textContent = state.configured ? `${active.name} · ${state.profiles[state.activeProvider].model}` : 'AI is not configured yet';
    $('settings-setup-notice').hidden = state.configured;
    $('settings-skip').hidden = state.configured || state.setupDismissed;
  }
  function modelState() {
    const model = discovered?.models.find(item => item.id === $('settings-model').value);
    $('settings-vision').disabled = model?.vision === false;
    $('settings-vision').checked = model?.vision === false ? false : model && profile()?.model === model.id ? profile().vision : definition()?.vision ?? false;
    $('settings-model-help').textContent = model ? `Model ID: ${model.id}` : 'Choose a model to use for vocabulary and Writing.';
    $('settings-vision-help').textContent = model?.vision === true ? 'The provider lists image input support for this model.' : model?.vision === false ? 'This model accepts text only. Choose another model for image questions.' : 'Image support was not reported. Enable image questions only if this model supports them.';
    controls();
  }
  function credentialsValid() {
    if (profile()?.hasKey && !editingKey && !sameEndpoint() && !$('settings-no-key').checked) changeKey();
    keyState();
    return ['settings-provider', 'settings-base-url', 'settings-key'].every(id => $(id).disabled || $(id).reportValidity());
  }
  async function connect() {
    if (checking) { invalidateConnection(); connectionStatus('Connection check stopped.'); return; }
    if (!state || loading || saving || !definition() || $('settings-clear-key').checked || !credentialsValid()) return;
    invalidateConnection();
    const controller = new AbortController();
    checking = controller;
    controls();
    connectionStatus('Connecting and loading models…');
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const result = await settingsRequest('POST', {
        revision: state.revision, provider: $('settings-provider').value, baseUrl: $('settings-base-url').value.trim(), apiKey: enteredKey(), allowNoKey: $('settings-no-key').checked,
      }, '/models', controller.signal);
      if (checking !== controller || controller.signal.aborted) return;
      if (!Array.isArray(result.models) || !result.models.length || typeof result.connectionToken !== 'string' || !Number.isFinite(result.expiresAt)) throw new Error('No usable model list was returned. Restart Wordwell and connect again.');
      discovered = result;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an available model';
      $('settings-model').replaceChildren(placeholder, ...result.models.map(model => {
        const option = document.createElement('option'); option.value = model.id; option.textContent = model.name === model.id ? model.id : `${model.name} (${model.id})`; return option;
      }));
      const preferred = profile()?.model || definition().model;
      if (result.models.some(model => model.id === preferred)) $('settings-model').value = preferred;
      else if (result.models.length === 1) $('settings-model').value = result.models[0].id;
      $('settings-model-section').hidden = false;
      modelState();
      connectionStatus(`Connected. ${result.models.length} model${result.models.length === 1 ? '' : 's'} listed. Choose a model and save. Generation still depends on the provider’s permissions, credit, and quota.`);
      expiryTimer = setTimeout(() => { invalidateConnection(); connectionStatus('The connection check expired. Reconnect before saving.'); }, Math.max(0, result.expiresAt - Date.now()));
      $('settings-model').focus();
    } catch (error) { if (checking === controller) connectionStatus(controller.signal.aborted ? 'Connection check timed out. Try connecting again.' : error.message, true); }
    finally { clearTimeout(timer); if (checking === controller) { checking = null; controls(); } }
  }
  async function load({ initial = false } = {}) {
    if (loading || saving) return;
    hideKey();
    invalidateConnection();
    loading = true;
    $('settings-fields').disabled = true;
    controls();
    status('Loading AI settings…');
    try {
      state = await settingsRequest();
      const select = $('settings-provider');
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an AI provider';
      select.replaceChildren(placeholder, ...state.providers.map(provider => { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name; return option; }));
      select.value = state.activeProvider || '';
      providerState();
      renderState();
      formDirty = false;
      firstSetup = initial && !state.configured && !state.setupDismissed;
      if (firstSetup) { setView('settings'); select.focus(); }
      status('');
      $('settings-fields').disabled = false;
    } catch (error) { status(error.message, true); $('ai-settings-shortcut').textContent = 'AI Settings'; }
    finally { loading = false; controls(); }
  }
  $('ai-settings-shortcut').addEventListener('click', () => setView('settings'));
  $('settings-reload').addEventListener('click', () => { void load(); });
  $('settings-connect').addEventListener('click', () => { void connect(); });
  $('settings-provider').addEventListener('change', () => { providerState(); formDirty = true; status('Connect to load models for this provider.'); });
  for (const id of ['settings-base-url', 'settings-key', 'settings-no-key', 'settings-clear-key']) $(id).addEventListener('input', () => {
    invalidateConnection(); keyState(); formDirty = true; status($('settings-clear-key').checked ? 'Save to remove the key. Other profile changes will be discarded.' : 'Connect to load models for these credentials.');
  });
  $('settings-model').addEventListener('change', () => { modelState(); formDirty = true; status('Changes are not saved yet.'); });
  for (const id of ['settings-json-mode', 'settings-vision']) $(id).addEventListener('input', () => { formDirty = true; status('Changes are not saved yet.'); });
  $('settings-key-change').addEventListener('click', changeKey);
  $('settings-key-cancel').addEventListener('click', () => {
    hideKey();
    editingKey = false;
    invalidateConnection();
    keyState();
    status('Replacement cancelled. Connect will use your saved key.');
  });
  $('settings-key-toggle').addEventListener('click', async () => {
    if (saving || loading || $('settings-key').disabled) return;
    if ($('settings-key').type === 'text' || keyReveal) { hideKey(); return; }
    if (editingKey) {
      $('settings-key').type = 'text';
      $('settings-key-toggle').textContent = 'Hide';
      $('settings-key-toggle').setAttribute('aria-pressed', 'true');
      return;
    }
    const controller = new AbortController();
    keyReveal = controller;
    $('settings-key-toggle').textContent = 'Cancel';
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await settingsRequest('POST', { revision: state.revision, provider: $('settings-provider').value }, '/key', controller.signal);
      if (keyReveal !== controller || controller.signal.aborted || editingKey) return;
      if (typeof result.apiKey !== 'string' || !result.apiKey) throw new Error('No saved key was returned. Reload Settings and try again.');
      $('settings-key').value = result.apiKey;
      $('settings-key').type = 'text';
      $('settings-key-toggle').textContent = 'Hide';
      $('settings-key-toggle').setAttribute('aria-pressed', 'true');
    } catch (error) {
      if (keyReveal === controller) { const timedOut = controller.signal.aborted; hideKey(); status(timedOut ? 'Could not reveal the key in time. Try again.' : error.message, true); }
    } finally {
      clearTimeout(timer);
      if (keyReveal === controller) { keyReveal = null; if ($('settings-key').type === 'password') $('settings-key-toggle').textContent = 'Show'; }
    }
  });
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state || saving || loading || checking || !definition()) return;
    const clearKey = $('settings-clear-key').checked;
    if (!clearKey && (!discovered || discovered.expiresAt <= Date.now())) { await connect(); return; }
    if (!clearKey && (!credentialsValid() || !$('settings-model').reportValidity())) return;
    hideKey();
    saving = true;
    clearTimeout(expiryTimer);
    $('settings-fields').disabled = true;
    controls();
    status('Saving AI settings…');
    try {
      state = await settingsRequest('PUT', {
        revision: state.revision, provider: $('settings-provider').value, model: clearKey ? profile().model : $('settings-model').value, baseUrl: $('settings-base-url').value.trim(), apiKey: enteredKey(),
        clearKey, jsonMode: $('settings-json-mode').checked, vision: $('settings-vision').checked, allowNoKey: $('settings-no-key').checked, connectionToken: discovered?.connectionToken,
      });
      formDirty = false;
      renderState();
      providerState();
      document.dispatchEvent(new CustomEvent('ai-settings-changed', { detail: { configured: state.configured } }));
      status(state.configured ? 'Saved. Vocabulary and Writing now use this model. No restart is needed.' : 'Saved key removed. AI is disabled until you connect and save another configuration.');
      if (firstSetup && state.configured) { firstSetup = false; setView('today'); }
    } catch (error) {
      status(error.message, true);
      if (discovered) expiryTimer = setTimeout(() => { invalidateConnection(); connectionStatus('The connection check expired. Reconnect before saving.'); }, Math.max(0, discovered.expiresAt - Date.now()));
    } finally { saving = false; $('settings-fields').disabled = false; controls(); }
  });
  $('settings-skip').addEventListener('click', async () => {
    if (!state || saving || loading) return;
    invalidateConnection();
    saving = true;
    $('settings-fields').disabled = true;
    controls();
    try {
      state = await settingsRequest('POST', { revision: state.revision }, '/dismiss');
      renderState(); providerState();
      firstSetup = false;
      formDirty = false;
      setView('today');
    } catch (error) { status(error.message, true); }
    finally { saving = false; $('settings-fields').disabled = false; controls(); }
  });
  window.addEventListener('beforeunload', event => { if (saving || formDirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { checking?.abort(); hideKey(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideKey(); });
  const viewObserver = new MutationObserver(() => { if ($('settings-view').hidden) hideKey(); });
  viewObserver.observe($('settings-view'), { attributes: true, attributeFilter: ['hidden'] });
  await load({ initial: true });
}
