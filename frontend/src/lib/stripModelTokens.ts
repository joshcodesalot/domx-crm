/** Drop literal model markers such as <|eos|> that Grok sometimes writes into chat text. */
export function stripModelTokens(value: string): string {
  return String(value || '').replace(/<\|[^|>]*\|>/g, '').trim();
}
