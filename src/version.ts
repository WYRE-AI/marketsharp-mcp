import { createRequire } from 'node:module';

/** Package version (semantic-release bumps package.json; the image ships it next to dist/). */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
