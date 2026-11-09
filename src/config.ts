/**
 * Every tool in this server is read-only, so `read` is the only tier. The
 * tier machinery is kept identical to the rest of the fleet so Conduit's
 * X-Conduit-Tool-Tiers contract behaves the same here: the header can only
 * narrow the set, and a present but empty header means no tools.
 */
export type ToolTier = 'read';

export const ALL_TIERS: readonly ToolTier[] = ['read'];

/** Header Conduit may send to narrow (never widen) the enabled tiers for one request. */
export const TOOL_TIERS_HEADER = 'x-conduit-tool-tiers';

/** The container's tier set. Nothing in the environment can widen it. */
export function configuredTiers(): ReadonlySet<ToolTier> {
  return new Set(ALL_TIERS);
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
