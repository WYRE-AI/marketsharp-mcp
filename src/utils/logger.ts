import { redactText } from '../redact.js';
import { scopedCredentials } from '../scope.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (env in LEVELS) ? env as LogLevel : 'info';
}

/** Every credential that could be in play: the env pair (stdio / AUTH_MODE=env) and the per-request gateway pair. */
function knownSecrets(): Array<string | undefined> {
  const scoped = scopedCredentials();
  return [
    process.env.MARKETSHARP_API_KEY?.trim(),
    process.env.MARKETSHARP_API_SECRET?.trim(),
    scoped?.apiKey,
    scoped?.apiSecret,
  ];
}

/** Logs to stderr (stdout is the stdio transport). Every line is redacted, including the message itself. */
function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (context !== undefined) {
    let contextStr: string;
    try { contextStr = JSON.stringify(context); }
    catch { contextStr = String(context); }
    line += ` ${contextStr}`;
  }
  console.error(redactText(line, knownSecrets()));
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log('debug', msg, ctx),
  info: (msg: string, ctx?: unknown) => log('info', msg, ctx),
  warn: (msg: string, ctx?: unknown) => log('warn', msg, ctx),
  error: (msg: string, ctx?: unknown) => log('error', msg, ctx),
};
