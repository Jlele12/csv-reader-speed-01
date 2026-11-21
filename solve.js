// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly the answer
// csv-reader 1.0.0 returns for {text, header}: {columns, rows, errors}.
//
// Semantics (mirroring the reference vendor/csv-reader/index.js):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr, no line advance);
//   - a quoted field runs to the next quote that is not doubled, "" is one quote,
//     and each CRLF or lone CR inside is read as LF; what follows the closing
//     quote, up to the next comma or line break, is appended as it stands
//     (quote_junk, only when at least one character is kept); a quote that never
//     closes is a literal '"' and the rest is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - rows are padded (short_row) or cut (long_row) to the first record's width;
//   - each error is {code, line, row}, line the 1-based line the record starts on
//     (every LF, CRLF and lone CR inside quotes counted), row the record's index
//     in rows (null for the header), in the order met.
//
// Speed: the reference reads one character at a time and builds every field one
// character at a time. This module scans with indexOf for the next delimiter and
// copies whole spans with substring, falling back to a per-character walk only
// where a stray CR or a quote pair forces it.

const LF = 10, CR = 13, COMMA = 44, QUOTE = 34;

/** Index of the next comma, LF or CR at or after i, or text.length. */
function nextDelim(text, i) {
  const a = text.indexOf(',', i);
  const b = text.indexOf('\n', i);
  const c = text.indexOf('\r', i);
  let m = a < 0 ? b : (b < 0 ? a : (a < b ? a : b));
  if (m < 0) m = b;
  if (c >= 0 && (m < 0 || c < m)) m = c;
  if (m < 0) m = text.length;
  return m;
}

/** Lines a quoted-field span adds: every LF, CRLF and lone CR is one line. */
function quotedLines(text, from, to) {
  // Fast path: no CR in the span, the lines are its LFs alone.
  const cr = text.indexOf('\r', from);
  if (cr < 0 || cr >= to) {
    let n = 0;
    for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) n += 1;
    return n;
  }
  let n = 0;
  for (let i = from; i < to; i++) {
    const ch = text.charCodeAt(i);
    if (ch === LF) n += 1;
    else if (ch === CR) {
      // CRLF is one line, a lone CR is one line: count the CR, skip its LF.
      n += 1;
      if (i + 1 < to && text.charCodeAt(i + 1) === LF) i += 1;
    }
  }
  return n;
}

/**
 * Reads an unquoted field from pos up to the next comma, line break or the end:
 * a CR not followed by LF is dropped (stray_cr). Returns {value, end, line}
 * where end is the position after the field's terminator (or text.length) and
 * kind: 0 comma, 1 line break, 2 end of text. `kept` counts kept characters.
 */
function readUnquoted(text, pos, line, errors, recordLine, recordRow) {
  const start = pos;
  const d = nextDelim(text, pos);
  const seg = d === start ? '' : text.slice(start, d);
  // Fast path: no CR in the span, nothing to drop.
  if (seg.indexOf('\r') < 0) {
    if (d >= text.length) return { value: seg, pos: d, line, kind: 2, kept: seg.length };
    const ch = text.charCodeAt(d);
    if (ch === COMMA) return { value: seg, pos: d + 1, line, kind: 0, kept: seg.length };
    if (ch === CR && (d + 1 >= text.length || text.charCodeAt(d + 1) !== LF)) {
      // A lone CR is not a line break: drop it and keep reading (stray_cr).
    } else if (ch !== COMMA) {
      // LF, or a CRLF: the record ends here.
      return { value: seg, pos: d + (ch === CR ? 2 : 1), line: line + 1, kind: 1, kept: seg.length };
    }
  }
  // Slow path: walk the span, dropping stray CRs (each an error, no line change).
  let value = '';
  let kept = 0;
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === COMMA) return { value, pos: i + 1, line, kind: 0, kept };
    if (ch === LF) return { value, pos: i + 1, line: line + 1, kind: 1, kept };
    if (ch === CR) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === LF) {
        return { value, pos: i + 2, line: line + 1, kind: 1, kept };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      i += 1;
      continue;
    }
    // Copy the run of plain characters up to the next delimiter.
    const d2 = nextDelim(text, i);
    value += text.slice(i, d2);
    kept += d2 - i;
    i = d2;
  }
  return { value, pos: i, line, kind: 2, kept };
}

/**
 * Reads a quoted field whose opening quote is at pos. Returns like
 * readUnquoted; `quoteJunk` marks a junk suffix after the closing quote.
 */
function readQuoted(text, pos, line, errors, recordLine, recordRow) {
  const open = pos;
  const openLine = line;
  let value = '';
  pos += 1;
  let closed = false;
  while (pos <= text.length) {
    const q = text.indexOf('"', pos);
    if (q < 0) break; // never closes
    if (q + 1 < text.length && text.charCodeAt(q + 1) === QUOTE) {
      // A doubled quote: the span up to it is literal, then one quote.
      const seg = text.slice(pos, q);
      value += seg.indexOf('\r') < 0 ? seg : seg.replace(/\r\n?/g, '\n');
      line += quotedLines(text, pos, q);
      value += '"';
      pos = q + 2;
      continue;
    }
    const seg = text.slice(pos, q);
    value += seg.indexOf('\r') < 0 ? seg : seg.replace(/\r\n?/g, '\n');
    line += quotedLines(text, pos, q);
    pos = q + 1;
    closed = true;
    break;
  }
  if (!closed) {
    // The quote never closes: a literal '"', the text after it read again as
    // unquoted (unterminated_quote).
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    const r = readUnquoted(text, pos, line, errors, recordLine, recordRow);
    r.value = '"' + r.value;
    r.kept += 1;
    return r;
  }
  if (pos >= text.length) return { value, pos, line, kind: 2, kept: -1, junk: false };
  const ch = text.charCodeAt(pos);
  if (ch === COMMA) return { value, pos: pos + 1, line, kind: 0, kept: -1, junk: false };
  if (ch === LF) return { value, pos: pos + 1, line: line + 1, kind: 1, kept: -1, junk: false };
  if (ch === CR) {
    if (pos + 1 < text.length && text.charCodeAt(pos + 1) === LF) {
      return { value, pos: pos + 2, line: line + 1, kind: 1, kept: -1, junk: false };
    }
    // A lone CR right after the closing quote: junk (dropped as stray_cr).
    const r = readUnquoted(text, pos, line, errors, recordLine, recordRow);
    r.value = value + r.value;
    r.junk = r.kept > 0;
    return r;
  }
  // What follows the closing quote is appended as it stands, up to the next
  // comma or line break (quote_junk when the field ends and something is kept).
  const r = readUnquoted(text, pos, line, errors, recordLine, recordRow);
  r.junk = r.kept > 0;
  r.value = value + r.value;
  return r;
}

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < text.length) {
      const ch = text.charCodeAt(pos);
      if (ch === LF) {
        pos += 1;
        line += 1;
      } else if (ch === CR && pos + 1 < text.length && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= text.length) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      field = quoted
        ? readQuoted(text, pos, line, errors, recordLine, recordRow)
        : readUnquoted(text, pos, line, errors, recordLine, recordRow);
      if (field.junk) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      fields.push(field.value);
      pos = field.pos;
      line = field.line;
    } while (field.kind === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
