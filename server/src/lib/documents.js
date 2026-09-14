'use strict';

/**
 * Text extraction from an uploaded résumé (§56).
 *
 * PDF  -> pdf-parse, already a dependency of the desktop app
 * DOCX -> read directly; a .docx is a ZIP holding word/document.xml
 * TXT/MD -> as-is
 *
 * The DOCX reader is hand-rolled against the ZIP spec rather than pulling in an
 * archive library, because it needs exactly one file out of the archive and
 * node:zlib already provides the only hard part (raw DEFLATE).
 */

const { inflateRawSync } = require('node:zlib');
const { badRequest } = require('./errors');

const MAX_BYTES = 8 * 1024 * 1024;

const TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/octet-stream': null, // decided by extension
};

function kindOf(filename, mimeType) {
  const byMime = TYPES[mimeType];
  if (byMime) return byMime;
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['txt', 'md', 'markdown'].includes(ext)) return 'text';
  return null;
}

// ───────────────────────── DOCX ─────────────────────────

/**
 * Pulls one member out of a ZIP by scanning the central directory.
 *
 * The central directory is authoritative and sits at the end of the file, so
 * this walks backwards from the End Of Central Directory record rather than
 * trusting the local headers, which may carry zeroed sizes when the archive was
 * written as a stream.
 */
function readZipEntry(buffer, wantedName) {
  // EOCD signature 0x06054b50, within the last 64KB (max comment length).
  let eocd = -1;
  const from = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badRequest('That file is not a readable .docx.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break; // central header signature
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === wantedName) {
      // The local header's own name/extra lengths give the data start.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data; // stored
      if (method === 8) return inflateRawSync(data); // deflate
      throw badRequest('That .docx uses an unsupported compression method.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw badRequest('That file is not a readable .docx.');
}

/**
 * WordprocessingML to plain text. Paragraphs and breaks become newlines, tabs
 * become tabs, everything else is discarded — we want the words, not the
 * formatting, and the model is given this as reference material.
 */
function docxToText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ───────────────────────── PDF ─────────────────────────

const { resolve } = require('node:path');

/**
 * Delegates to the repo's own `resume-pdf.js`.
 *
 * That module already strips pdf-parse's "-- 1 of 2 --" page markers, collapses
 * the scattered whitespace a text layer produces, names the password-protected
 * case specifically, and detects a scan with no text layer — all covered by the
 * root project's tests. Reimplementing it here would mean a second, worse copy.
 */
async function pdfToText(buffer) {
  const { extractResumeText } = require(resolve(__dirname, '../../../resume-pdf.js'));
  try {
    return await extractResumeText(buffer);
  } catch (err) {
    // Its messages are already written for a person to read.
    throw badRequest(err.message);
  }
}

// ───────────────────────── entry point ─────────────────────────

/**
 * Decodes a base64 upload and returns its text.
 *
 * Base64-in-JSON rather than multipart: it avoids a body-parser dependency for
 * a single upload endpoint, and a résumé is small. The size cap is applied to
 * the decoded bytes, not the encoded string.
 */
async function extractText({ filename, mimeType, dataBase64 }) {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (buffer.length === 0) throw badRequest('That file appears to be empty.');
  if (buffer.length > MAX_BYTES) {
    throw badRequest(`That file is ${(buffer.length / 1048576).toFixed(1)} MB. The limit is 8 MB.`);
  }

  const kind = kindOf(filename, mimeType);
  if (!kind) throw badRequest('Upload a PDF, a Word .docx, or a plain text file.');

  let text;
  let pages = 1;
  if (kind === 'pdf') {
    ({ text, pages } = await pdfToText(buffer));
  } else if (kind === 'docx') {
    text = docxToText(buffer);
  } else {
    text = buffer.toString('utf8').replace(/\r/g, '').trim();
  }

  // resume-pdf.js already enforces a minimum for PDFs, with a better message
  // that distinguishes a scan from an empty file.
  if (kind !== 'pdf' && text.length < 40) {
    throw badRequest('That file did not contain enough text to work with.');
  }

  return { text, kind, pages, sizeBytes: buffer.length, buffer };
}

module.exports = { extractText, kindOf, docxToText, readZipEntry, MAX_BYTES };
