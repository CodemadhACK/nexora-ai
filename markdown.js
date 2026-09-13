/**
 * Model output → HTML, and the section structure the answer UI is built on.
 *
 * Two jobs, kept together because the second depends on the first: turn a
 * model's markdown into safe HTML, then group that HTML into the sections an
 * answer is actually made of, tagged by whether they are words you say out
 * loud or reference you glance at.
 *
 * The grouping is what lets the stylesheet tell a spoken section from a
 * reference one, and lets a reference section fold away. A coding answer
 * arrives with nine headings; rendered flat they all look alike, so mid
 * interview you scroll past eight blocks looking for the sentence you are
 * meant to be reading.
 *
 * Nothing here touches the DOM, so the escaping rules and the section split
 * are testable without a browser.
 *
 * Loaded both as a plain script in the renderer (window.NexoraMarkdown) and
 * with require() in the tests, the same way voice-turn.js is.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexoraMarkdown = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The sections you say out loud, exactly as the formats in prompts.js name
   * them. Everything else in an answer is reference material.
   */
  const SPOKEN = new Set(['ask first', 'interview explanation', 'say this']);

  // Below this an answer already fits the window, so folding it would only be
  // a click in the way.
  const FOLD_OVER_CHARS = 1200;
  const FOLD_OVER_SECTIONS = 3;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Wrap each "### Heading" and the content under it in a section, tagged
   * speak or ref.
   *
   * An answer with no headings is a chat reply and is returned untouched:
   * wrapping it would put a template around a reply whose whole point is not
   * having one.
   */
  function groupSections(html) {
    const parts = html.split(/(<h3>[\s\S]*?<\/h3>)/);
    if (parts.length < 3) return html;

    let out = parts[0];
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i];
      const body = parts[i + 1] || '';
      const name = heading.replace(/<[^>]+>/g, '').trim().toLowerCase();
      const kind = SPOKEN.has(name) ? 'speak' : 'ref';
      out += `<section class="sec ${kind}">${heading}<div class="sec-body">${body}</div></section>`;
    }
    return out;
  }

  /**
   * Whether a finished answer should open with its reference sections folded.
   *
   * A coding answer runs past 3000 characters against a window a few hundred
   * pixels tall. Expanded, the words you are meant to say scroll off the top
   * while you are still reading them; folded, you see what to say and a list
   * of what else is there.
   */
  function shouldFoldReference(text, refCount) {
    return String(text || '').length >= FOLD_OVER_CHARS && refCount >= FOLD_OVER_SECTIONS;
  }

  /**
   * Minimal, dependency-free markdown → HTML. Model output is escaped before
   * any of it is treated as markup, so a response cannot inject HTML.
   *
   * Fenced blocks are lifted out first and parked behind NUL sentinels — a
   * character that cannot occur in model output — then restored at the end, so
   * the inline rules never run over code.
   */
  function renderMarkdown(src) {
    const NUL = String.fromCharCode(0);
    const blocks = [];

    let text = String(src).replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
      const i = blocks.length;
      blocks.push(
        `<div class="code-block"><button class="copy" type="button">Copy</button>` +
        `<pre data-lang="${escapeHtml(lang || '')}"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`
      );
      return `${NUL}BLOCK${i}${NUL}`;
    });

    text = escapeHtml(text);

    text = text.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-external="1">$1</a>');
    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
               .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
               .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    const lines = text.split('\n');
    let html = '', list = null, para = [];
    const flushPara = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };

    const blockLine = new RegExp(`^${NUL}BLOCK\\d+${NUL}$`);

    for (const line of lines) {
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { flushList(); html += `<${want}>`; list = want; }
        html += `<li>${(ul || ol)[1]}</li>`;
      } else if (/^<h[123]>/.test(line) || blockLine.test(line)) {
        flushPara(); flushList(); html += line;
      } else if (line.trim() === '') {
        flushPara(); flushList();
      } else {
        para.push(line);
      }
    }
    flushPara(); flushList();

    html = groupSections(html);

    return html.replace(new RegExp(`${NUL}BLOCK(\\d+)${NUL}`, 'g'), (_m, i) => blocks[Number(i)]);
  }

  return {
    SPOKEN, FOLD_OVER_CHARS, FOLD_OVER_SECTIONS,
    escapeHtml, renderMarkdown, groupSections, shouldFoldReference
  };
}));
