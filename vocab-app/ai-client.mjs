import { LookupError } from './ai-errors.mjs';
import { PROVIDERS } from './ai-settings.mjs';

export async function generateJSON({ provider = 'deepseek', model = 'deepseek-flash', baseUrl, apiKey, allowNoKey = false, jsonMode = true, vision = true, system, user, image = '', images = [], maxTokens = 600, timeout = 45_000, fetchImpl = fetch, signal }) {
  const definition = PROVIDERS.find(item => item.id === provider);
  if (!definition) throw new LookupError('Choose an AI provider in Settings.', 503);
  const name = definition.name;
  baseUrl ||= definition.baseUrl;
  if (!model || !baseUrl || !apiKey?.trim() && !allowNoKey) throw new LookupError('AI is not configured. Open Settings to choose a provider, model, and API key.', 503);
  if (!Array.isArray(images) || images.length > 4) throw new LookupError('Attach at most 4 screenshots per request.', 400);
  const inputImages = image ? [image, ...images] : images;
  if (inputImages.length > 4) throw new LookupError('Attach at most 4 screenshots per request.', 400);
  if (inputImages.length && !vision) throw new LookupError('Image input is disabled for this provider. Choose a vision model and enable image input in Settings.', 400);
  const imageMatches = inputImages.map(value => typeof value === 'string' ? value.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/u) : null);
  if (imageMatches.some(match => !match)) throw new LookupError('Attach PNG, JPEG, or WebP images.', 400);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const headers = { 'Content-Type': 'application/json' };
    let endpoint;
    let body;
    const nativeBudget = maxTokens < 1000 ? 2048 : 8192;
    if (definition.protocol === 'gemini') {
      endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      headers['x-goog-api-key'] = apiKey.trim();
      const parts = [{ text: user }];
      for (const match of imageMatches) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: nativeBudget } };
    } else if (definition.protocol === 'claude') {
      endpoint = `${baseUrl}/messages`;
      headers['x-api-key'] = apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
      const content = [{ type: 'text', text: user }];
      for (const match of imageMatches) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      body = { model, max_tokens: nativeBudget, stream: false, system, messages: [{ role: 'user', content }] };
    } else {
      endpoint = `${baseUrl}/chat/completions`;
      if (apiKey?.trim() && !allowNoKey) headers.Authorization = `Bearer ${apiKey.trim()}`;
      const content = inputImages.length ? [{ type: 'text', text: user }, ...inputImages.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))] : user;
      body = { model, stream: false, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
      if (jsonMode) body.response_format = { type: 'json_object' };
      if (provider === 'deepseek') body.thinking = { type: 'disabled' };
    }
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      const messages = {
        400: `${name} could not process the request. Check the model, image support, and JSON mode in Settings.`,
        401: `${name} rejected the API key. Update it in Settings.`,
        402: `${name} reported insufficient balance. Check your provider account.`,
        403: `${name} denied access. Check your key, region, and model permissions.`,
        404: `${name} could not find the model or endpoint. Check Settings.`,
        429: `${name} reached a rate or usage limit. Please try again later.`,
      };
      throw new LookupError(messages[response.status] || `${name} is temporarily unavailable. Please try again later.`, response.status === 429 ? 429 : 502);
    }
    let data;
    try { data = await response.json(); } catch { throw new LookupError(`${name} returned an unreadable response.`); }
    let content;
    let finished;
    if (definition.protocol === 'gemini') {
      const candidate = data?.candidates?.[0];
      finished = candidate?.finishReason === 'STOP';
      content = candidate?.content?.parts?.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
    } else if (definition.protocol === 'claude') {
      finished = data?.stop_reason === 'end_turn';
      content = data?.content?.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    } else {
      const choice = data?.choices?.[0];
      finished = choice?.finish_reason === 'stop';
      content = choice?.message?.content;
    }
    if (!finished || typeof content !== 'string' || !content.trim() || content.length > (maxTokens < 1000 ? 12_000 : 100_000)) throw new LookupError(`${name} did not finish a usable answer. Try again or choose another model.`);
    // Some compatible providers wrap an otherwise valid JSON object in a code fence.
    content = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1');
    try { return JSON.parse(content); } catch { throw new LookupError(`${name} returned invalid JSON. Enable JSON mode when supported, or choose another model in Settings.`); }
  } catch (error) {
    if (error instanceof LookupError) throw error;
    if (controller.signal.aborted) throw new LookupError(signal?.aborted ? 'AI request was stopped.' : `${name} took too long. Your input is kept; please try again.`, 504);
    throw new LookupError(`Could not reach ${name}. Check the connection and API endpoint in Settings.`);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
