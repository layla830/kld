interface BookRow {
  id: string;
  title: string;
  author: string | null;
  total_pages: number;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  content: string;
}

interface ProgressRow {
  reader: string;
  page: number;
}

interface AnnotationRow {
  id: string;
  book_id: string;
  chunk_id: string;
  page: number;
  quote: string | null;
  quote_offset: number | null;
  note: string;
  author: string;
  kind: string;
  mood: string | null;
  tags: string | null;
  status: string;
  parent_id: string | null;
  created_at: string;
  submitted_at: string | null;
}

type Reader = "layla" | "kld";
type ContextMode = "chunk-once-per-session" | "chunk-always" | "notes-only";

export interface ReadingToolResult {
  handled: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function clampPage(value: unknown, fallback = 1): number {
  return Math.max(1, Math.floor(readNumber(value, fallback)));
}

function cleanReader(value: unknown): Reader {
  return value === "layla" ? "layla" : "kld";
}

function cleanAuthor(value: unknown): "user" | "claude" | "layla" | "kld" {
  if (value === "claude" || value === "kld") return "claude";
  if (value === "layla") return "layla";
  return "user";
}

function cleanStatus(value: unknown): "open" | "submitted" | "published" {
  if (value === "submitted" || value === "published") return value;
  return "open";
}

function cleanKind(value: unknown): string {
  return readString(value) || "annotation";
}

function cleanContextMode(value: unknown): ContextMode {
  return value === "chunk-always" || value === "notes-only" ? value : "chunk-once-per-session";
}

function chunkIdForPage(page: number): string {
  return `p${Math.max(1, Math.floor(page))}`;
}

function pageFromChunkId(value: unknown, fallback = 1): number {
  if (typeof value === "number") return clampPage(value, fallback);
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^(?:p|page-|ch)?0*(\d+)$/i);
  return match ? clampPage(match[1], fallback) : fallback;
}

