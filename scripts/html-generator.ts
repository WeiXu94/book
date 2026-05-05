import * as cheerio from 'cheerio';
import * as path from 'path';
import type { PageEntry } from './types.js';

// ── Reading-time estimation ───────────────────────────────────────────────────

export function estimateReadingTime(plainText: string): number {
  const cjk = (plainText.match(/[一-鿿぀-ゟ゠-ヿ]/g) ?? []).length;
  const nonCjkWords = plainText
    .replace(/[一-鿿぀-ゟ゠-ヿ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  // CJK: ~400 chars/min  English: ~250 words/min
  return Math.max(1, Math.ceil(cjk / 400 + nonCjkWords / 250));
}

// ── Chapter HTML cleaning ─────────────────────────────────────────────────────

export function cleanChapterHtml(rawHtml: string): string {
  const $ = cheerio.load(rawHtml, { xmlMode: false });

  // Remove non-content elements
  $('img, figure, figcaption, script, style, link, meta').remove();

  // Strip all styling/class attributes
  $('*').each((_, el) => {
    const $el = $(el);
    ['style', 'class', 'id', 'color', 'bgcolor', 'align', 'valign',
      'width', 'height', 'border', 'cellpadding', 'cellspacing'].forEach((a) => $el.removeAttr(a));
  });

  // Convert internal epub links to plain spans (they won't resolve on GH Pages)
  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    if (href.startsWith('http') || href.startsWith('//')) return;
    $el.replaceWith($el.html() ?? '');
  });

  // Unwrap meaningless containers that only introduce layout noise
  $('div, section, article').each((_, el) => {
    const $el = $(el);
    if ($el.children().length === 1 && $el.children().first().is('p, h1, h2, h3')) {
      $el.replaceWith($el.html() ?? '');
    }
  });

  const body = $('body');
  return (body.length ? body.html() : $.html()) ?? '';
}

// ── Paragraph-aware splitting ─────────────────────────────────────────────────

/**
 * Extract plain-text paragraphs for LLM context.
 */
export function extractParagraphs(html: string): string[] {
  const $ = cheerio.load(html);
  const result: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) result.push(text);
  });
  return result;
}

/**
 * Split HTML at the paragraph boundary closest to `targetCharCount` plain-text characters.
 * Returns [part1Html, part2Html].
 */
export function splitHtmlAtCharCount(html: string, targetChars: number): [string, string] {
  // Track plain-text character count while scanning HTML
  let chars = 0;
  let i = 0;
  let lastPEnd = 0; // position after last </p> seen before reaching target
  let splitPos = -1;

  while (i < html.length) {
    if (html[i] === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      const tag = html.slice(i, gt + 1);
      // Detect closing </p>
      if (/^<\/p\s*>/i.test(tag)) {
        if (chars >= targetChars && splitPos === -1) {
          splitPos = gt + 1;
          break;
        }
        lastPEnd = gt + 1;
      }
      i = gt + 1;
    } else {
      chars++;
      i++;
    }
  }

  const cut = splitPos !== -1 ? splitPos : lastPEnd;
  if (cut <= 0) return [html, ''];

  const part1 = html.slice(0, cut);
  const part2 = html.slice(cut).replace(/^\s*/, '');
  return [part1, part2];
}

// ── Page generation ───────────────────────────────────────────────────────────

export interface ChapterPageData {
  bookTitle: string;
  chapterTitle: string;
  partIndex: number;
  totalParts: number;
  estimatedMinutes: number;
  summary: string;
  contentHtml: string;
  prevPage: PageEntry | undefined;
  nextPage: PageEntry | undefined;
}

