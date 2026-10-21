/** Drop literal model markers such as <|eos|> that a model sometimes writes into chat text. */
export function stripModelTokens(value: string): string {
  return String(value || '').replace(/<\|[^|>]*\|>/g, '').trim();
}