function tagsToJson(tags: unknown): string {
  return JSON.stringify(readStringArray(tags));
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toChunk(book: BookRow, page: number, content = ""): Record<string, unknown> {
  return {
    id: chunkIdForPage(page),
    chunkId: chunkIdForPage(page),
    page,
    title: `${book.title} ${page}/${book.total_pages}`,
    order: page - 1,
    charCount: content.length,
    prevId: page > 1 ? chunkIdForPage(page - 1) : null,
    nextId: page < book.total_pages ? chunkIdForPage(page + 1) : null
  };
}

function toAnnotation(row: AnnotationRow): Record<string, unknown> {
  return {
    id: row.id,
    bookId: row.book_id,
    chunkId: row.chunk_id,
    page: row.page,
    quote: row.quote || "",
    quoteOffset: row.quote_offset,
    note: row.note,
    author: row.author,
    kind: row.kind,
    mood: row.mood || "",
    tags: parseTags(row.tags),
    status: row.status,
    parentId: row.parent_id,
    createdAt: row.created_at,
    submittedAt: row.submitted_at
  };
}

async function ensureReadingSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, total_pages INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS book_pages (book_id TEXT NOT NULL, page INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (book_id, page))"),
    db.prepare("CREATE TABLE IF NOT EXISTS book_progress (book_id TEXT NOT NULL, reader TEXT NOT NULL, page INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (book_id, reader))"),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS book_annotations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        quote TEXT,
        quote_offset INTEGER,
        note TEXT NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        mood TEXT,
        tags TEXT,
        status TEXT NOT NULL,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        submitted_at TEXT
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_book_annotations_chunk ON book_annotations(book_id, chunk_id, status, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_book_annotations_parent ON book_annotations(parent_id)"),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS reading_session_chunks (
        session_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        context_mode TEXT NOT NULL,
        PRIMARY KEY (session_id, book_id, chunk_id)
      )`
    )
  ]);
}

async function getBook(db: D1Database, bookId: string): Promise<BookRow | null> {
  return await db.prepare("SELECT * FROM books WHERE id = ?").bind(bookId).first<BookRow>();
}

async function getPageContent(db: D1Database, bookId: string, page: number): Promise<string> {
  const row = await db.prepare("SELECT content FROM book_pages WHERE book_id = ? AND page = ?").bind(bookId, page).first<PageRow>();
  return row?.content || "";
}

async function readProgress(db: D1Database, bookId: string): Promise<Record<Reader, number>> {
  const rows = await db.prepare("SELECT reader, page FROM book_progress WHERE book_id = ?").bind(bookId).all<ProgressRow>();
  const progress: Record<Reader, number> = { layla: 1, kld: 1 };
  for (const row of rows.results ?? []) {
    if (row.reader === "layla" || row.reader === "kld") progress[row.reader] = row.page;
  }
  return progress;
}

async function saveProgress(db: D1Database, bookId: string, reader: Reader, page: number): Promise<Record<Reader, number>> {
  const book = await getBook(db, bookId);
  if (!book) throw new Error("Book not found");
  const safePage = Math.min(Math.max(1, page), Math.max(1, book.total_pages));
  const updatedAt = nowIso();
  await db.prepare(
    "INSERT INTO book_progress (book_id, reader, page, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(book_id, reader) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at"
  ).bind(bookId, reader, safePage, updatedAt).run();
  await db.prepare("UPDATE books SET updated_at = ? WHERE id = ?").bind(updatedAt, bookId).run();
  return readProgress(db, bookId);
}

async function listBooks(db: D1Database): Promise<Record<string, unknown>> {
  const rows = await db.prepare("SELECT * FROM books ORDER BY updated_at DESC, created_at DESC").all<BookRow>();
  const books = [];
  for (const book of rows.results ?? []) {
    const annotations = await db.prepare("SELECT COUNT(*) AS count FROM book_annotations WHERE book_id = ?").bind(book.id).first<{ count: number }>();
    books.push({
      id: book.id,
      bookId: book.id,
      title: book.title,
      author: book.author || "",
      chunkCount: book.total_pages,
      total_pages: book.total_pages,
      progress: await readProgress(db, book.id),
      annotationCount: annotations?.count ?? 0,
      updatedAt: book.updated_at
    });
  }
  return { books };
}

async function listChunks(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) return { error: "bookId is required" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const reader = cleanReader(args.reader);
  const progress = await readProgress(db, bookId);
  const annotationRows = await db.prepare("SELECT page, COUNT(*) AS count FROM book_annotations WHERE book_id = ? GROUP BY page").bind(bookId).all<{ page: number; count: number }>();
  const counts = new Map((annotationRows.results ?? []).map((row) => [row.page, row.count]));
  const chunks = Array.from({ length: book.total_pages }, (_, index) => {
    const page = index + 1;
    return { ...toChunk(book, page), read: page < progress[reader], annotationCount: counts.get(page) ?? 0 };
  });
  return { bookId, title: book.title, chunks, progress };
}

async function readChunk(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) return { error: "bookId is required" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const page = Math.min(pageFromChunkId(args.chunkId ?? args.chunk_id ?? args.page), Math.max(1, book.total_pages));
  const content = await getPageContent(db, bookId, page);
  const annotations = await listAnnotations(db, { bookId, chunkId: chunkIdForPage(page) });
  return {
    bookId,
    title: book.title,
    author: book.author || "",
    ...toChunk(book, page, content),
    content,
    text: content,
    annotations: annotations.annotations,
    progress: await readProgress(db, bookId)
  };
}

async function continueReading(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) {
    const recent = await db.prepare("SELECT id FROM books ORDER BY updated_at DESC, created_at DESC LIMIT 1").first<{ id: string }>();
    bookId = recent?.id;
  }
  if (!bookId) return { error: "No books available" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const reader = cleanReader(args.reader);
  const progress = await readProgress(db, bookId);
  const page = Math.min(Math.max(1, progress[reader]), Math.max(1, book.total_pages));
  if (page >= book.total_pages && readString(args.afterComplete) !== "read-final") {
    return { bookId, completed: true, progress, message: `${book.title} is complete for ${reader}.` };
  }
  return readChunk(db, { bookId, page });
}

async function searchChunks(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  const query = readString(args.query);
  if (!bookId || !query) return { error: "bookId and query are required" };
  const limit = Math.min(Math.max(Math.floor(readNumber(args.limit, 10)), 1), 50);
  const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db.prepare(
    "SELECT page, content FROM book_pages WHERE book_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY page ASC LIMIT ?"
  ).bind(bookId, like, limit).all<{ page: number; content: string }>();
  const results = (rows.results ?? []).map((row) => {
    const index = row.content.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, index - 80);
    const end = Math.min(row.content.length, (index >= 0 ? index : 0) + query.length + 120);
    return { bookId, chunkId: chunkIdForPage(row.page), page: row.page, snippet: row.content.slice(start, end) };
  });
  return { bookId, query, results };
}

async function annotatePassage(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  const note = readString(args.note) || readString(args.content);
  if (!bookId || !note) return { error: "bookId and note are required" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const page = Math.min(pageFromChunkId(args.chunkId ?? args.chunk_id ?? args.page), Math.max(1, book.total_pages));
  const chunkId = chunkIdForPage(page);
  const quote = readString(args.quote) || "";
  const content = quote ? await getPageContent(db, bookId, page) : "";
  const offset = quote && content ? content.indexOf(quote) : -1;
  const createdAt = nowIso();
  const row = {
    id: newId("ann"),
    bookId,
    chunkId,
    page,
    quote,
    quoteOffset: offset >= 0 ? offset : null,
    note,
    author: cleanAuthor(args.author),
    kind: cleanKind(args.kind),
    mood: readString(args.mood) || null,
    tags: tagsToJson(args.tags),
    status: cleanStatus(args.status),
    parentId: readString(args.parentId) || readString(args.parent_id) || null,
    createdAt
  };
  await db.prepare(
    `INSERT INTO book_annotations
      (id, book_id, chunk_id, page, quote, quote_offset, note, author, kind, mood, tags, status, parent_id, created_at, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).bind(row.id, row.bookId, row.chunkId, row.page, row.quote, row.quoteOffset, row.note, row.author, row.kind, row.mood, row.tags, row.status, row.parentId, row.createdAt).run();
  return { success: true, annotation: row, message: `Saved annotation on ${chunkId}.` };
}