export function generateChapterPage(data: ChapterPageData): string {
  const { bookTitle, chapterTitle, partIndex, totalParts, estimatedMinutes, summary, contentHtml } = data;

  const partLabel =
    totalParts > 1 ? `第 ${partIndex} 部分，共 ${totalParts} 部分 · ` : '';
  const readLabel = `${estimatedMinutes} 分钟`;

  const prevLink = data.prevPage
    ? `<a href="${path.posix.basename(data.prevPage.file)}" class="nav-btn">← 上一篇</a>`
    : `<span class="nav-btn nav-btn--disabled">← 上一篇</span>`;

  const nextLink = data.nextPage
    ? `<a href="${path.posix.basename(data.nextPage.file)}" class="nav-btn">下一篇 →</a>`
    : `<span class="nav-btn nav-btn--disabled">下一篇 →</span>`;

  const summaryBlock = summary
    ? `<div class="summary-box" role="note">
        <p class="summary-label">本章摘要</p>
        <p class="summary-text">${esc(summary)}</p>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(chapterTitle)}${totalParts > 1 ? ` (${partIndex}/${totalParts})` : ''} — ${esc(bookTitle)}</title>
  <style>${CSS}</style>
</head>
<body>

<div class="reading-progress"><div class="progress-bar" id="pb"></div></div>

<header class="site-header">
  <div class="header-inner">
    <a href="../index.html" class="home-link" title="返回目录">☰ 目录</a>
    <span class="header-book">${esc(bookTitle)}</span>
    <span class="header-time">${partLabel}${readLabel}</span>
  </div>
</header>

<main class="reader">
  <header class="chapter-header">
    <h1>${esc(chapterTitle)}</h1>
  </header>

  ${summaryBlock}

  <article class="chapter-content">
    ${contentHtml}
  </article>
</main>

<footer class="site-footer">
  <nav class="footer-nav">
    ${prevLink}
    <a href="../index.html" class="nav-btn nav-btn--center">目录</a>
    ${nextLink}
  </nav>
</footer>

<script>
  const pb = document.getElementById('pb');
  function updateProgress() {
    const pct = window.scrollY / (document.body.scrollHeight - window.innerHeight) * 100;
    pb.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();
</script>

</body>
</html>`;
}

// ── Index page ────────────────────────────────────────────────────────────────

export interface IndexBook {
  title: string;
  author: string;
  finished: boolean;
  totalChapters: number;
  pages: PageEntry[];
}

