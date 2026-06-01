export async function ensureBooksSchema(db: D1Database): Promise<void> {
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
