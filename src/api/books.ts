import { ensureBooksSchema } from "../db/booksSchema";
import { isAuthorized, unauthorized } from "./adminBoard/auth";
import { ensureReadingSchema, handleReadingTool } from "./readingMcp";
import type { Env } from "../types";
import { json } from "../utils/json";

const D1_BATCH_LIMIT = 50;
const D1_BIND_LIMIT = 90;

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  total_pages: number;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  book_id: string;
  reader: string;
  page: number;
}

interface CommentRow {
  id: string;
  page: number;
  author: string;
  content: string;
  created_at: string;
}

interface ImportBook {
  id?: string;
  title?: string;
  author?: string;
  total_pages?: number;
  created_at?: string;
  pages?: string[];
  progress?: Record<string, number>;
  comments?: Record<string, Array<{ author?: string; content?: string; time?: string }>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeIsoDate(value: unknown, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function clampPage(value: unknown, fallback = 1): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function cleanReader(value: unknown): "layla" | "kld" {
  return value === "kld" ? "kld" : "layla";
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function defaultProgress(): Record<string, number> {
  return { layla: 1, kld: 1 };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const batch of chunk(statements, D1_BATCH_LIMIT)) await db.batch(batch);
}

async function readProgress(db: D1Database, bookId: string): Promise<Record<string, number>> {
  const rows = await db.prepare("SELECT book_id, reader, page FROM book_progress WHERE book_id = ?").bind(bookId).all<ProgressRow>();
  const progress = defaultProgress();
  for (const row of rows.results ?? []) progress[row.reader] = row.page;
  return progress;
}

async function readProgressForBooks(db: D1Database, bookIds: string[]): Promise<Record<string, Record<string, number>>> {
  const progressByBook = Object.fromEntries(bookIds.map((id) => [id, defaultProgress()])) as Record<string, Record<string, number>>;
  if (bookIds.length === 0) return progressByBook;

  for (const ids of chunk(bookIds, D1_BIND_LIMIT)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await db.prepare(`SELECT book_id, reader, page FROM book_progress WHERE book_id IN (${placeholders})`).bind(...ids).all<ProgressRow>();
    for (const row of rows.results ?? []) {
      progressByBook[row.book_id] ||= defaultProgress();
      progressByBook[row.book_id][row.reader] = row.page;
    }
  }
  return progressByBook;
}

async function listBooks(env: Env): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const rows = await env.DB.prepare("SELECT * FROM books ORDER BY updated_at DESC, created_at DESC").all<BookRow>();
  const bookRows = rows.results ?? [];
  const progressByBook = await readProgressForBooks(env.DB, bookRows.map((book) => book.id));
  const books = bookRows.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author || "",
    total_pages: book.total_pages,
    progress: progressByBook[book.id] || defaultProgress(),
    created_at: book.created_at,
    updated_at: book.updated_at
  }));
  return json({ books });
}

async function getBookPage(env: Env, url: URL): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const bookId = url.searchParams.get("book_id") || "";
  const requestedPage = clampPage(url.searchParams.get("page"));
  if (!bookId) return json({ error: "book_id is required" }, { status: 400 });

  const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(bookId).first<BookRow>();
  if (!book) return json({ error: "Book not found" }, { status: 404 });

  const page = Math.min(requestedPage, Math.max(1, book.total_pages));
  const pageRow = await env.DB.prepare("SELECT content FROM book_pages WHERE book_id = ? AND page = ?").bind(bookId, page).first<{ content: string }>();
  const comments = await env.DB.prepare(
    "SELECT id, page, author, content, created_at FROM book_comments WHERE book_id = ? AND page = ? ORDER BY created_at ASC"
  ).bind(bookId, page).all<CommentRow>();

  return json({
    id: book.id,
    title: book.title,
    author: book.author || "",
    page,
    total_pages: book.total_pages,
    content: pageRow?.content || "",
    progress: await readProgress(env.DB, book.id),
    comments: (comments.results ?? []).map((item) => ({
      id: item.id,
      page: item.page,
      author: item.author,
      content: item.content,
      time: item.created_at
    }))
  });
}

