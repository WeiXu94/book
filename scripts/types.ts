export interface BookState {
  version: number;
  pages: PageEntry[];
  books: Record<string, BookEntry>;
}

export interface BookEntry {
  title: string;
  author: string;
  filename: string;
  totalChapters: number;
  finished: boolean;
  chapters: ChapterEntry[];
}

export interface ChapterEntry {
  id: string;
  title: string;
  spineIndex: number;
  parts: PartEntry[];
}

export interface PartEntry {
  partIndex: number;
  totalParts: number;
  outputFile: string;
  estimatedMinutes: number;
  summary: string;
  parsedAt: string;
}

export interface PageEntry {
  file: string;
  bookTitle: string;
  bookFilename: string;
  chapterId: string;
  chapterTitle: string;
  partIndex: number;
  totalParts: number;
  estimatedMinutes: number;
  summary: string;
  parsedAt: string;
}
