/**
 * parse.ts — Parse the next unparsed EPUB chapter and publish it to docs/.
 *
 * Usage:
 *   npm run parse
 *
 * Prerequisites:
 *   - Set ANTHROPIC_API_KEY in your environment (or .env file).
 *   - Drop one or more .epub files into the books/ directory.
 *
 * Each run parses exactly ONE chapter (or adds a new book to state).
 * Re-run every two days, or whenever you want the next chapter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { openEpub } from './epub-parser.js';
import { summarizeChapter, findNarrativeSplitPoint } from './llm.js';
import {
  cleanChapterHtml,
  estimateReadingTime,
  extractParagraphs,
  splitHtmlAtCharCount,
  generateChapterPage,
  generateIndexPage,
  type IndexBook,
} from './html-generator.js';
import type { BookState, BookEntry, ChapterEntry, PartEntry, PageEntry } from './types.js';

// ── Paths ──────────────────────────────────────────────────────────────────────

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BOOKS_DIR = path.join(ROOT, 'books');
const DOCS_DIR = path.join(ROOT, 'docs');
const CHAPTERS_DIR = path.join(DOCS_DIR, 'chapters');
const STATE_FILE = path.join(ROOT, 'state.json');

// If estimated reading time exceeds this, split the chapter.
const SPLIT_THRESHOLD_MINUTES = 32;

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState(): BookState {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as BookState;
  }
  return { version: 1, pages: [], books: {} };
}

function saveState(state: BookState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Index regeneration ────────────────────────────────────────────────────────

function rebuildIndex(state: BookState): void {
  const books: IndexBook[] = Object.values(state.books).map((book) => {
    const pages = state.pages.filter((p) => p.bookFilename === book.filename);
    return {
      title: book.title,
      author: book.author,
      finished: book.finished ?? false,
      totalChapters: book.totalChapters ?? 0,
      pages,
    };
  });

  const latestPage = state.pages.length > 0 ? state.pages[state.pages.length - 1] : undefined;
  const html = generateIndexPage(books, latestPage);
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html, 'utf8');
  console.log('  ↳ Rebuilt docs/index.html');
}

// ── File-name sanitizer ───────────────────────────────────────────────────────

function slug(s: string, maxLen = 40): string {
  return s
    .replace(/[^\w一-鿿぀-ゟ゠-ヿ-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen)
    .toLowerCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure required directories exist
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  fs.mkdirSync(CHAPTERS_DIR, { recursive: true });

  // Check for ANTHROPIC_API_KEY early
  if (!process.env['ANTHROPIC_API_KEY']) {
    // Try .env file
    const envFile = path.join(ROOT, '.env');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const [k, ...v] = line.split('=');
        if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
      }
    }
  }
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error(
      '❌  ANTHROPIC_API_KEY is not set.\n' +
        '    Export it in your shell or create a .env file with:\n' +
        '    ANTHROPIC_API_KEY=sk-ant-...',
    );
    process.exit(1);
  }

  const state = loadState();

  // Find all EPUB files
  const epubFiles = fs
    .readdirSync(BOOKS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.epub'))
    .sort();

  if (epubFiles.length === 0) {
    console.log('📂  No EPUB files found in books/');
    console.log('    Drop an .epub file into the books/ directory and run again.');
    return;
  }

  // Walk books in order; pick the first book that has an unparsed chapter
  for (const epubFile of epubFiles) {
    const epubPath = path.join(BOOKS_DIR, epubFile);

    let epub;
    try {
      epub = openEpub(epubPath);
    } catch (err) {
      console.error(`⚠️  Failed to open ${epubFile}:`, err);
      continue;
    }

    // Register book in state if new
    if (!state.books[epubFile]) {
      state.books[epubFile] = {
        title: epub.title,
        author: epub.author,
        filename: epubFile,
        totalChapters: epub.chapters.length,
        finished: false,
        chapters: [],
      } satisfies BookEntry;
      saveState(state);
      console.log(`📖  Registered new book: "${epub.title}" by ${epub.author}`);
      console.log(`    ${epub.chapters.length} chapters detected.`);
    }

    const bookState = state.books[epubFile]!;

    // Skip books already marked finished
    if (bookState.finished) {
      console.log(`📦  "${epub.title}" is archived (all chapters read).`);
      continue;
    }

    const parsedIds = new Set(bookState.chapters.map((c) => c.id));

    // Find first unparsed chapter
    const nextChapter = epub.chapters.find((c) => !parsedIds.has(c.id));

    if (!nextChapter) {
      console.log(`✅  "${epub.title}" — all ${epub.chapters.length} chapters already parsed.`);
      continue;
    }

    // ── Parse this chapter ────────────────────────────────────────────────────

    const chapterNum = bookState.chapters.length + 1;
    console.log(`\n📄  Parsing chapter ${chapterNum}: "${nextChapter.title}"`);
    console.log(`    Book: "${epub.title}"`);

    let rawHtml: string;
    try {
      rawHtml = epub.getChapterContent(nextChapter);
    } catch (err) {
      console.error('    ❌  Could not read chapter content:', err);
      break;
    }

    const cleanedHtml = cleanChapterHtml(rawHtml);
    const plainText = cleanedHtml.replace(/<[^>]+>/g, '');

    if (plainText.trim().length < 50) {
      console.log('    ⚠️  Chapter appears to have no readable text — skipping.');
      // Mark as parsed so we don't loop on it forever
      bookState.chapters.push({ id: nextChapter.id, title: nextChapter.title, spineIndex: nextChapter.spineIndex, parts: [] });
      saveState(state);
      continue;
    }

    const totalMinutes = estimateReadingTime(plainText);
    console.log(`    Estimated reading time: ${totalMinutes} min`);

    // ── Split if needed ───────────────────────────────────────────────────────

    const htmlParts: { html: string; minutes: number }[] = [];

    if (totalMinutes > SPLIT_THRESHOLD_MINUTES) {
      console.log(`    Chapter is long (${totalMinutes} min) — splitting into two parts…`);

      // Approximate target: 65% of plain-text characters for Part 1
      const targetChars = Math.floor(plainText.length * 0.65);

      // Get paragraph list for LLM context
      const paragraphs = extractParagraphs(cleanedHtml);
      const mechTargetIdx = (() => {
        let cum = 0;
        for (let i = 0; i < paragraphs.length; i++) {
          cum += paragraphs[i]!.length;
          if (cum >= targetChars) return i;
        }
        return Math.floor(paragraphs.length * 0.65);
      })();

      let splitParaIdx = mechTargetIdx;
      if (paragraphs.length > 4) {
        try {
          console.log('    Asking LLM for the best narrative split point…');
          splitParaIdx = await findNarrativeSplitPoint(paragraphs, mechTargetIdx);
          console.log(`    LLM chose paragraph ${splitParaIdx + 1} (mechanical was ${mechTargetIdx + 1})`);
        } catch (err) {
          console.warn('    LLM split failed, using mechanical split:', err);
        }
      }

      // Reconstruct target character count from the chosen paragraph
      const targetCharsFinal = paragraphs.slice(0, splitParaIdx + 1).join('').length;
      const [part1Html, part2Html] = splitHtmlAtCharCount(cleanedHtml, targetCharsFinal);

      const p1Text = part1Html.replace(/<[^>]+>/g, '');
      const p2Text = part2Html.replace(/<[^>]+>/g, '');

      htmlParts.push(
        { html: part1Html, minutes: estimateReadingTime(p1Text) },
        { html: part2Html, minutes: estimateReadingTime(p2Text) },
      );
      console.log(`    Split: Part 1 ≈ ${htmlParts[0]!.minutes} min, Part 2 ≈ ${htmlParts[1]!.minutes} min`);
    } else {
      htmlParts.push({ html: cleanedHtml, minutes: totalMinutes });
    }

    // ── Generate summaries and HTML files ─────────────────────────────────────

    const bookSlug = slug(epubFile.replace(/\.epub$/i, ''), 20);
    const chapSlug = slug(nextChapter.title);

    const newPageEntries: PageEntry[] = [];
    const partEntries: PartEntry[] = [];

    for (let i = 0; i < htmlParts.length; i++) {
      const part = htmlParts[i]!;
      const partNum = i + 1;
      const totalParts = htmlParts.length;

      console.log(`    [${partNum}/${totalParts}] Generating summary…`);
      const partText = part.html.replace(/<[^>]+>/g, '').slice(0, 4500);
      let summary = '';
      try {
        summary = await summarizeChapter(partText, epub.title, nextChapter.title);
      } catch (err) {
        console.warn(`    ⚠️  Summary failed for part ${partNum}:`, err);
      }

      const outFilename = `${bookSlug}-${chapSlug}-p${partNum}.html`;
      const outRelative = `chapters/${outFilename}`;

      const partEntry: PartEntry = {
        partIndex: partNum,
        totalParts,
        outputFile: outRelative,
        estimatedMinutes: part.minutes,
        summary,
        parsedAt: new Date().toISOString(),
      };
      partEntries.push(partEntry);

      const pageEntry: PageEntry = {
        file: outRelative,
        bookTitle: epub.title,
        bookFilename: epubFile,
        chapterId: nextChapter.id,
        chapterTitle: nextChapter.title,
        partIndex: partNum,
        totalParts,
        estimatedMinutes: part.minutes,
        summary,
        parsedAt: new Date().toISOString(),
      };
      newPageEntries.push(pageEntry);
    }

    // Append new pages to state now so prev/next links resolve correctly
    state.pages.push(...newPageEntries);

    // Write HTML files
    for (let i = 0; i < htmlParts.length; i++) {
      const part = htmlParts[i]!;
      const pageEntry = newPageEntries[i]!;
      const outFilename = path.basename(pageEntry.file);
      const outPath = path.join(CHAPTERS_DIR, outFilename);

      const currentIdx = state.pages.findIndex((p) => p.file === pageEntry.file);
      const prevPage = currentIdx > 0 ? state.pages[currentIdx - 1] : undefined;
      const nextPage =
        currentIdx < state.pages.length - 1 ? state.pages[currentIdx + 1] : undefined;

      const html = generateChapterPage({
        bookTitle: epub.title,
        chapterTitle: nextChapter.title,
        partIndex: pageEntry.partIndex,
        totalParts: pageEntry.totalParts,
        estimatedMinutes: pageEntry.estimatedMinutes,
        summary: pageEntry.summary,
        contentHtml: part.html,
        prevPage,
        nextPage,
      });

      fs.writeFileSync(outPath, html, 'utf8');
      console.log(`    ✓  Written: ${pageEntry.file}`);
    }

    // Update book state
    const chapterEntry: ChapterEntry = {
      id: nextChapter.id,
      title: nextChapter.title,
      spineIndex: nextChapter.spineIndex,
      parts: partEntries,
    };
    bookState.chapters.push(chapterEntry);

    // Check if the book is now complete
    const contentChapters = bookState.chapters.filter((c) => c.parts.length > 0);
    if (bookState.totalChapters > 0 && contentChapters.length >= bookState.totalChapters) {
      bookState.finished = true;
      console.log(`\n🏁  Book complete — "${epub.title}" moved to archive.`);
    }

    saveState(state);
    rebuildIndex(state);

    console.log(`\n✅  Done! "${nextChapter.title}" is ready in docs/`);
    const total = bookState.totalChapters || epub.chapters.length;
    console.log(`    Chapters parsed so far: ${contentChapters.length} / ${total}`);
    if (!bookState.finished) {
      console.log(`    ${total - contentChapters.length} chapter(s) remaining.`);
    }
    console.log(`\n    Next step: commit the docs/ changes and push to GitHub.`);

    return; // One chapter per run
  }

  console.log('\n🎉  All chapters in all books have been parsed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