async function saveProgress(env: Env, request: Request): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid JSON" }, { status: 400 });
  const bookId = String(body.book_id || "").trim();
  const reader = cleanReader(body.reader);
  const page = clampPage(body.page);
  if (!bookId) return json({ error: "book_id is required" }, { status: 400 });
  const book = await env.DB.prepare("SELECT total_pages FROM books WHERE id = ?").bind(bookId).first<{ total_pages: number }>();
  if (!book) return json({ error: "Book not found" }, { status: 404 });
  const safePage = Math.min(page, Math.max(1, book.total_pages));
  const updatedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO book_progress (book_id, reader, page, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, reader) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at`
  ).bind(bookId, reader, safePage, updatedAt).run();
  await env.DB.prepare("UPDATE books SET updated_at = ? WHERE id = ?").bind(updatedAt, bookId).run();
  return json({ success: true, progress: await readProgress(env.DB, bookId) });
}

async function addComment(env: Env, request: Request): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid JSON" }, { status: 400 });
  const bookId = String(body.book_id || "").trim();
  const page = clampPage(body.page);
  const author = cleanReader(body.author);
  const content = String(body.content || "").trim();
  if (!bookId || !content) return json({ error: "book_id and content are required" }, { status: 400 });
  const book = await env.DB.prepare("SELECT total_pages FROM books WHERE id = ?").bind(bookId).first<{ total_pages: number }>();
  if (!book) return json({ error: "Book not found" }, { status: 404 });
  const safePage = Math.min(page, Math.max(1, book.total_pages));
  const createdAt = nowIso();
  const comment = { id: newId("comment"), book_id: bookId, page: safePage, author, content, created_at: createdAt };
  await env.DB.prepare(
    "INSERT INTO book_comments (id, book_id, page, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(comment.id, comment.book_id, comment.page, comment.author, comment.content, comment.created_at).run();
  await env.DB.prepare("UPDATE books SET updated_at = ? WHERE id = ?").bind(createdAt, bookId).run();
  return json({ success: true, comment: { id: comment.id, page: comment.page, author, content, time: comment.created_at } });
}

async function deleteBook(env: Env, request: Request): Promise<Response> {
  await ensureBooksSchema(env.DB);
  await ensureReadingSchema(env.DB);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid JSON" }, { status: 400 });
  const bookId = String(body.book_id || "").trim();
  if (!bookId) return json({ error: "book_id is required" }, { status: 400 });

  const book = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(bookId).first<{ id: string }>();
  if (!book) return json({ error: "Book not found" }, { status: 404 });

  await env.DB.batch([
    env.DB.prepare("DELETE FROM book_annotations WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM reading_session_chunks WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM book_comments WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM book_progress WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM book_pages WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM books WHERE id = ?").bind(bookId)
  ]);

  return json({ success: true, deleted_book_id: bookId });
}

function buildImportStatements(db: D1Database, raw: ImportBook, now: string): { statements: D1PreparedStatement[]; pageCount: number; commentCount: number } {
  const id = String(raw.id || newId("book")).trim();
  const title = String(raw.title || id).trim();
  const pages = Array.isArray(raw.pages) ? raw.pages.map((item) => String(item ?? "")) : [];
  const totalPages = Math.max(1, Math.floor(raw.total_pages || pages.length || 1));
  const createdAt = safeIsoDate(raw.created_at, now);
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO books (id, title, author, total_pages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, total_pages = excluded.total_pages, updated_at = excluded.updated_at`
    ).bind(id, title, raw.author || "", totalPages, createdAt, now),
    db.prepare("DELETE FROM book_pages WHERE book_id = ?").bind(id)
  ];

  for (let i = 0; i < pages.length; i += 1) {
    statements.push(db.prepare("INSERT INTO book_pages (book_id, page, content) VALUES (?, ?, ?)").bind(id, i + 1, pages[i]));
  }

  for (const reader of ["layla", "kld"] as const) {
    const page = Math.min(clampPage(raw.progress?.[reader]), totalPages);
    statements.push(
      db.prepare(
        `INSERT INTO book_progress (book_id, reader, page, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id, reader) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at`
      ).bind(id, reader, page, now)
    );
  }

  statements.push(db.prepare("DELETE FROM book_comments WHERE book_id = ?").bind(id));
  let commentCount = 0;
  const comments = raw.comments || {};
  for (const [pageText, items] of Object.entries(comments)) {
    const page = Math.min(clampPage(pageText), totalPages);
    for (const item of items || []) {
      const content = String(item.content || "").trim();
      if (!content) continue;
      const createdAtComment = safeIsoDate(item.time, now);
      statements.push(
        db.prepare("INSERT INTO book_comments (id, book_id, page, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(newId("comment"), id, page, cleanReader(item.author), content, createdAtComment)
      );
      commentCount += 1;
    }
  }

  return { statements, pageCount: pages.length, commentCount };
}

