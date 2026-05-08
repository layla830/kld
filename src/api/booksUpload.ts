import { isAuthorized, unauthorized } from "./adminBoard/auth";
import type { Env } from "../types";
import { json } from "../utils/json";

interface UploadBody {
  title?: string;
  author?: string;
  content?: string;
  page_size?: number;
}

interface UploadedFileLike {
  name: string;
  text(): Promise<string>;
}

const DEFAULT_PAGE_SIZE = 800;
const MIN_PAGE_SIZE = 400;
const MAX_PAGE_SIZE = 3000;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sanitizeTitle(value: unknown, fallback: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  return title || fallback;
}

function isUploadedFile(value: unknown): value is UploadedFileLike {
  return typeof value !== "string" && value !== null && typeof value === "object" && typeof (value as UploadedFileLike).text === "function";
}

function splitPages(text: string, pageSize: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  const max = Math.min(Math.max(Math.floor(pageSize || DEFAULT_PAGE_SIZE), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const pages: string[] = [];
  let current = "";

  for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
    if (paragraph.length > max) {
      if (current) {
        pages.push(current.trim());
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += max) {
        pages.push(paragraph.slice(i, i + max).trim());
      }
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > max && current) {
      pages.push(current.trim());
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current.trim()) pages.push(current.trim());
  return pages;
}

async function ensureBooksSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, total_pages INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS book_pages (book_id TEXT NOT NULL, page INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (book_id, page))"),
    db.prepare("CREATE TABLE IF NOT EXISTS book_progress (book_id TEXT NOT NULL, reader TEXT NOT NULL, page INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (book_id, reader))"),
    db.prepare("CREATE TABLE IF NOT EXISTS book_comments (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, page INTEGER NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_book_comments_page ON book_comments(book_id, page, created_at)")
  ]);
}

async function readUploadBody(request: Request): Promise<UploadBody> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const textFile = isUploadedFile(file) ? file : null;
    const content = textFile ? await textFile.text() : String(form.get("content") || "");
    const fallbackTitle = textFile ? textFile.name.replace(/\.[^.]+$/, "") : "未命名的书";
    return {
      title: sanitizeTitle(form.get("title"), fallbackTitle),
      author: typeof form.get("author") === "string" ? String(form.get("author")).trim() : "",
      content,
      page_size: Number(form.get("page_size") || DEFAULT_PAGE_SIZE)
    };
  }

  const body = await request.json().catch(() => null) as UploadBody | null;
  return body || {};
}

async function uploadBook(request: Request, env: Env): Promise<Response> {
  await ensureBooksSchema(env.DB);
  const body = await readUploadBody(request);
  const title = sanitizeTitle(body.title, "未命名的书");
  const author = typeof body.author === "string" ? body.author.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const pages = splitPages(content, Number(body.page_size || DEFAULT_PAGE_SIZE));
  if (pages.length === 0) return json({ error: "没有可导入的文本" }, { status: 400 });
  if (pages.length > 1200) return json({ error: "文本太长，请先拆成几本上传" }, { status: 400 });

  const id = newId("book");
  const createdAt = nowIso();
  await env.DB.prepare(
    "INSERT INTO books (id, title, author, total_pages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, title, author, pages.length, createdAt, createdAt).run();

  for (let i = 0; i < pages.length; i += 1) {
    await env.DB.prepare("INSERT INTO book_pages (book_id, page, content) VALUES (?, ?, ?)").bind(id, i + 1, pages[i]).run();
  }

  for (const reader of ["layla", "kld"] as const) {
    await env.DB.prepare(
      "INSERT INTO book_progress (book_id, reader, page, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(id, reader, 1, createdAt).run();
  }

  return json({ success: true, book: { id, title, author, total_pages: pages.length, created_at: createdAt } });
}

const UPLOAD_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>上传共读书</title><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#e8a0b0;--pink-dark:#d4899a;--text:#5c4a4f;--text-light:#9a8389;--white:#fffbfc;--shadow:rgba(232,160,176,.2)}html{min-height:100vh;background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%)}body{font-family:'Noto Serif SC',Georgia,serif;color:var(--text);min-height:100vh;padding:24px 16px 56px}.page{max-width:560px;margin:0 auto}header{text-align:center;padding:26px 0 22px}.heart{font-size:1.7rem;margin-bottom:10px}h1{font-size:1.2rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}.subtitle{font-size:.7rem;color:var(--text-light);letter-spacing:2px}.card{background:var(--white);border-radius:16px;padding:18px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.18)}label{display:block;font-size:.78rem;color:var(--pink-dark);margin:14px 0 7px}input,textarea{width:100%;border:1px solid rgba(232,160,176,.45);border-radius:14px;background:white;color:var(--text);font-family:inherit;font-size:.9rem;outline:none;padding:10px 12px}textarea{min-height:180px;resize:vertical;line-height:1.65}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:16px}.btn{border:1px solid var(--pink-dark);background:white;color:var(--pink-dark);border-radius:999px;padding:8px 15px;font-family:inherit;cursor:pointer}.primary{background:linear-gradient(135deg,var(--pink),var(--pink-dark));border:none;color:white}.status{font-size:.8rem;color:var(--text-light);line-height:1.6;margin-top:12px}.hidden{display:none}
</style></head><body><main class="page"><header><div class="heart">♡</div><h1>上传共读书</h1><div class="subtitle">READING HOME</div></header><section class="card"><form id="form"><label>书名</label><input id="title" name="title" placeholder="不填会用文件名"><label>作者</label><input id="author" name="author" placeholder="可不填"><label>文本文件</label><input id="file" name="file" type="file" accept=".txt,text/plain"><label>或者直接粘贴文本</label><textarea id="content" name="content" placeholder="把正文粘到这里"></textarea><label>每页大约字数</label><input id="pageSize" name="page_size" type="number" min="400" max="3000" value="800"><div class="row"><button class="btn" type="button" onclick="location.href='/books'">返回</button><button class="btn primary" type="submit">上传</button></div><div class="status" id="status"></div></form></section></main><script>
var form=document.getElementById('form'),statusEl=document.getElementById('status');
form.addEventListener('submit',async function(event){event.preventDefault();statusEl.textContent='上传中...';var fd=new FormData();fd.set('title',document.getElementById('title').value);fd.set('author',document.getElementById('author').value);fd.set('page_size',document.getElementById('pageSize').value);var file=document.getElementById('file').files[0];if(file)fd.set('file',file);fd.set('content',document.getElementById('content').value);try{var res=await fetch('/books/api/upload',{method:'POST',body:fd});var data=await res.json();if(!res.ok)throw new Error(data.error||'上传失败');statusEl.textContent='上传好了，共 '+data.book.total_pages+' 页。正在回书架...';setTimeout(function(){location.href='/books';},800);}catch(e){statusEl.textContent='上传失败：'+e.message;}});
</script></body></html>`;

export async function handleBooksUpload(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/books/upload") {
    return new Response(UPLOAD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (request.method === "POST" && url.pathname === "/books/api/upload") {
    return uploadBook(request, env);
  }
  return json({ error: "Not found" }, { status: 404 });
}
