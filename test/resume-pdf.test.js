'use strict';

/**
 * The importer used to refuse a PDF and tell people to open it, select all and
 * paste — for the one document every candidate already has. These cover the
 * extraction itself and, more importantly, the two ways a résumé PDF disappoints
 * you: it is a scan with no text in it, or it is locked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractResumeText, tidy, MIN_USABLE_CHARS } = require('../resume-pdf');

const FIXTURE = path.join(__dirname, 'fixtures', 'resume-sample.pdf');
const bytes = () => new Uint8Array(fs.readFileSync(FIXTURE));

// ---------------------------------------------------------------------------
// The real parser, against a real PDF
// ---------------------------------------------------------------------------

test('a real PDF gives up its text', async () => {
  const { text, pages } = await extractResumeText(bytes());

  assert.match(text, /Alex Morgan/);
  assert.match(text, /Staff Engineer at Example Corp/);
  assert.equal(pages, 1);
});

test('page markers do not reach the profile', async () => {
  // pdf-parse writes "-- 1 of 2 --" between pages. In a résumé fed to a model
  // that is noise at best, and at worst it reads as content.
  const { text } = await extractResumeText(bytes());
  assert.equal(/--\s*\d+\s+of\s+\d+\s*--/.test(text), false);
});

test('the character limit is honoured, because the profile has one', async () => {
  const { text } = await extractResumeText(bytes(), { limit: 12 });
  assert.equal(text.length, 12);
});

// ---------------------------------------------------------------------------
// Failures worth naming
// ---------------------------------------------------------------------------

test('a scanned résumé is called a scan, not saved as an empty profile', async () => {
  // A photo saved as a PDF parses perfectly and yields nothing. Storing that
  // silently leaves someone with a profile that answers no question about them.
  await assert.rejects(
    extractResumeText(bytes(), { parse: async () => ({ text: '   \n  \n', total: 3 }) }),
    (err) => {
      assert.match(err.message, /no text in it/i);
      assert.match(err.message, /scan or a photo/i);
      return true;
    }
  );
});

test('a locked PDF is named as locked, since the fix is different', async () => {
  await assert.rejects(
    extractResumeText(bytes(), { parse: async () => { throw new Error('No password given (PasswordException)'); } }),
    (err) => {
      assert.match(err.message, /password protected/i);
      return true;
    }
  );
});

test('any other parser failure still reaches the user as a sentence', async () => {
  await assert.rejects(
    extractResumeText(bytes(), { parse: async () => { throw new Error('bad XRef entry'); } }),
    (err) => {
      assert.match(err.message, /Could not read that PDF: bad XRef entry/);
      return true;
    }
  );
});

test('an empty file is rejected before a parser is even loaded', async () => {
  let called = false;
  await assert.rejects(
    extractResumeText(new Uint8Array(0), { parse: async () => { called = true; return { text: 'x' }; } }),
    /empty/i
  );
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Tidying
// ---------------------------------------------------------------------------

test('the scattered whitespace of a text layer is collapsed', () => {
  // Columns, table cells and letter-spaced headings all arrive as loose spaces.
  // A résumé that reaches the model one word per line reads as nonsense.
  assert.equal(tidy('Senior    Engineer\r\n\n\n\n  Example   Corp  '), 'Senior Engineer\n\nExample Corp');
});

test('blank input tidies to nothing rather than throwing', () => {
  assert.equal(tidy(null), '');
  assert.equal(tidy(undefined), '');
});

test('the usable-text floor is low enough for a terse résumé', () => {
  // Someone with a genuinely short one-page CV must not be told it is a scan.
  assert.ok(MIN_USABLE_CHARS <= 80, 'a real but brief résumé should still pass');
});