export function generateIndexPage(books: IndexBook[], latestPage: PageEntry | undefined): string {
  const activeBooks = books.filter((b) => !b.finished);
  const archivedBooks = books.filter((b) => b.finished);

  // ── Hero: Continue Reading ──
  const heroHtml = latestPage
    ? (() => {
        const partNote =
          latestPage.totalParts > 1
            ? `第 ${latestPage.partIndex}/${latestPage.totalParts} 部分 · `
            : '';
        return `<div class="hero">
  <div class="hero-inner">
    <p class="hero-eyebrow">继续阅读</p>
    <h2 class="hero-title">${esc(latestPage.chapterTitle)}</h2>
    <p class="hero-book">${esc(latestPage.bookTitle)}</p>
    <p class="hero-meta">${partNote}${latestPage.estimatedMinutes} 分钟</p>
    ${latestPage.summary ? `<p class="hero-summary">${esc(latestPage.summary)}</p>` : ''}
    <a href="${latestPage.file}" class="hero-cta">开始阅读 →</a>
  </div>
</div>`;
      })()
    : '';

  // ── Book section renderer ──
  const renderBook = (book: IndexBook): string => {
    const chapterItems = book.pages
      .map((page) => {
        const partNote =
          page.totalParts > 1
            ? ` <span class="part-note">第${page.partIndex}/${page.totalParts}部分</span>`
            : '';
        const dateStr = new Date(page.parsedAt).toLocaleDateString('zh-CN', {
          year: 'numeric', month: 'long', day: 'numeric',
        });
        return `<li class="chapter-item">
          <a class="chapter-link" href="${page.file}">${esc(page.chapterTitle)}${partNote}</a>
          <span class="chapter-meta">${page.estimatedMinutes} 分钟 · ${dateStr}</span>
          ${page.summary ? `<p class="chapter-summary">${esc(page.summary)}</p>` : ''}
        </li>`;
      })
      .join('\n');

    const progress =
      book.totalChapters > 0
        ? ` <span class="book-progress">${book.pages.length} / ${book.totalChapters} 章</span>`
        : '';

    return `<section class="book-section">
      <div class="book-header">
        <div class="book-header-row">
          <h2 class="book-title">${esc(book.title)}${book.finished ? ' <span class="finished-badge">已读完</span>' : ''}</h2>
          ${progress}
        </div>
        <p class="book-author">${esc(book.author)}</p>
      </div>
      <ol class="chapter-list">
        ${chapterItems}
      </ol>
    </section>`;
  };

  // ── Tab panels ──
  const readingCount = activeBooks.reduce((n, b) => n + b.pages.length, 0);
  const archiveCount = archivedBooks.length;

  const readingPanel = activeBooks.length > 0
    ? activeBooks.map(renderBook).join('\n')
    : `<div class="empty-state">
        <p>正在读的书都已读完，或者还没有开始解析。</p>
        <p>把 <code>.epub</code> 文件放入 <code>books/</code>，然后运行 <code>npm run parse</code>。</p>
      </div>`;

  const archivePanel = archivedBooks.length > 0
    ? archivedBooks.map(renderBook).join('\n')
    : `<div class="empty-state"><p>还没有读完的书。</p></div>`;

  const noContent = books.length === 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>书架</title>
  <style>${INDEX_CSS}</style>
</head>
<body>

<header class="site-header">
  <div class="header-inner">
    <h1 class="site-title">📚 书架</h1>
  </div>
</header>

${noContent ? `<main class="main"><div class="empty-state empty-state--full">
  <p>还没有任何章节。</p>
  <p>把 <code>.epub</code> 文件放入 <code>books/</code> 目录，然后运行 <code>npm run parse</code>。</p>
</div></main>` : `
${heroHtml}

<div class="tabs-bar">
  <div class="tabs-inner">
    <button class="tab active" data-tab="reading">正在读${readingCount > 0 ? ` (${readingCount})` : ''}</button>
    <button class="tab" data-tab="archive">已读完${archiveCount > 0 ? ` (${archiveCount})` : ''}</button>
  </div>
</div>

<main class="main">
  <div id="tab-reading" class="tab-panel">
    ${readingPanel}
  </div>
  <div id="tab-archive" class="tab-panel hidden">
    ${archivePanel}
  </div>
</main>
`}

<footer class="site-footer">
  <p>由 <a href="https://github.com/weixu94/book">book-reader</a> 生成</p>
</footer>

<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.tab-panel');
  function activate(name) {
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    panels.forEach(function (p) { p.classList.toggle('hidden', p.id !== 'tab-' + name); });
    history.replaceState(null, '', location.pathname + '#' + name);
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { activate(t.dataset.tab); }); });
  var hash = location.hash.slice(1);
  if (hash === 'archive') activate('archive');
})();
</script>

</body>
</html>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FLEXOKI = `
  --bg:    #FFFCF0;
  --bg-2:  #F2F0E5;
  --ui:    #E6E4D9;
  --ui-2:  #DAD8CE;
  --ui-3:  #CECDC3;
  --tx-3:  #B7B5AC;
  --tx-2:  #6F6E69;
  --tx:    #100F0F;
  --blue:  #205EA6;
  --cyan:  #24837B;
  --green: #66800B;
  --red:   #AF3029;
`;

