import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { LookupError } from './ai-errors.mjs';
import { listAvailableModels } from './ai-models.mjs';

export const SETTINGS_PATH = fileURLToPath(new URL('../data/ai-settings.json', import.meta.url));
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'compatible', customEndpoint: false, optionalKey: false, jsonMode: true, vision: true, help: 'Enter your DeepSeek API key, then connect to choose a model available through the API.' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', protocol: 'gemini', customEndpoint: false, optionalKey: false, jsonMode: true, vision: true, help: 'Use a Google AI Studio API key and a model available to your account.' },
  { id: 'claude', name: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', protocol: 'claude', customEndpoint: false, optionalKey: false, jsonMode: false, vision: true, help: 'Use an Anthropic API key. A Claude app subscription is separate from API access.' },
  { id: 'cliproxy', name: 'CLIProxyAPI', baseUrl: 'http://127.0.0.1:8317/v1', model: '', protocol: 'compatible', customEndpoint: true, optionalKey: true, jsonMode: true, vision: true, help: 'Start your CLIProxy server and enter its client API key. Connect to list the models and aliases exposed by that server.' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:4b', protocol: 'compatible', customEndpoint: true, optionalKey: true, jsonMode: true, vision: true, help: 'Install Ollama and download the selected model first. Local Ollama normally does not require a key.' },
  { id: 'compatible', name: 'Other OpenAI-compatible API', baseUrl: '', model: '', protocol: 'compatible', customEndpoint: true, optionalKey: true, jsonMode: true, vision: false, help: 'Enter the API base URL (usually ending in /v1) and your API key. The service must support listing models.' },
];

const definition = id => PROVIDERS.find(provider => provider.id === id);
const defaults = provider => ({ baseUrl: provider.baseUrl, model: provider.model, apiKey: '', jsonMode: provider.jsonMode, vision: provider.vision, allowNoKey: provider.id === 'ollama' });
const blank = () => ({ version: 1, revision: 0, activeProvider: null, setupDismissed: false, profiles: {} });

export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new LookupError('Enter a complete API base URL, including http:// or https://.', 400); }
  if (url.username || url.password || url.search || url.hash) throw new LookupError('The API base URL cannot contain credentials, query parameters, or a fragment.', 400);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new LookupError('Use HTTPS for a remote API, or HTTP for localhost / 127.0.0.1.', 400);
  return url.href.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '');
}

function validateProfile(id, input) {
  const provider = definition(id);
  if (!provider || !input || typeof input !== 'object' || Array.isArray(input)) throw new LookupError('Choose a supported AI provider.', 400);
  const model = typeof input.model === 'string' ? (provider.protocol === 'gemini' ? input.model.trim().replace(/^models\//u, '') : input.model.trim()) : '';
  if (!model || model.length > 180 || /\s|[\u0000-\u001f\u007f]/u.test(model)) throw new LookupError('Enter a model ID of up to 180 characters without spaces.', 400);
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 500) throw new LookupError('Enter an API base URL of up to 500 characters.', 400);
  const baseUrl = normalizeEndpoint(input.baseUrl);
  if (!provider.customEndpoint && baseUrl !== provider.baseUrl) throw new LookupError('Use the official endpoint for this provider. For a proxy, select CLIProxyAPI or Other OpenAI-compatible API.', 400);
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input.apiKey)) throw new LookupError('Enter a valid API key on one line.', 400);
  for (const key of ['jsonMode', 'vision', 'allowNoKey']) if (typeof input[key] !== 'boolean') throw new LookupError('Choose the AI request options.', 400);
  if (input.allowNoKey && !provider.optionalKey) throw new LookupError('This provider requires an API key.', 400);
  return { baseUrl, model, apiKey: input.apiKey.trim(), jsonMode: provider.protocol === 'gemini' ? true : provider.protocol === 'claude' ? false : input.jsonMode, vision: input.vision, allowNoKey: input.allowNoKey };
}

function configured(state) {
  const profile = state.profiles[state.activeProvider];
  return Boolean(profile?.model && profile.baseUrl && (profile.apiKey || profile.allowNoKey));
}