async function listAnnotations(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) return { error: "bookId is required" };
  const binds: unknown[] = [bookId];
  let where = "WHERE book_id = ?";
  const chunkId = readString(args.chunkId) || readString(args.chunk_id);
  if (chunkId) {
    where += " AND chunk_id = ?";
    binds.push(chunkId);
  }
  for (const [field, column] of [["kind", "kind"], ["status", "status"], ["author", "author"]] as const) {
    const value = readString(args[field]);
    if (value) {
      where += ` AND ${column} = ?`;
      binds.push(value);
    }
  }
  const rows = await db.prepare(`SELECT * FROM book_annotations ${where} ORDER BY created_at ASC`).bind(...binds).all<AnnotationRow>();
  return { bookId, annotations: (rows.results ?? []).map(toAnnotation) };
}

async function submitUserNotes(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  const sessionId = readString(args.sessionId) || readString(args.session_id);
  if (!bookId || !sessionId) return { error: "bookId and sessionId are required" };
  const mode = cleanContextMode(args.contextMode ?? args.context_mode);
  const forceChunkContext = args.forceChunkContext === true || args.force_chunk_context === true;
  const rows = await db.prepare(
    "SELECT * FROM book_annotations WHERE book_id = ? AND status = 'open' AND author IN ('user', 'layla') ORDER BY created_at ASC"
  ).bind(bookId).all<AnnotationRow>();
  const notes = rows.results ?? [];
  const submittedAt = nowIso();
  const contextChunks = [];
  const omittedChunks = [];
  const seen = new Set<string>();

  for (const note of notes) {
    if (seen.has(note.chunk_id) || mode === "notes-only") continue;
    seen.add(note.chunk_id);
    const alreadySent = await db.prepare(
      "SELECT 1 FROM reading_session_chunks WHERE session_id = ? AND book_id = ? AND chunk_id = ?"
    ).bind(sessionId, bookId, note.chunk_id).first();
    if (!forceChunkContext && mode === "chunk-once-per-session" && alreadySent) {
      omittedChunks.push({ bookId, chunkId: note.chunk_id, reason: "already-sent-in-session" });
      continue;
    }
    const text = await getPageContent(db, bookId, note.page);
    contextChunks.push({ bookId, chunkId: note.chunk_id, page: note.page, text });
    await db.prepare(
      "INSERT OR REPLACE INTO reading_session_chunks (session_id, book_id, chunk_id, sent_at, context_mode) VALUES (?, ?, ?, ?, ?)"
    ).bind(sessionId, bookId, note.chunk_id, submittedAt, mode).run();
  }

  if (notes.length > 0) {
    await db.prepare(
      `UPDATE book_annotations
       SET status = 'submitted', submitted_at = ?
       WHERE book_id = ? AND status = 'open' AND author IN ('user', 'layla')`
    ).bind(submittedAt, bookId).run();
  }

  return {
    bookId,
    sessionId,
    submitted: notes.map(toAnnotation),
    context: { mode, chunks: contextChunks, omittedChunks }
  };
}