const CSS = `
:root { ${FLEXOKI} }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--tx);
  font-family: Georgia, 'Songti SC', STSong, SimSun, 'Noto Serif CJK SC', serif;
  font-size: 19px;
  line-height: 1.85;
  min-height: 100vh;
}

/* ── Progress bar ── */
.reading-progress {
  position: fixed; top: 0; left: 0; right: 0;
  height: 3px; background: var(--ui); z-index: 300;
}
.progress-bar { height: 100%; width: 0; background: var(--cyan); transition: width .1s linear; }

/* ── Header ── */
.site-header {
  position: sticky; top: 3px;
  background: var(--bg-2); border-bottom: 1px solid var(--ui);
  padding: .55rem 1.5rem; z-index: 200;
}
.header-inner {
  max-width: 72ch; margin: 0 auto;
  display: flex; align-items: center; gap: 1rem;
}
.home-link { font-size: .85rem; color: var(--blue); text-decoration: none; white-space: nowrap; }
.home-link:hover { text-decoration: underline; }
.header-book { flex: 1; font-size: .85rem; color: var(--tx-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-time { font-size: .8rem; color: var(--tx-3); white-space: nowrap; }

/* ── Reader area ── */
.reader {
  max-width: 72ch; margin: 0 auto;
  padding: 3rem 1.5rem 5rem;
}

/* ── Chapter header ── */
.chapter-header { margin-bottom: 2rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--ui); }
.chapter-header h1 { font-size: 1.7rem; line-height: 1.3; font-weight: 700; }

/* ── Summary box ── */
.summary-box {
  background: var(--bg-2); border: 1px solid var(--ui);
  border-left: 3px solid var(--cyan); border-radius: 4px;
  padding: 1.1rem 1.4rem; margin-bottom: 2.5rem;
}
.summary-label {
  font-family: system-ui, sans-serif; font-size: .72rem;
  font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--cyan); margin-bottom: .6rem;
}
.summary-text { font-size: .95rem; line-height: 1.75; color: var(--tx-2); }

/* ── Chapter content ── */
.chapter-content p {
  margin-bottom: 1.4em;
  text-indent: 2em;
}
.chapter-content p:first-of-type { text-indent: 0; }

/* Drop cap on first paragraph */
.chapter-content > p:first-of-type::first-letter {
  float: left; font-size: 3.4em; line-height: .85;
  margin-right: .1em; margin-top: .06em;
  color: var(--tx-2); font-weight: 700;
}

.chapter-content h1,
.chapter-content h2,
.chapter-content h3,
.chapter-content h4 {
  font-size: 1.15rem; font-weight: 700;
  margin: 2em 0 .7em; color: var(--tx); text-indent: 0;
}
.chapter-content em { font-style: italic; }
.chapter-content strong { font-weight: 700; }
.chapter-content a { color: var(--blue); text-decoration: underline; }
.chapter-content hr { border: none; border-top: 1px solid var(--ui); margin: 2rem 0; }

/* ── Footer ── */
.site-footer { border-top: 1px solid var(--ui); background: var(--bg-2); padding: 1.25rem 1.5rem; }
.footer-nav {
  max-width: 72ch; margin: 0 auto;
  display: flex; justify-content: space-between; align-items: center; gap: .75rem;
}
.nav-btn {
  font-family: system-ui, sans-serif; font-size: .85rem;
  color: var(--blue); text-decoration: none;
  padding: .4rem .8rem; border: 1px solid var(--ui); border-radius: 4px;
  background: var(--bg); transition: background .1s;
}
.nav-btn:hover { background: var(--ui); }
.nav-btn--disabled { color: var(--tx-3); pointer-events: none; }
.nav-btn--center { color: var(--tx-2); }

/* ── Responsive ── */
@media (max-width: 600px) {
  body { font-size: 17px; }
  .reader { padding: 1.5rem 1rem 3rem; }
  .chapter-header h1 { font-size: 1.35rem; }
  .footer-nav { flex-wrap: wrap; justify-content: center; }
}
`;

