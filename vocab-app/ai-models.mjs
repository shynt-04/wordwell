import { LookupError } from './ai-errors.mjs';

const invalidList = () => new LookupError('This endpoint did not return a usable model list. Check its base URL and /models support.', 502);

async function readCatalog(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new LookupError('The model list is too large. Use an endpoint with a smaller catalog.', 502);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalidList(); }
}

function modelInfo(item, protocol) {
  if (!item || typeof item !== 'object') return null;
  if (protocol === 'gemini' && (!Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.includes('generateContent'))) return null;
  const id = protocol === 'gemini' && typeof item.name === 'string' ? item.name.replace(/^models\//u, '') : protocol === 'gemini' ? '' : item.id;
  if (typeof id !== 'string' || !id || id.length > 180 || /\s|[\u0000-\u001f\u007f]/u.test(id)) return null;
  const output = item.output_modalities;
  if (Array.isArray(output) && !output.some(value => typeof value === 'string' && value.toLowerCase() === 'text')) return null;
  // Gemini's catalog also includes image-only and audio-only generation models.
  if (protocol === 'gemini' && /(?:embedding|imagen|veo|(?:^|-)tts(?:-|$)|native-audio|(?:^|-)image(?:-|$))/iu.test(id)) return null;
  const title = item.displayName ?? item.display_name ?? item.name;
  const name = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200) : id;
  const input = item.input_modalities;
  const vision = Array.isArray(input) ? input.some(value => typeof value === 'string' && value.toLowerCase() === 'image') : null;
  return { id, name: name || id, vision };
}

export async function listAvailableModels({ definition, baseUrl, apiKey, allowNoKey, signal, fetchImpl = fetch }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 20_000);
  const headers = { Accept: 'application/json' };
  if (definition.protocol === 'gemini') headers['x-goog-api-key'] = apiKey;
  else if (definition.protocol === 'claude') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (!allowNoKey) headers.Authorization = `Bearer ${apiKey}`;
  const models = new Map();
  const cursors = new Set();
  let cursor = '';
  try {
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${baseUrl}/models`);
      if (definition.protocol === 'gemini') { url.searchParams.set('pageSize', '1000'); if (cursor) url.searchParams.set('pageToken', cursor); }
      if (definition.protocol === 'claude') { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor); }
      const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        const messages = {
          400: 'The provider rejected the connection request. Check the key and endpoint configuration.',
          401: 'The API key was rejected. Check it and try connecting again.',
          402: 'The provider requires credit before this request can proceed.',
          403: 'Access was denied. The key may be invalid, restricted, or lack permission to list models.',
          404: 'No model-list API was found. Check the base URL; this endpoint must support /models.',
          429: 'The provider rate limit was reached. Wait a moment and connect again.',
        };
        throw new LookupError(messages[response.status] || 'The provider could not list models. Try connecting again later.', response.status === 429 ? 429 : 502);
      }
      const data = await readCatalog(response);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidList();
      const items = definition.protocol === 'gemini' ? data?.models ?? [] : data?.data;
      if (!Array.isArray(items) || items.length > 5000) throw invalidList();
      for (const item of items) { const model = modelInfo(item, definition.protocol); if (model) models.set(model.id, model); }
      if (models.size > 5000) throw invalidList();
      const next = definition.protocol === 'gemini' ? data.nextPageToken : definition.protocol === 'claude' && data.has_more ? data.last_id : '';
      if (!next) {
        if (definition.protocol === 'claude' && data.has_more) throw invalidList();
        if (!models.size) throw new LookupError('Connected, but no text-generation models were returned. For Ollama, download a model first; for a proxy, check its model configuration.', 422);
        return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      }
      if (typeof next !== 'string' || next.length > 2000 || cursors.has(next)) throw invalidList();
      cursors.add(next);
      cursor = next;
    }
    throw new LookupError('The provider returned too many model pages. Use an endpoint with a smaller catalog.', 502);
  } catch (error) {
    if (signal?.aborted) throw new LookupError('Connection check stopped.', 499);
    if (controller.signal.aborted) throw new LookupError('Connection timed out. Check the endpoint and try again.', 504);
    if (error instanceof LookupError) throw error;
    throw new LookupError(`Cannot connect to ${definition.name}. Check your network and make sure any local server is running.`, 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
