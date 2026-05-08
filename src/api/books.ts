import { isAuthorized, unauthorized } from "./adminBoard/auth";
import type { Env } from "../types";
import { json } from "../utils/json";

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  total_pages: number;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
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

async function ensureBooksSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        total_pages INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS book_pages (
        book_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (book_id, page)
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS book_progress (
        book_id TEXT NOT NULL,
        reader TEXT NOT NULL,
        page INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (book_id, reader)
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS book_comments (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_book_comments_page ON book_comments(book_id, page, created_at)")
  ]);
}

async function readProgress(db: D1Database, bookId: string): Promise<Record<string, number>> {
  const rows = await db.prepare("SELECT reader, page FROM book_progress WHERE book_id = ?").bind(bookId).all<ProgressRow>();
  const progress: Record<string, number> = { layla: 1, kld: 1 };
  for (const row of rows.results ?? []) progress[row.reader] = row.page;
  return progress;
}

async function listBooks(env: Env): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const rows = await env.DB.prepare("SELECT * FROM books ORDER BY updated_at DESC, created_at DESC").all<BookRow>();
  const books = [];
  for (const book of rows.results ?? []) {
    books.push({
      id: book.id,
      title: book.title,
      author: book.author || "",
      total_pages: book.total_pages,
      progress: await readProgress(env.DB, book.id),
      created_at: book.created_at,
      updated_at: book.updated_at
    });
  }
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

async function importBooks(env: Env, request: Request): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const body = await request.json().catch(() => null) as { books?: ImportBook[] } | null;
  if (!body || !Array.isArray(body.books)) return json({ error: "books array is required" }, { status: 400 });

  let importedBooks = 0;
  let importedPages = 0;
  let importedComments = 0;
  const now = nowIso();

  for (const raw of body.books) {
    const id = String(raw.id || newId("book")).trim();
    const title = String(raw.title || id).trim();
    const pages = Array.isArray(raw.pages) ? raw.pages.map((item) => String(item ?? "")) : [];
    const totalPages = Math.max(1, Math.floor(raw.total_pages || pages.length || 1));
    const createdAt = raw.created_at ? new Date(raw.created_at).toISOString() : now;

    await env.DB.prepare(
      `INSERT INTO books (id, title, author, total_pages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, total_pages = excluded.total_pages, updated_at = excluded.updated_at`
    ).bind(id, title, raw.author || "", totalPages, createdAt, now).run();

    await env.DB.prepare("DELETE FROM book_pages WHERE book_id = ?").bind(id).run();
    for (let i = 0; i < pages.length; i += 1) {
      await env.DB.prepare("INSERT INTO book_pages (book_id, page, content) VALUES (?, ?, ?)").bind(id, i + 1, pages[i]).run();
      importedPages += 1;
    }

    for (const reader of ["layla", "kld"] as const) {
      const page = Math.min(clampPage(raw.progress?.[reader]), totalPages);
      await env.DB.prepare(
        `INSERT INTO book_progress (book_id, reader, page, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id, reader) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at`
      ).bind(id, reader, page, now).run();
    }

    await env.DB.prepare("DELETE FROM book_comments WHERE book_id = ?").bind(id).run();
    const comments = raw.comments || {};
    for (const [pageText, items] of Object.entries(comments)) {
      const page = Math.min(clampPage(pageText), totalPages);
      for (const item of items || []) {
        const content = String(item.content || "").trim();
        if (!content) continue;
        const createdAtComment = item.time ? new Date(item.time).toISOString() : now;
        await env.DB.prepare(
          "INSERT INTO book_comments (id, book_id, page, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(newId("comment"), id, page, cleanReader(item.author), content, createdAtComment).run();
        importedComments += 1;
      }
    }

    importedBooks += 1;
  }

  return json({ success: true, imported_books: importedBooks, imported_pages: importedPages, imported_comments: importedComments });
}

export async function handleBooks(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/books/api/list") return listBooks(env);
  if (request.method === "GET" && url.pathname === "/books/api/page") return getBookPage(env, url);
  if (request.method === "POST" && url.pathname === "/books/api/progress") return saveProgress(env, request);
  if (request.method === "POST" && url.pathname === "/books/api/comments") return addComment(env, request);
  if (request.method === "POST" && url.pathname === "/admin/books/import") return importBooks(env, request);

  return json({ error: "Not found" }, { status: 404 });
}