async function importBooks(env: Env, request: Request): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const body = await request.json().catch(() => null) as { books?: ImportBook[] } | null;
  if (!body || !Array.isArray(body.books)) return json({ error: "books array is required" }, { status: 400 });

  let importedBooks = 0;
  let importedPages = 0;
  let importedComments = 0;
  const now = nowIso();

  for (const raw of body.books) {
    const { statements, pageCount, commentCount } = buildImportStatements(env.DB, raw, now);
    await runBatched(env.DB, statements);
    importedBooks += 1;
    importedPages += pageCount;
    importedComments += commentCount;
  }

  return json({ success: true, imported_books: importedBooks, imported_pages: importedPages, imported_comments: importedComments });
}

function argsFromSearch(url: URL): Record<string, unknown> {
  return Object.fromEntries(url.searchParams.entries());
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({})) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

async function readingJson(env: Env, toolName: string, args: Record<string, unknown>): Promise<Response> {
  const result = await handleReadingTool(env.DB, toolName, args);
  if (result.error) return json({ error: result.error }, { status: 400 });
  return json(result.data ?? {});
}

export async function handleBooks(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/books/api/list") return listBooks(env);
  if (request.method === "GET" && url.pathname === "/books/api/page") return getBookPage(env, url);
  if (request.method === "POST" && url.pathname === "/books/api/progress") return saveProgress(env, request);
  if (request.method === "POST" && url.pathname === "/books/api/comments") return addComment(env, request);
  if (request.method === "POST" && url.pathname === "/books/api/delete") return deleteBook(env, request);
  if (request.method === "DELETE" && url.pathname === "/books/api/delete") return deleteBook(env, request);
  if (request.method === "POST" && url.pathname === "/admin/books/import") return importBooks(env, request);
  if (request.method === "GET" && url.pathname === "/books/api/chunks") return readingJson(env, "reading_list_chunks", argsFromSearch(url));
  if (request.method === "GET" && url.pathname === "/books/api/read-chunk") return readingJson(env, "reading_read_chunk", argsFromSearch(url));
  if (request.method === "GET" && url.pathname === "/books/api/continue") return readingJson(env, "reading_continue", argsFromSearch(url));
  if (request.method === "GET" && url.pathname === "/books/api/search") return readingJson(env, "reading_search_chunks", argsFromSearch(url));
  if (request.method === "GET" && url.pathname === "/books/api/annotations") return readingJson(env, "reading_list_annotations", argsFromSearch(url));
  if (request.method === "GET" && url.pathname === "/books/api/reading-progress") return readingJson(env, "reading_get_progress", argsFromSearch(url));
  if (request.method === "POST" && url.pathname === "/books/api/annotations") return readingJson(env, "reading_annotate_passage", await readJsonBody(request));
  if (request.method === "POST" && url.pathname === "/books/api/submit-notes") return readingJson(env, "reading_submit_user_notes", await readJsonBody(request));
  if (request.method === "POST" && url.pathname === "/books/api/replies") return readingJson(env, "reading_reply_to_annotation", await readJsonBody(request));
  if (request.method === "POST" && url.pathname === "/books/api/mark-read") return readingJson(env, "reading_mark_read", await readJsonBody(request));
  if (request.method === "POST" && url.pathname === "/books/api/update-annotation") return readingJson(env, "reading_update_annotation", await readJsonBody(request));
  if (request.method === "POST" && url.pathname === "/books/api/delete-annotation") return readingJson(env, "reading_delete_annotation", await readJsonBody(request));

  return json({ error: "Not found" }, { status: 404 });
}
