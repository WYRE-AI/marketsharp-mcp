const unescapeText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Replace each inline vendor-detail envelope in an error message with its unescaped text. */
export function unwrapVendorDetail(message: string): string {
  return message.replace(
    /<untrusted-content nonce="([0-9a-f]+)">([\s\S]*?)<\/untrusted-content nonce="\1">/g,
    (_m, _nonce: string, inner: string) => unescapeText(inner),
  );
}

/** Strip the notice and outer envelope from a successful tool result's text. */
export function unwrapToolText(text: string): string {
  const m = /^[^\n]*\n<untrusted-content nonce="([0-9a-f]+)">\n([\s\S]*)\n<\/untrusted-content nonce="\1">$/.exec(text);
  if (!m) throw new Error(`not an untrusted envelope: ${text.slice(0, 80)}`);
  return unescapeText(m[2]);
}
