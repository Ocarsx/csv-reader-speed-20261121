// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answer as csv-reader 1.0.0 for every input {text, header}: {columns, rows, errors}.
// Written from the published semantics, not copied from the reference: one pass, left to right.
// Speed comes from slicing whole fields out of the text instead of building them
// character by character, and from one regex scan that jumps straight to the next
// delimiter of an unquoted field.
//
// Semantics (csv-reader 1.0.0):
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF; a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (error stray_cr);
// - a field opening with a quote runs to the next quote that is not doubled; "" inside
//   is one quote and each CRLF or lone CR inside reads as LF; what follows its closing
//   quote up to the next comma or line break is appended as it stands (quote_junk, when
//   the field ends); a quote that never closes is a literal character and the text after
//   it is read again as unquoted (unterminated_quote);
// - a quote inside an unquoted field is a literal character; fields stay strings;
// - columns is the first record when header is true, else null; rows holds the records
//   after it, each padded with "" (short_row, with fields: its count) or cut (long_row,
//   with extra: the cut fields) to the first record's width;
// - each error is {code, line, row}, in the order met; line is the 1-based line its
//   record starts on (counting every LF, CRLF and lone CR inside quotes), row its
//   record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

// The next delimiter of an unquoted field: comma, LF or CR, whichever is nearest.
// One shared regex; every scan sets lastIndex first, so calls never interfere.
const DELIM = /[,\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // How the field being read ended; written by the scanners below.
  let ended = END;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at `start`, with `prefix` already in its value
  // ('' for a plain field, '"' when a quote never closed, the quoted value when junk
  // follows a closing quote). Returns the field; sets ended, pos, line.
  // One regex scan finds the next comma, LF or CR, whichever is nearest, so the
  // field is a single slice in the common case. A lone CR is rare: it is dropped
  // with a stray_cr error and the scan goes on from just after it.
  function scanUnquoted(start, prefix) {
    let value = prefix;
    let seg = start;
    DELIM.lastIndex = start;
    for (;;) {
      const m = DELIM.exec(text);
      if (m === null) {
        pos = n;
        ended = END;
        return value.length === 0 ? text.slice(seg) : value + text.slice(seg);
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        pos = i + 1;
        ended = COMMA;
        return value.length === 0 ? text.slice(seg, i) : value + text.slice(seg, i);
      }
      if (c === '\n') {
        pos = i + 1;
        line += 1;
        ended = BREAK;
        return value.length === 0 ? text.slice(seg, i) : value + text.slice(seg, i);
      }
      // A CR: CRLF ends the record, a lone CR is dropped with an error.
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        ended = BREAK;
        return value.length === 0 ? text.slice(seg, i) : value + text.slice(seg, i);
      }
      error('stray_cr');
      value += text.slice(seg, i);
      seg = i + 1;
      DELIM.lastIndex = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field; sets
  // ended, pos, line. The closing quote is found with indexOf; doubled quotes are
  // folded in as segments. Newlines inside the quotes (rare) go through a slow
  // scan that turns each CRLF or lone CR into one LF and counts the lines.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let acc = null; // segments kept across doubled quotes, null while one slice
    let seg = open + 1;
    for (;;) {
      const idx = text.indexOf('"', p);
      if (idx === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as unquoted. Line is still openLine: nothing inside the
        // failed scan counted, so no reset is needed.
        error('unterminated_quote');
        return scanUnquoted(open + 1, '"');
      }
      if (idx + 1 < n && text.charCodeAt(idx + 1) === 34) {
        // A doubled quote: one literal quote, and the scan goes on.
        acc = acc === null ? text.slice(seg, idx) + '"' : acc + text.slice(seg, idx) + '"';
        p = idx + 2;
        seg = idx + 2;
        continue;
      }
      // Closed at idx.
      let value;
      if (acc === null) {
        const span = text.slice(open + 1, idx);
        value =
          span.indexOf('\n') === -1 && span.indexOf('\r') === -1
            ? span
            : scanQuotedSlow(open + 1, idx);
      } else {
        const span = text.slice(open + 1, idx);
        value =
          span.indexOf('\n') === -1 && span.indexOf('\r') === -1
            ? acc + text.slice(seg, idx)
            : scanQuotedSlow(open + 1, idx);
      }
      const after = idx + 1;
      if (after >= n) {
        pos = n;
        ended = END;
        return value;
      }
      const c = text.charCodeAt(after);
      if (c === 44) {
        pos = after + 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        pos = after + 1;
        line += 1;
        ended = BREAK;
        return value;
      }
      if (c === 13 && after + 1 < n && text.charCodeAt(after + 1) === 10) {
        pos = after + 2;
        line += 1;
        ended = BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break. quote_junk when anything was kept.
      const junk = scanUnquoted(after, value);
      if (junk.length > value.length) error('quote_junk');
      return junk;
    }
  }

  // Slow path for a quoted field holding a line break: reads [from, to) turning
  // each CRLF or lone CR into one LF and counting the lines; doubled quotes fold
  // to one quote. `to` is the closing quote, found already.
  function scanQuotedSlow(from, to) {
    let value = '';
    let seg = from;
    let i = from;
    while (i < to) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        value += text.slice(seg, i) + '"';
        i += 2;
        seg = i;
      } else if (c === 13) {
        value += text.slice(seg, i) + '\n';
        line += 1;
        i += i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
      } else if (c === 10) {
        value += text.slice(seg, i) + '\n';
        line += 1;
        i += 1;
        seg = i;
      } else {
        i += 1;
      }
    }
    return value + text.slice(seg, to);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    const isHeader = header && columns === null;
    recordRow = isHeader ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(scanQuoted());
      } else {
        quoted = false;
        fields.push(scanUnquoted(pos, ''));
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (isHeader) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
