// "What's new" changelog: parsing, safe markdown rendering, and the
// which-entries-has-this-visitor-not-seen-yet logic behind the popup (see
// setupChangelogModal in input.js). Kept free of DOM/localStorage access so
// it can be unit-tested in plain Node.
//
// changelog.md is a list of `## ` sections, newest first. A section's
// heading is its identity: the browser remembers the headings it has shown
// (localStorage 'changelog-seen'), so only a NEW heading triggers the popup.

// Splits changelog.md into [{ heading, body }] in file order. Anything
// before the first `## ` (title, instructions comment) is ignored.
export function parseChangelog(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { heading: m[1], body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  const seen = new Set();
  return sections
    .map(s => ({ heading: s.heading, body: s.body.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim() }))
    // A duplicated heading would make the second entry invisible forever
    // (its ID is already "seen"), so keep only the first of each.
    .filter(s => !seen.has(s.heading) && seen.add(s.heading));
}

// Sections whose headings aren't in `seenHeadings`, newest first (file order).
export function unseenSections(sections, seenHeadings) {
  const seen = new Set(seenHeadings);
  return sections.filter(s => !seen.has(s.heading));
}

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Inline markdown on already-escaped text. Link targets are limited to
// http(s)/relative URLs, so a changelog can't smuggle in javascript: links.
function renderInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return whole;
      const external = /^https?:/i.test(url);
      return `<a href="${url}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
    });
}

// Minimal markdown -> HTML: paragraphs, bullet lists, bold/italic/code/links.
// Everything is HTML-escaped first, so entries can't inject markup.
export function renderMarkdown(markdown) {
  const html = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) html.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) html.push(`<ul>${list.join('')}</ul>`); list = null; };
  for (const raw of markdown.split('\n')) {
    const line = escapeHtml(raw.trimEnd());
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      (list ??= []).push(`<li>${renderInline(bullet[1])}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else if (list && /^\s+\S/.test(line)) {
      // Indented continuation of the previous bullet.
      list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, ` ${renderInline(line.trim())}</li>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return html.join('');
}
