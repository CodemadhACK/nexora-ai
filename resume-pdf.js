/**
 * Résumé PDFs, turned into the plain text the profile stores.
 *
 * The profile has always been a text box, and the importer used to refuse a PDF
 * outright with "open it, select all, and paste" — which is a chore for the one
 * file every user of this app already has to hand. This reads the text layer
 * instead.
 *
 * It extracts text and nothing else. No layout, no images, no OCR: a résumé's
 * value here is the words, and the model reads them out of the system prompt.
 * A scanned résumé has no text layer at all, and the honest answer to that is to
 * say so rather than to save an empty profile that silently answers nothing.
 *
 * The parser is injected so the whole thing is testable without loading a PDF
 * engine, and so the one place that touches a third-party library is a single
 * argument rather than a hard require in the middle of the logic.
 */

'use strict';

/** pdf-parse marks each page break in its output; the profile does not want them. */
const PAGE_MARKER = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/;

/**
 * Anything shorter than this, after cleaning, means the file had no usable text
 * layer — almost always a scan or a photo saved as a PDF.
 */
const MIN_USABLE_CHARS = 40;

function defaultParse(data) {
  // Required lazily: the profile importer is the only caller, and loading a PDF
  // engine at startup would cost every launch for a feature used once.
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data });
  return parser.getText().finally(() => {
    if (typeof parser.destroy === 'function') return parser.destroy();
    return undefined;
  });
}

/**
 * Collapses the runs of whitespace a PDF text layer is full of. Columns, table
 * cells and letter-spaced headings all arrive as scattered spaces and newlines,
 * and a résumé that reaches the model as one word per line reads as nonsense.
 */
function tidy(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !PAGE_MARKER.test(line))
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Uint8Array|Buffer} data   the PDF bytes
 * @param {object} [options]
 * @param {Function} [options.parse] injected for tests
 * @param {number} [options.limit]   characters to keep, matching the profile cap
 * @returns {Promise<{ text: string, pages: number }>}
 * @throws {Error} with a message written for the user, not for a log
 */
async function extractResumeText(data, { parse = defaultParse, limit = Infinity } = {}) {
  if (!data || !data.length) throw new Error('That PDF is empty.');

  let result;
  try {
    result = await parse(data);
  } catch (err) {
    // A password-protected file is the common case worth naming, because the
    // fix is different from every other failure.
    if (/password|encrypt/i.test(err.message || '')) {
      throw new Error('That PDF is password protected. Save an unlocked copy and try again.');
    }
    throw new Error(`Could not read that PDF: ${err.message}`);
  }

  const text = tidy(result && result.text);
  if (text.length < MIN_USABLE_CHARS) {
    throw new Error(
      'That PDF has no text in it — it is probably a scan or a photo. ' +
      'Export a text PDF from your editor, or paste the text in directly.'
    );
  }

  return {
    text: limit === Infinity ? text : text.slice(0, limit),
    pages: (result && result.total) || 1
  };
}

module.exports = { extractResumeText, tidy, MIN_USABLE_CHARS };
