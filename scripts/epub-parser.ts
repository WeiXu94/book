import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import * as path from 'path';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['rootfile', 'item', 'itemref', 'navPoint', 'li'].includes(name),
});

export interface EpubChapter {
  id: string;
  title: string;
  spineIndex: number;
  zipPath: string;
}

export interface EpubBook {
  title: string;
  author: string;
  chapters: EpubChapter[];
  getChapterContent(chapter: EpubChapter): string;
}

export function openEpub(epubPath: string): EpubBook {
  const zip = new AdmZip(epubPath);

  // Step 1: container.xml → OPF path
  const containerXml = readZipEntry(zip, 'META-INF/container.xml');
  const container = xmlParser.parse(containerXml);
  const rootfiles = container?.container?.rootfiles?.rootfile ?? [];
  const rootfile = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const opfPath: string = rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('Cannot locate OPF file in EPUB container.xml');

  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  // Step 2: Parse OPF
  const opfXml = readZipEntry(zip, opfPath);
  const opf = xmlParser.parse(opfXml);
  const pkg: Record<string, unknown> = opf?.package ?? opf?.['opf:package'] ?? {};

  const metadata = (pkg?.metadata ?? pkg?.['opf:metadata'] ?? {}) as Record<string, unknown>;
  const manifestEl = (pkg?.manifest ?? pkg?.['opf:manifest'] ?? {}) as Record<string, unknown>;
  const spineEl = (pkg?.spine ?? pkg?.['opf:spine'] ?? {}) as Record<string, unknown>;

  const title = extractText(metadata?.['dc:title']) || 'Unknown Title';
  const author = extractText(metadata?.['dc:creator']) || 'Unknown Author';

  // Build manifest id → {href, mediaType}
  const manifestItems: Record<string, { href: string; mediaType: string }> = {};
  for (const item of ensureArray(manifestEl?.item)) {
    const rec = item as Record<string, string>;
    const id = rec['@_id'];
    if (id) {
      manifestItems[id] = {
        href: rec['@_href'] ?? '',
        mediaType: rec['@_media-type'] ?? '',
      };
    }
  }

  // Spine → ordered chapter IDs (skip linear="no")
  const spineIds: string[] = ensureArray(spineEl?.itemref)
    .filter((ref) => (ref as Record<string, string>)['@_linear'] !== 'no')
    .map((ref) => (ref as Record<string, string>)['@_idref'])
    .filter(Boolean);

  // Chapter title maps from NCX and nav.xhtml
  const titleMap: Record<string, string> = {};

  // NCX (EPUB 2)
  const tocId = spineEl['@_toc'] as string | undefined;
  if (tocId && manifestItems[tocId]) {
    const ncxZipPath = joinZipPath(opfDir, manifestItems[tocId].href);
    try {
      const ncxXml = readZipEntry(zip, ncxZipPath);
      const ncx = xmlParser.parse(ncxXml);
      flattenNavPoints(ensureArray(ncx?.ncx?.navMap?.navPoint), titleMap);
    } catch {
      // NCX not readable — continue without it
    }
  }

  // nav.xhtml (EPUB 3) — look for any xhtml item with "nav" in id or href
  for (const [id, item] of Object.entries(manifestItems)) {
    if (
      item.mediaType.includes('xhtml') &&
      (id.toLowerCase().includes('nav') || item.href.toLowerCase().includes('nav'))
    ) {
      try {
        const navZipPath = joinZipPath(opfDir, item.href);
        const navHtml = readZipEntry(zip, navZipPath);
        const $ = cheerio.load(navHtml);
        $('nav li a, ol li a').each((_, el) => {
          const href = ($(el).attr('href') ?? '').split('#')[0];
          const text = $(el).text().trim();
          if (href && text) {
            titleMap[href] = text;
            titleMap[path.posix.basename(href)] = text;
          }
        });
      } catch {
        // nav not readable — continue
      }
      break;
    }
  }

  // Assemble chapter list from spine
  const chapters: EpubChapter[] = [];
  for (let i = 0; i < spineIds.length; i++) {
    const id = spineIds[i];
    const item = manifestItems[id];
    if (!item) continue;
    if (!item.mediaType.includes('html')) continue;

    const zipPath = joinZipPath(opfDir, item.href);
    const hrefBase = path.posix.basename(item.href);
    const chapterTitle =
      titleMap[item.href] ??
      titleMap[hrefBase] ??
      null;

    chapters.push({ id, title: chapterTitle ?? '', spineIndex: i, zipPath });
  }

  // Backfill titles from HTML <title> / <h1> when not in NCX/nav
  for (const ch of chapters) {
    if (ch.title) continue;
    try {
      const html = readZipEntry(zip, ch.zipPath);
      const $ = cheerio.load(html);
      ch.title =
        $('h1, h2').first().text().trim() ||
        $('title').first().text().trim() ||
        `Chapter ${chapters.indexOf(ch) + 1}`;
    } catch {
      ch.title = `Chapter ${chapters.indexOf(ch) + 1}`;
    }
  }

  return {
    title,
    author,
    chapters,
    getChapterContent(chapter: EpubChapter): string {
      return readZipEntry(zip, chapter.zipPath);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readZipEntry(zip: AdmZip, entryPath: string): string {
  const normalized = entryPath.replace(/^\//, '');
  let entry = zip.getEntry(normalized) ?? zip.getEntry(entryPath);
  if (!entry) {
    // Case-insensitive fallback
    const lower = normalized.toLowerCase();
    entry = zip.getEntries().find((e) => e.entryName.toLowerCase() === lower) ?? null;
  }
  if (!entry) throw new Error(`EPUB entry not found: ${entryPath}`);
  return entry.getData().toString('utf8');
}

function joinZipPath(dir: string, href: string): string {
  if (!dir) return href;
  if (href.startsWith('/')) return href.slice(1);
  return `${dir}/${href}`;
}

function ensureArray<T>(val: T | T[] | null | undefined): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    return (
      (obj['#text'] as string) ??
      (obj['_'] as string) ??
      Object.values(obj).find((v) => typeof v === 'string') as string ??
      ''
    );
  }
  return '';
}

function flattenNavPoints(navPoints: unknown[], titleMap: Record<string, string>): void {
  for (const point of navPoints) {
    const p = point as Record<string, unknown>;
    const src = ((p?.content as Record<string, string>)?.['@_src'] ?? '').split('#')[0];
    const textVal = (p?.navLabel as Record<string, unknown>)?.text;
    const text = typeof textVal === 'string' ? textVal : String(textVal ?? '');
    if (src && text) {
      titleMap[src] = text;
      titleMap[path.posix.basename(src)] = text;
    }
    if (p?.navPoint) {
      flattenNavPoints(ensureArray(p.navPoint as unknown[]), titleMap);
    }
  }
}