const INDEX_CSS = `
:root { ${FLEXOKI} }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg); color: var(--tx);
  font-family: system-ui, 'PingFang SC', 'Hiragino Sans GB', sans-serif;
  min-height: 100vh; line-height: 1.6;
}

/* ── Header ── */
.site-header { background: var(--bg-2); border-bottom: 1px solid var(--ui); padding: 1rem 1.5rem; }
.header-inner { max-width: 80ch; margin: 0 auto; }
.site-title { font-size: 1.4rem; font-weight: 700; }

/* ── Hero: Continue Reading ── */
.hero {
  background: var(--bg-2); border-bottom: 1px solid var(--ui);
  padding: 2.5rem 1.5rem 2.75rem;
}
.hero-inner {
  max-width: 80ch; margin: 0 auto;
}
.hero-eyebrow {
  font-size: .75rem; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
  color: var(--cyan); margin-bottom: .6rem;
}
.hero-title {
  font-family: Georgia, 'Songti SC', serif;
  font-size: 1.65rem; font-weight: 700; line-height: 1.3;
  color: var(--tx); margin-bottom: .35rem;
}
.hero-book { font-size: .95rem; color: var(--tx-2); margin-bottom: .2rem; }
.hero-meta { font-size: .82rem; color: var(--tx-3); margin-bottom: .9rem; }
.hero-summary {
  font-size: .9rem; color: var(--tx-2); line-height: 1.7;
  max-width: 60ch; margin-bottom: 1.25rem;
  border-left: 2px solid var(--ui-2); padding-left: .9rem;
}
.hero-cta {
  display: inline-block;
  background: var(--cyan); color: var(--bg);
  font-weight: 600; font-size: .95rem;
  padding: .55rem 1.4rem; border-radius: 5px;
  text-decoration: none; transition: opacity .15s;
}
.hero-cta:hover { opacity: .88; }

/* ── Tabs ── */
.tabs-bar {
  background: var(--bg-2); border-bottom: 1px solid var(--ui);
  padding: 0 1.5rem; position: sticky; top: 0; z-index: 100;
}
.tabs-inner { max-width: 80ch; margin: 0 auto; display: flex; gap: 0; }
.tab {
  background: none; border: none; cursor: pointer;
  font-family: inherit; font-size: .9rem; font-weight: 500;
  color: var(--tx-2); padding: .75rem 1.1rem;
  border-bottom: 2px solid transparent; transition: color .1s, border-color .1s;
}
.tab:hover { color: var(--tx); }
.tab.active { color: var(--cyan); border-bottom-color: var(--cyan); font-weight: 600; }

/* ── Tab panels ── */
.hidden { display: none !important; }
.main { max-width: 80ch; margin: 0 auto; padding: 2rem 1.5rem 5rem; }

/* ── Empty state ── */
.empty-state {
  text-align: center; padding: 3rem 0; color: var(--tx-2);
  font-size: .95rem; line-height: 2.2;
}
.empty-state--full { padding: 5rem 0; }
.empty-state code { background: var(--ui); padding: .15em .4em; border-radius: 3px; font-family: monospace; font-size: .9em; }

/* ── Book sections ── */
.book-section { margin-bottom: 3rem; }
.book-header { margin-bottom: 1.1rem; padding-bottom: .9rem; border-bottom: 2px solid var(--ui); }
.book-header-row { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; margin-bottom: .15rem; }
.book-title { font-size: 1.2rem; font-weight: 700; }
.book-progress { font-size: .8rem; color: var(--tx-3); white-space: nowrap; }
.book-author { font-size: .875rem; color: var(--tx-2); }

.finished-badge {
  font-size: .7rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
  background: var(--green); color: var(--bg);
  padding: .15em .5em; border-radius: 3px; vertical-align: middle; margin-left: .4em;
}

/* ── Chapter list ── */
.chapter-list { list-style: none; display: flex; flex-direction: column; gap: .75rem; }
.chapter-item {
  background: var(--bg-2); border: 1px solid var(--ui); border-radius: 6px;
  padding: .9rem 1.1rem; transition: border-color .15s, box-shadow .15s;
}
.chapter-item:hover { border-color: var(--ui-3); box-shadow: 0 2px 8px rgba(16,15,15,.06); }
.chapter-link {
  display: block; font-size: .975rem; font-weight: 600;
  color: var(--blue); text-decoration: none; margin-bottom: .25rem;
}
.chapter-link:hover { text-decoration: underline; }
.part-note {
  font-size: .75rem; font-weight: 400; color: var(--tx-3);
  background: var(--ui); border-radius: 3px;
  padding: .1em .4em; margin-left: .35em; vertical-align: middle;
}
.chapter-meta { display: block; font-size: .78rem; color: var(--tx-3); margin-bottom: .35rem; }
.chapter-summary { font-size: .86rem; color: var(--tx-2); line-height: 1.65; }

/* ── Footer ── */
.site-footer {
  border-top: 1px solid var(--ui); background: var(--bg-2);
  padding: 1rem 1.5rem; text-align: center;
  font-size: .78rem; color: var(--tx-3);
}
.site-footer a { color: var(--tx-2); }

@media (max-width: 600px) {
  .hero { padding: 1.75rem 1rem 2rem; }
  .hero-title { font-size: 1.35rem; }
  .main { padding: 1.5rem 1rem 3rem; }
  .tabs-bar { padding: 0 .75rem; }
}
`;