async function replyToAnnotation(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parentId = readString(args.parentId) || readString(args.parent_id);
  const note = readString(args.note) || readString(args.content);
  if (!parentId || !note) return { error: "parentId and note are required" };
  const parent = await db.prepare("SELECT * FROM book_annotations WHERE id = ?").bind(parentId).first<AnnotationRow>();
  if (!parent) return { error: "Parent annotation not found" };
  return annotatePassage(db, {
    bookId: parent.book_id,
    chunkId: parent.chunk_id,
    quote: readString(args.quote) || parent.quote || "",
    note,
    author: "claude",
    kind: readString(args.kind) || "reply",
    mood: args.mood,
    tags: args.tags,
    status: "published",
    parentId
  });
}

async function markRead(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) return { error: "bookId is required" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const reader = cleanReader(args.reader);
  const page = Math.min(pageFromChunkId(args.chunkId ?? args.chunk_id ?? args.page), Math.max(1, book.total_pages));
  const complete = page >= book.total_pages;
  const nextPage = complete ? page : page + 1;
  const progress = await saveProgress(db, bookId, reader, nextPage);
  const annotationCount = await db.prepare("SELECT COUNT(*) AS count FROM book_annotations WHERE book_id = ?").bind(bookId).first<{ count: number }>();
  return {
    bookId,
    chunkId: chunkIdForPage(page),
    chunksRead: complete ? book.total_pages : nextPage - 1,
    chunkCount: book.total_pages,
    complete,
    progress,
    message: complete ? `${book.title} is complete: ${book.total_pages}/${book.total_pages} chunks.` : `Marked ${chunkIdForPage(page)} read.`,
    finish: complete ? {
      annotationCount: annotationCount?.count ?? 0,
      celebration: {
        title: "Book finished, margins preserved.",
        line: "The reading is done; the conversation can keep unfolding from any note.",
        prompt: "Write a short closing note that feels like placing a bookmark after the final page."
      }
    } : null
  };
}

async function getProgress(db: D1Database, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bookId = readString(args.bookId) || readString(args.book_id);
  if (!bookId) return { error: "bookId is required" };
  const book = await getBook(db, bookId);
  if (!book) return { error: "Book not found" };
  const progress = await readProgress(db, bookId);
  return {
    bookId,
    chunkCount: book.total_pages,
    progress,
    readers: Object.fromEntries(Object.entries(progress).map(([reader, page]) => [reader, {
      lastChunkId: chunkIdForPage(Math.min(page, book.total_pages)),
      chunksRead: Math.max(0, Math.min(page - 1, book.total_pages)),
      complete: page >= book.total_pages
    }]))
  };
}

