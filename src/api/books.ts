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

const BOOKS_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>共读小屋</title><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#e8a0b0;--pink-dark:#d4899a;--pink-light:#fff0f3;--blue:#8fa8c0;--text:#5c4a4f;--text-light:#9a8389;--white:#fffbfc;--shadow:rgba(232,160,176,.2)}html{background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%);min-height:100vh}body{font-family:'Noto Serif SC',Georgia,serif;color:var(--text);min-height:100vh;padding:24px 16px 56px}.page{max-width:560px;margin:0 auto}header{text-align:center;padding:28px 0 22px}.heart{font-size:1.7rem;margin-bottom:10px}h1{font-size:1.25rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}.subtitle{font-size:.7rem;color:var(--text-light);letter-spacing:2px}.card,.book-item{background:var(--white);border-radius:16px;padding:18px;margin-bottom:14px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.18)}.book-item{cursor:pointer}.book-title{font-size:.95rem;margin-bottom:8px}.book-meta,.muted{font-size:.72rem;color:var(--text-light)}.progress-bar{height:5px;background:var(--pink-light);border-radius:4px;overflow:hidden;margin-top:8px}.progress-fill{height:100%;border-radius:4px}.layla{background:var(--pink)}.kld{background:var(--blue)}.progress-labels{display:flex;justify-content:space-between;margin-top:5px;font-size:.65rem;color:var(--text-light)}.reader{display:none}.reader.active{display:block}.top-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}.icon-btn,.btn{border:1px solid var(--pink);background:var(--white);color:var(--pink-dark);border-radius:999px;padding:7px 13px;font-family:inherit;cursor:pointer}.btn{background:linear-gradient(135deg,var(--pink),var(--pink-dark));color:white;border:none}.title{flex:1;text-align:center;color:var(--pink-dark);font-size:.9rem}.reader-switch{display:flex;gap:8px;margin-bottom:12px}.reader-switch button{flex:1}.reader-switch .active{background:var(--pink);color:white}.content{white-space:pre-wrap;line-height:1.85;font-size:.92rem;background:var(--white);border-radius:16px;padding:22px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.18);min-height:320px}.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0}.page-info{font-size:.76rem;color:var(--text-light)}.comments{margin-top:18px}.comment{background:rgba(255,251,252,.72);border:1px solid rgba(232,160,176,.18);border-radius:12px;padding:12px;margin-bottom:10px}.comment-author{font-size:.7rem;color:var(--pink-dark);margin-bottom:5px}.comment-content{white-space:pre-wrap;line-height:1.65;font-size:.84rem}.comment-time{font-size:.62rem;color:var(--text-light);margin-top:6px}textarea{width:100%;min-height:74px;border:none;border-bottom:1px dashed var(--pink);background:transparent;outline:none;resize:none;font-family:inherit;font-size:.88rem;line-height:1.7;color:var(--text);padding:8px 0}.empty{text-align:center;color:var(--text-light);font-size:.82rem;padding:28px 0}@media(max-width:420px){body{padding:18px 12px}.content{font-size:.9rem;padding:18px}.card{padding:16px}}
</style></head><body><main class="page"><header><div class="heart">♡</div><h1>我们的共读小屋</h1><div class="subtitle">READING HOME</div></header><section id="shelf"></section><section id="reader" class="reader"><div class="top-row"><button class="icon-btn" onclick="closeReader()">返回</button><div class="title" id="readerTitle"></div><button class="icon-btn" onclick="loadPage()">刷新</button></div><div class="reader-switch"><button id="readerLayla" class="icon-btn active" onclick="setReader('layla')">蕾拉</button><button id="readerKld" class="icon-btn" onclick="setReader('kld')">克</button></div><div class="content" id="content"></div><div class="pager"><button class="icon-btn" id="prevBtn" onclick="changePage(-1)">上一页</button><span class="page-info"><span id="currentPage">1</span> / <span id="totalPages">1</span></span><button class="icon-btn" id="nextBtn" onclick="changePage(1)">下一页</button></div><section class="comments"><div class="muted" style="margin-bottom:8px">批注</div><div id="commentsList"></div><div class="card"><textarea id="commentInput" placeholder="在这一页留一句话..."></textarea><div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn" onclick="addComment()">保存</button></div></div></section></section></main><script>
var currentBook='',currentPage=1,totalPages=1,currentReader='layla';
function esc(s){return String(s||'').replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c];});}
async function api(path,options){var res=await fetch(path,options);var data=await res.json();if(!res.ok)throw new Error(data.error||'请求失败');return data;}
async function loadBooks(){var data=await api('/books/api/list');var shelf=document.getElementById('shelf');if(!data.books.length){shelf.innerHTML='<div class="card empty">书架空空如也</div>';return;}shelf.innerHTML=data.books.map(function(book){var lp=Math.round((book.progress.layla/book.total_pages)*100);var kp=Math.round((book.progress.kld/book.total_pages)*100);return '<article class="book-item" onclick="openBook(\''+esc(book.id)+'\')"><div class="book-title">'+esc(book.title)+'</div><div class="book-meta">共 '+book.total_pages+' 页</div><div class="progress-bar"><div class="progress-fill layla" style="width:'+lp+'%"></div></div><div class="progress-bar"><div class="progress-fill kld" style="width:'+kp+'%"></div></div><div class="progress-labels"><span>蕾拉 '+book.progress.layla+'页</span><span>克 '+book.progress.kld+'页</span></div></article>';}).join('');}
function setReader(reader){currentReader=reader;document.getElementById('readerLayla').classList.toggle('active',reader==='layla');document.getElementById('readerKld').classList.toggle('active',reader==='kld');}
async function openBook(id){currentBook=id;var data=await api('/books/api/page?book_id='+encodeURIComponent(id)+'&page=1');currentPage=data.progress[currentReader]||1;totalPages=data.total_pages;document.getElementById('shelf').style.display='none';document.getElementById('reader').classList.add('active');await loadPage();}
function closeReader(){document.getElementById('reader').classList.remove('active');document.getElementById('shelf').style.display='block';loadBooks();}
async function loadPage(){var data=await api('/books/api/page?book_id='+encodeURIComponent(currentBook)+'&page='+currentPage);document.getElementById('readerTitle').textContent=data.title;document.getElementById('content').textContent=data.content;document.getElementById('currentPage').textContent=data.page;document.getElementById('totalPages').textContent=data.total_pages;currentPage=data.page;totalPages=data.total_pages;document.getElementById('prevBtn').disabled=currentPage<=1;document.getElementById('nextBtn').disabled=currentPage>=totalPages;renderComments(data.comments||[]);await api('/books/api/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({book_id:currentBook,reader:currentReader,page:currentPage})});}
async function changePage(delta){var next=currentPage+delta;if(next<1||next>totalPages)return;currentPage=next;await loadPage();}
function renderComments(comments){var list=document.getElementById('commentsList');if(!comments.length){list.innerHTML='<div class="empty">这一页还没有批注</div>';return;}list.innerHTML=comments.map(function(c){return '<div class="comment"><div class="comment-author">'+(c.author==='kld'?'克':'蕾拉')+'</div><div class="comment-content">'+esc(c.content)+'</div><div class="comment-time">'+new Date(c.time).toLocaleString('zh-CN')+'</div></div>';}).join('');}
async function addComment(){var input=document.getElementById('commentInput');var content=input.value.trim();if(!content)return;await api('/books/api/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({book_id:currentBook,page:currentPage,author:currentReader,content:content})});input.value='';await loadPage();}
loadBooks().catch(function(e){document.getElementById('shelf').innerHTML='<div class="card empty">加载失败：'+esc(e.message)+'</div>';});
</script></body></html>`;

function renderBooksPage(): Response {
  return new Response(BOOKS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function handleBooks(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/books") return renderBooksPage();
  if (request.method === "GET" && url.pathname === "/books/api/list") return listBooks(env);
  if (request.method === "GET" && url.pathname === "/books/api/page") return getBookPage(env, url);
  if (request.method === "POST" && url.pathname === "/books/api/progress") return saveProgress(env, request);
  if (request.method === "POST" && url.pathname === "/books/api/comments") return addComment(env, request);
  if (request.method === "POST" && url.pathname === "/admin/books/import") return importBooks(env, request);

  return json({ error: "Not found" }, { status: 404 });
}
