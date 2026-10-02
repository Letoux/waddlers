/**
 * Text input hygiene shared by the filter values and the search (audit F1). A lone UTF-16
 * surrogate (`"\uD800"`) survives JSON but cannot be encoded as UTF-8: the driver would send
 * invalid text and PostgreSQL would answer with an error (22P02/22P05), i.e. a 500. It is refused at
 * validation instead (BAD_REQUEST). Regex rather than `String.prototype.isWellFormed`: this
 * package targets a lib without it, and the behaviour is identical.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const isWellFormedText = (s: string): boolean => !LONE_SURROGATE.test(s);

/** PostgreSQL text cannot hold NUL, and a lone surrogate is not valid Unicode text. */
export const isStorableText = (s: string): boolean => !s.includes('\u0000') && isWellFormedText(s);