export function getReadingTools(): Array<Record<string, unknown>> {
  const bookSchema = {
    type: "object",
    properties: {
      bookId: { type: "string" },
      book_id: { type: "string" },
      reader: { type: "string", enum: ["layla", "kld"] }
    }
  };
  const chunkSchema = {
    type: "object",
    properties: {
      bookId: { type: "string" },
      book_id: { type: "string" },
      chunkId: { type: "string" },
      chunk_id: { type: "string" },
      page: { type: "number", minimum: 1 }
    },
    required: ["bookId"]
  };
  return [
    { name: "reading_list_books", description: "List shared-reading books with progress and annotation counts.", inputSchema: { type: "object", properties: {} } },
    { name: "reading_list_chunks", description: "List page-backed reading chunks with prev/next ids.", inputSchema: bookSchema },
    { name: "reading_read_chunk", description: "Read one page-backed chunk with annotations.", inputSchema: chunkSchema },
    { name: "reading_continue", description: "Continue the most recent or selected book.", inputSchema: bookSchema },
    { name: "reading_search_chunks", description: "Search text inside a shared-reading book.", inputSchema: { type: "object", properties: { ...bookSchema.properties, query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } }, required: ["bookId", "query"] } },
    { name: "reading_annotate_passage", description: "Save an anchored margin annotation.", inputSchema: { type: "object", properties: { ...chunkSchema.properties, quote: { type: "string" }, note: { type: "string" }, author: { type: "string" }, kind: { type: "string" }, mood: { type: "string" }, tags: { type: "array", items: { type: "string" } }, status: { type: "string" }, parentId: { type: "string" } }, required: ["bookId", "note"] } },
    { name: "reading_list_annotations", description: "List margin annotations for a book or chunk.", inputSchema: { type: "object", properties: { ...chunkSchema.properties, kind: { type: "string" }, status: { type: "string" }, author: { type: "string" } }, required: ["bookId"] } },
    { name: "reading_submit_user_notes", description: "Submit open user notes once and include chunk context by session policy.", inputSchema: { type: "object", properties: { ...bookSchema.properties, sessionId: { type: "string" }, contextMode: { type: "string" }, forceChunkContext: { type: "boolean" } }, required: ["bookId", "sessionId"] } },
    { name: "reading_reply_to_annotation", description: "Save a Claude reply under an existing annotation.", inputSchema: { type: "object", properties: { parentId: { type: "string" }, note: { type: "string" }, kind: { type: "string" }, mood: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["parentId", "note"] } },
    { name: "reading_mark_read", description: "Mark one chunk read and advance progress.", inputSchema: { type: "object", properties: { ...chunkSchema.properties, reader: { type: "string", enum: ["layla", "kld"] } }, required: ["bookId", "chunkId"] } },
    { name: "reading_get_progress", description: "Get shared-reading progress for a book.", inputSchema: bookSchema }
  ];
}

export async function handleReadingTool(db: D1Database, name: unknown, args: Record<string, unknown>): Promise<ReadingToolResult> {
  if (typeof name !== "string" || !name.startsWith("reading_")) return { handled: false };
  await ensureReadingSchema(db);
  try {
    if (name === "reading_list_books") return { handled: true, data: await listBooks(db) };
    if (name === "reading_list_chunks") return { handled: true, data: await listChunks(db, args) };
    if (name === "reading_read_chunk") return { handled: true, data: await readChunk(db, args) };
    if (name === "reading_continue") return { handled: true, data: await continueReading(db, args) };
    if (name === "reading_search_chunks") return { handled: true, data: await searchChunks(db, args) };
    if (name === "reading_annotate_passage") return { handled: true, data: await annotatePassage(db, args) };
    if (name === "reading_list_annotations") return { handled: true, data: await listAnnotations(db, args) };
    if (name === "reading_submit_user_notes") return { handled: true, data: await submitUserNotes(db, args) };
    if (name === "reading_reply_to_annotation") return { handled: true, data: await replyToAnnotation(db, args) };
    if (name === "reading_mark_read") return { handled: true, data: await markRead(db, args) };
    if (name === "reading_get_progress") return { handled: true, data: await getProgress(db, args) };
    return { handled: true, error: `Unknown reading tool: ${name}` };
  } catch (error) {
    return { handled: true, error: error instanceof Error ? error.message : String(error) };
  }
}