export async function createSettingsStore({ path = SETTINGS_PATH, legacyKey, legacyModel = 'deepseek-flash', allowKeyReveal = false } = {}) {
  let state;
  let failure = null;
  let queue = Promise.resolve();
  let connections = 0;
  const verified = new Map();
  async function persist(next) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    state = next;
  }
  try {
    const input = JSON.parse(await readFile(path, 'utf8'));
    if (!input || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.setupDismissed !== 'boolean' || !input.profiles || typeof input.profiles !== 'object' || Array.isArray(input.profiles) || input.activeProvider !== null && !definition(input.activeProvider)) throw new Error('Invalid settings');
    state = { ...blank(), revision: input.revision, activeProvider: input.activeProvider, setupDismissed: input.setupDismissed };
    for (const [id, profile] of Object.entries(input.profiles)) state.profiles[id] = validateProfile(id, profile);
    if (state.activeProvider && !state.profiles[state.activeProvider]) throw new Error('Missing profile');
  } catch (error) {
    if (error.code === 'ENOENT') {
      state = blank();
      if (legacyKey?.trim()) {
        try {
          const profile = validateProfile('deepseek', { ...defaults(definition('deepseek')), apiKey: legacyKey.trim(), model: legacyModel });
          state.activeProvider = 'deepseek';
          state.profiles.deepseek = profile;
        } catch { state = blank(); }
      }
      try { await persist(state); } catch { failure = 'AI settings could not be saved. Check write access to the data folder.'; }
    } else failure = 'Your saved AI settings could not be read. They have not been overwritten. Recover data/ai-settings.json and restart Wordwell.';
  }
  const ready = () => { if (failure) throw new LookupError(failure, 503); };
  const serial = operation => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const checkRevision = value => { if (value !== state.revision) throw new LookupError('AI settings changed in another tab. Reload Settings before saving again.', 409); };
  function connection(payload) {
    const provider = definition(payload.provider);
    const profile = validateProfile(payload.provider, { ...defaults(provider || {}), ...payload, model: 'connection-check' });
    const previous = state.profiles[payload.provider];
    if (profile.allowNoKey) profile.apiKey = '';
    else if (!profile.apiKey && previous?.apiKey) {
      if (previous.baseUrl !== profile.baseUrl) throw new LookupError('Re-enter the API key when changing the endpoint.', 400);
      profile.apiKey = previous.apiKey;
    }
    if (!profile.apiKey && !profile.allowNoKey) throw new LookupError('Enter an API key before connecting.', 400);
    return { baseUrl: profile.baseUrl, apiKey: profile.apiKey, allowNoKey: profile.allowNoKey };
  }
  const fingerprint = (provider, profile) => createHash('sha256').update(JSON.stringify([provider, profile.baseUrl, profile.apiKey, profile.allowNoKey])).digest('hex');
  const publicState = () => {
    ready();
    return {
      revision: state.revision, activeProvider: state.activeProvider, configured: configured(state), setupDismissed: state.setupDismissed,
      providers: PROVIDERS,
      allowKeyReveal: allowKeyReveal === true,
      profiles: Object.fromEntries(Object.entries(state.profiles).map(([id, { apiKey, ...profile }]) => [id, { ...profile, hasKey: Boolean(apiKey) }])),
    };
  };
  return {
    publicState,
    revealKey(payload) {
      if (allowKeyReveal !== true) throw new LookupError('API key revealing is disabled.', 403);
      ready();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['revision', 'provider'].includes(key)) || !definition(payload.provider)) throw new LookupError('Choose a saved provider key to reveal.', 400);
      checkRevision(payload.revision);
      const apiKey = state.profiles[payload.provider]?.apiKey;
      if (!apiKey) throw new LookupError('No API key is saved for this provider. Add a key first.', 404);
      return { apiKey };
    },
    async discover(payload, { signal } = {}) {
      ready();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['revision', 'provider', 'baseUrl', 'apiKey', 'allowNoKey'].includes(key))) throw new LookupError('Send a valid connection form.', 400);
      checkRevision(payload.revision);
      const profile = connection(payload);
      if (connections >= 2) throw new LookupError('Other connection checks are running. Try again shortly.', 429);
      connections++;
      try {
        const models = await listAvailableModels({ definition: definition(payload.provider), ...profile, signal });
        checkRevision(payload.revision);
        if (signal?.aborted) throw new LookupError('Connection check stopped.', 499);
        const connectionToken = randomUUID();
        const expiresAt = Date.now() + 10 * 60_000;
        for (const [token, value] of verified) if (value.expiresAt <= Date.now()) verified.delete(token);
        if (verified.size >= 50) verified.delete(verified.keys().next().value);
        verified.set(connectionToken, { revision: state.revision, fingerprint: fingerprint(payload.provider, profile), expiresAt, models: new Map(models.map(model => [model.id, model])) });
        return { models, connectionToken, expiresAt };
      } finally { connections--; }
    },
    active() {
      ready();
      if (!configured(state)) throw new LookupError('AI is not configured. Open Settings to choose a provider, model, and API key.', 503);
      return { ...state.profiles[state.activeProvider], provider: state.activeProvider, revision: state.revision };
    },
    save(payload) {
      return serial(async () => {
        ready();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['revision', 'provider', 'model', 'baseUrl', 'apiKey', 'clearKey', 'jsonMode', 'vision', 'allowNoKey', 'connectionToken'].includes(key)) || typeof payload.clearKey !== 'boolean' || typeof payload.apiKey !== 'string') throw new LookupError('Send a valid AI settings form.', 400);
        checkRevision(payload.revision);
        const previous = state.profiles[payload.provider];
        if (payload.clearKey && payload.apiKey) throw new LookupError('Choose either a replacement key or Remove saved key.', 400);
        let profile;
        if (payload.clearKey) {
          if (!previous?.apiKey) throw new LookupError('There is no saved key to remove for this provider.', 400);
          profile = { ...previous, apiKey: '', allowNoKey: false };
        } else {
          profile = validateProfile(payload.provider, { ...payload, ...connection(payload) });
          const proof = typeof payload.connectionToken === 'string' ? verified.get(payload.connectionToken) : null;
          if (!proof || proof.expiresAt <= Date.now() || proof.revision !== state.revision || proof.fingerprint !== fingerprint(payload.provider, profile)) throw new LookupError('Connect with this key and endpoint before saving. Connection checks expire after 10 minutes.', 409);
          const selected = proof.models.get(profile.model);
          if (!selected) throw new LookupError('Choose a model returned by this connection.', 400);
          if (profile.vision && selected.vision === false) throw new LookupError('This model does not accept images. Disable image questions or choose another model.', 400);
        }
        await persist({ ...state, revision: state.revision + 1, activeProvider: payload.provider, setupDismissed: true, profiles: { ...state.profiles, [payload.provider]: profile } });
        verified.clear();
        return publicState();
      });
    },
    dismiss(revision) {
      return serial(async () => { ready(); checkRevision(revision); await persist({ ...state, setupDismissed: true, revision: state.revision + 1 }); verified.clear(); return publicState(); });
    },
  };
}
