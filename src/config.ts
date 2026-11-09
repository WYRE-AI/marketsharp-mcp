/**
 * Tool tiers. Reads are always configured; the write tier (four create-only
 * tools) is added only when MARKETSHARP_ENABLE_WRITES is exactly true/1. The
 * per-request X-Conduit-Tool-Tiers header can only narrow that set.
 */
export type ToolTier = 'read' | 'write';

export const ALL_TIERS: readonly ToolTier[] = ['read', 'write'];

export const DEFAULT_TIERS: readonly ToolTier[] = ['read'];

/** Header Conduit may send to narrow (never widen) the enabled tiers for one request. */
export const TOOL_TIERS_HEADER = 'x-conduit-tool-tiers';

/** Writes are off unless MARKETSHARP_ENABLE_WRITES is exactly true/1. There are no delete tools at all. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(true|1)$/i.test((env.MARKETSHARP_ENABLE_WRITES ?? '').trim());
}

/** The container's tier set: DEFAULT_TIERS, plus write when MARKETSHARP_ENABLE_WRITES is on. */
export function configuredTiers(env: NodeJS.ProcessEnv = process.env): ReadonlySet<ToolTier> {
  return new Set<ToolTier>(writesEnabled(env) ? ALL_TIERS : DEFAULT_TIERS);
}

/**
 * Intersects the configured tiers with a per-request tier header. Unknown or
 * not-configured entries are dropped, so the header can only remove tiers.
 * A present header that names no configured tier (including an empty one)
 * yields an empty set (no tools), not the configured default.
 */
export function narrowTiers(configured: ReadonlySet<ToolTier>, header: string | undefined): ReadonlySet<ToolTier> {
  if (header === undefined) return configured;
  const requested = new Set(
    header
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
  return new Set(ALL_TIERS.filter((t) => configured.has(t) && requested.has(t)));
}
