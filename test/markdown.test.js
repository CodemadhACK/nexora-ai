'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../markdown');

const headings = (html) => [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
const sections = (html) => [...html.matchAll(/<section class="sec (speak|ref)">/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Escaping — model output is never markup
// ---------------------------------------------------------------------------

test('a model cannot inject HTML through an answer', () => {
  const html = md.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), 'raw tag survived into the document');
  assert.ok(html.includes('&lt;img'));
});

test('code inside a fence is escaped, not executed', () => {
  const html = md.renderMarkdown('```python\nprint("<b>hi</b>")\n```');
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'));
  assert.ok(!html.includes('<b>hi</b>'));
});

test('the inline rules never run over code', () => {
  // Underscores and asterisks are ordinary characters in source code.
  const html = md.renderMarkdown('```python\na = b**2\n```');
  assert.ok(html.includes('b**2'), 'a code block was treated as markdown');
  assert.ok(!html.includes('<strong>'));
});

// ---------------------------------------------------------------------------
// Sections — the structure the answer UI is built on
// ---------------------------------------------------------------------------

test('a chat reply with no headings is left exactly as it is', () => {
  // The whole point of a chat answer is that it carries no template. Wrapping
  // it in a section would put one back.
  const html = md.renderMarkdown('Hi there, happy to start wherever you like.');
  assert.ok(!html.includes('<section'), 'a greeting was given a section wrapper');
});

test('the sections you say out loud are marked apart from the rest', () => {
  const answer = [
    '### Ask first', '- Is the array sorted?',
    '### Interview explanation', 'We use a hash map in one pass.',
    '### Code', '```python\nx = 1\n```',
    '### Complexity', 'O(n) time.',
  ].join('\n');

  const html = md.renderMarkdown(answer);
  assert.deepEqual(sections(html), ['speak', 'speak', 'ref', 'ref']);
  assert.deepEqual(headings(html), ['Ask first', 'Interview explanation', 'Code', 'Complexity']);
});

test('a behavioural answer leads with the words to say', () => {
  const html = md.renderMarkdown('### Say this\nAt Bank of America I owned the migration.\n### STAR\nSituation...');
  assert.deepEqual(sections(html), ['speak', 'ref']);
});

test('every section keeps its content with it', () => {
  const html = md.renderMarkdown('### Complexity\nO(n) time.\n### Fix\nRewrite it iteratively.');
  const complexity = /<section class="sec ref"><h3>Complexity<\/h3><div class="sec-body">(.*?)<\/div><\/section>/.exec(html);
  assert.ok(complexity, 'the Complexity section did not close before the next one');
  assert.ok(complexity[1].includes('O(n) time.'));
  assert.ok(!complexity[1].includes('Rewrite it iteratively'), 'a section swallowed the one after it');
});

test('a code block survives being grouped into a section', () => {
  const html = md.renderMarkdown('### Code\n```python\nreturn seen\n```');
  assert.ok(html.includes('class="code-block"'));
  assert.ok(html.includes('return seen'));
});

test('heading matching does not care about the case the model used', () => {
  const html = md.renderMarkdown('### INTERVIEW EXPLANATION\nSaid out loud.');
  assert.deepEqual(sections(html), ['speak']);
});

// ---------------------------------------------------------------------------
// Folding — what opens collapsed, and what does not
// ---------------------------------------------------------------------------

test('a short answer is never folded, however many sections it has', () => {
  // Folding here would put a click between the user and an answer that already
  // fits on screen.
  assert.equal(md.shouldFoldReference('x'.repeat(300), 5), false);
});

test('an answer with barely any reference sections is not folded', () => {
  assert.equal(md.shouldFoldReference('x'.repeat(5000), 2), false);
});

test('a long answer with several reference sections opens folded', () => {
  // The case this exists for: a coding answer, nine headings, a window a few
  // hundred pixels tall.
  assert.equal(md.shouldFoldReference('x'.repeat(3173), 7), true);
});

test('folding is decided on the answer, not on a missing one', () => {
  assert.equal(md.shouldFoldReference(null, 9), false);
  assert.equal(md.shouldFoldReference(undefined, 9), false);
});

// ---------------------------------------------------------------------------
// The spoken set is the contract with prompts.js
// ---------------------------------------------------------------------------

test('the spoken headings are the ones the formats actually emit', () => {
  // If a format in prompts.js renames one of these, the section stops being
  // highlighted and the regression is silent on screen. This is the guard.
  const prompts = require('../prompts');
  const emitted = new Set();
  for (const body of Object.values(prompts.FORMATS)) {
    for (const m of String(body).matchAll(/^###\s+(.+)$/gm)) emitted.add(m[1].trim().toLowerCase());
  }
  for (const spoken of md.SPOKEN) {
    assert.ok(emitted.has(spoken), `nothing in prompts.js emits "${spoken}" any more`);
  }
});
