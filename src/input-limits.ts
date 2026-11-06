/** Largest /mcp request body accepted over HTTP, in bytes. Larger bodies get a 413. */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Cap on the text handed back to the model. */
export const MAX_RESPONSE_CHARS = 200_000;
