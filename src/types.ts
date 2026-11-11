/**
 * MarketSharp "application authentication" credentials. All four values are
 * exchanged at POST /token for a short-lived bearer JWT (see client.ts).
 *
 * - companyId: the MarketSharp company the connection reads. Not secret.
 * - apiKey / apiSecret: from MarketSharp Admin → API maintenance. Secret.
 * - employeeId: optional MarketSharp employee OID (`empoid`). Several
 *   endpoints (QuickFind search, contact notes, opportunity notes) need an
 *   employee inside the token and act with that employee's permissions.
 */
export interface MarketSharpCredentials {
  companyId: string;
  apiKey: string;
  apiSecret: string;
  employeeId?: string;
}
