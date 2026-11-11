import { createRequire } from 'node:module';
import { logger } from './utils/logger.js';

const UNKNOWN_VERSION = '0.0.0-unknown';

/** Package version (semantic-release bumps package.json; the image ships it next to dist/). */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const version = (require('../package.json') as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
    logger.warn(`package.json has no version; reporting ${UNKNOWN_VERSION}.`);
  } catch (err) {
    logger.warn(`Couldn't read package.json for the server version; reporting ${UNKNOWN_VERSION}.`, {
      error: (err as Error).message,
    });
  }
  return UNKNOWN_VERSION;
}

export const VERSION = readVersion();
