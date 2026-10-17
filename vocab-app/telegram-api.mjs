import { LookupError } from './ai-errors.mjs';
import { tokenValid } from './telegram-settings.mjs';

export class TelegramError extends LookupError {
  constructor(message, status = 502, retryAfter = 0) { super(message, status); this.retryAfter = retryAfter; }
}

export async function telegramCall(token, method, payload = {}, { fetchImpl = fetch, signal } = {}) {
  if (!tokenValid(token) || !['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery'].includes(method)) throw new TelegramError('Invalid Telegram request.', 400);
  const timeout = AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const contents = await response.text();
    if (contents.length > 1024 * 1024) throw new TelegramError('Telegram returned an unexpectedly large response.');
    let data;
    try { data = JSON.parse(contents); } catch { throw new TelegramError('Telegram returned an unreadable response.'); }
    if (!response.ok || data.ok !== true) {
      const status = Number(data.error_code) || response.status;
      const message = status === 401 ? 'Telegram rejected the bot token. Check it in BotFather.' : status === 409 ? 'This bot is already used by another runner or webhook. Stop that runner, or create a separate bot.' : status === 403 ? 'Telegram could not reach your account. Unblock and open your bot, or link it again.' : status === 429 ? 'Telegram is busy. Wordwell will wait before retrying.' : 'Telegram could not complete the request. Check your internet connection and try again.';
      throw new TelegramError(message, status >= 400 && status < 600 ? status : 502, Math.min(300, Math.max(0, Number(data.parameters?.retry_after) || 0)));
    }
    if (method === 'sendMessage' && (!Number.isSafeInteger(data.result?.message_id) || data.result.message_id <= 0)) throw new TelegramError('Telegram returned an unreadable message confirmation.');
    return data.result;
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    // Telegram embeds the secret in its URL. Never pass upstream errors/URLs
    // or descriptions through to the page, chat, console, or log files.
    throw new TelegramError(signal?.aborted ? 'Telegram request stopped.' : 'Cannot reach Telegram. Check your internet connection and try again.');
  }
}
