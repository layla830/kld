import { isAuthorized, unauthorized } from "./adminBoard/auth";
import type { Env } from "../types";

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
:root{
  --pink:#e8a0b0;
  --pink-dark:#d4899a;
  --pink-light:#fff0f3;
  --blue:#8fa8c0;
  --text:#5c4a4f;
  --text-light:#9a8389;
  --white:#fffbfc;
  --line:rgba(232,160,176,.2);
  --shadow:rgba(232,160,176,.18);
}
html{min-height:100vh;background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%)}
body{min-height:100vh;padding:24px 16px 56px;color:var(--text);font-family:"Noto Serif SC",Georgia,serif}
button,input,textarea{font:inherit}
button{cursor:pointer}
.page{max-width:620px;margin:0 auto}
.page-header{text-align:center;padding:28px 0 22px}
.heart{font-size:1.7rem;margin-bottom:10px}
h1{font-size:1.25rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}
.subtitle{font-size:.7rem;color:var(--text-light);letter-spacing:2px}
.card,.book-item,.content-panel{background:var(--white);border:1px solid var(--line);border-radius:16px;box-shadow:0 4px 20px var(--shadow)}
.book-item{padding:18px;margin-bottom:14px;cursor:pointer}
.book-title{font-size:.96rem;margin-bottom:8px}
.book-meta,.muted{font-size:.74rem;color:var(--text-light)}
.book-actions{display:flex;justify-content:flex-end;margin-top:10px}
.progress-bar{height:5px;margin-top:8px;border-radius:4px;overflow:hidden;background:var(--pink-light)}
.progress-fill{height:100%;border-radius:4px}
.progress-fill.layla{background:var(--pink)}
.progress-fill.kld{background:var(--blue)}
.progress-labels{display:flex;justify-content:space-between;margin-top:5px;font-size:.65rem;color:var(--text-light)}
.reader{display:none}
.reader.active{display:block}
.top-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.title{flex:1;text-align:center;color:var(--pink-dark);font-size:.9rem;min-width:0}
.icon-btn,.btn,.text-btn{border:1px solid var(--pink);background:var(--white);color:var(--pink-dark);border-radius:999px;padding:7px 13px}
.btn{background:linear-gradient(135deg,var(--pink),var(--pink-dark));border:none;color:white}
.text-btn{border:0;background:transparent;color:var(--text-light);font-size:.72rem;padding:4px 0}
.text-btn:hover{color:var(--pink-dark)}
.reader-switch,.tools-row{display:flex;gap:8px;margin-bottom:12px}
.reader-switch button,.tools-row button{flex:1}
.reader-switch .active{background:var(--pink);color:white}
.search-row{display:flex;gap:8px;margin-bottom:12px}
.search-row input{flex:1;min-width:0}
input,textarea{width:100%;border:1px solid rgba(232,160,176,.45);border-radius:14px;background:white;color:var(--text);outline:none;padding:9px 11px}
.content-panel{white-space:pre-wrap;line-height:1.85;font-size:.92rem;min-height:320px;padding:22px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0}
.page-info{display:flex;align-items:center;gap:6px;font-size:.76rem;color:var(--text-light)}
.jump-input{width:62px;text-align:center;border-radius:999px;padding:6px 4px}
.section{margin-top:18px}
.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:var(--text-light);font-size:.74rem}
.annotation,.comment,.search-result{display:block;width:100%;text-align:left;padding:12px;margin-bottom:10px;background:rgba(255,251,252,.72);border:1px solid var(--line);border-radius:12px;color:var(--text)}
.annotation.reply{margin-left:18px;border-color:rgba(143,168,192,.35)}
.annotation-meta,.comment-author{font-size:.7rem;color:var(--pink-dark);margin-bottom:5px}
.annotation-note,.comment-content,.search-snippet{white-space:pre-wrap;line-height:1.65;font-size:.84rem}
.annotation-quote{margin-bottom:7px;color:var(--text-light);font-size:.78rem;line-height:1.55}
.comment-time{margin-top:6px;font-size:.62rem;color:var(--text-light)}
.composer{padding:14px;margin-top:10px}
.composer textarea{min-height:78px;border:none;border-bottom:1px dashed var(--pink);border-radius:0;background:transparent;resize:vertical;line-height:1.7;padding:8px 0}
.composer-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.status{margin-top:8px;color:var(--text-light);font-size:.74rem;line-height:1.6}
.empty{text-align:center;color:var(--text-light);font-size:.82rem;padding:28px 0}
@media(max-width:440px){
  body{padding:18px 12px}
  .content-panel{font-size:.9rem;padding:18px}
  .top-row{gap:6px}
  .icon-btn,.btn{padding:7px 10px}
}
`;

const SCRIPT = `
var state = {
  bookId: "",
  page: 1,
  totalPages: 1,
  reader: "layla",
  sessionId: "reading-ui-" + new Date().toISOString().slice(0, 10)
};

function byId(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

async function api(path, options) {
  var response = await fetch(path, options);
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function postJson(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function chunkId() {
  return "p" + state.page;
}

function renderProgressBar(book, reader) {
  var page = book.progress && book.progress[reader] ? book.progress[reader] : 1;
  var percent = Math.round((page / Math.max(1, book.total_pages)) * 100);
  return '<div class="progress-bar"><div class="progress-fill ' + reader + '" style="width:' + percent + '%"></div></div>';
}

function bindShelf() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-book-id]"), function (card) {
    card.addEventListener("click", function () {
      openBook(card.getAttribute("data-book-id") || "");
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-delete-book-id]"), function (button) {
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      deleteBook(button.getAttribute("data-delete-book-id") || "");
    });
  });
}

async function loadBooks() {
  var data = await api("/books/api/list");
  var shelf = byId("shelf");
  if (!data.books.length) {
    shelf.innerHTML = '<div class="card empty">书架空空如也</div>';
    return;
  }
  shelf.innerHTML = data.books.map(function (book) {
    var laylaPage = book.progress && book.progress.layla ? book.progress.layla : 1;
    var kldPage = book.progress && book.progress.kld ? book.progress.kld : 1;
    return [
      '<article class="book-item" data-book-id="' + esc(book.id) + '">',
      '<div class="book-title">' + esc(book.title) + '</div>',
      '<div class="book-meta">共 ' + book.total_pages + ' 页</div>',
      renderProgressBar(book, "layla"),
      renderProgressBar(book, "kld"),
      '<div class="progress-labels"><span>Layla ' + laylaPage + ' 页</span><span>KLD ' + kldPage + ' 页</span></div>',
      '<div class="book-actions"><button class="text-btn" type="button" data-delete-book-id="' + esc(book.id) + '">删除</button></div>',
      '</article>'
    ].join("");
  }).join("");
  bindShelf();
}

async function deleteBook(id) {
  if (!id || !confirm("确定删掉这本书吗？正文、进度和批注都会一起删除。")) return;
  await postJson("/books/api/delete", { book_id: id });
  await loadBooks();
}

function setReader(reader) {
  state.reader = reader;
  byId("readerLayla").classList.toggle("active", reader === "layla");
  byId("readerKld").classList.toggle("active", reader === "kld");
}

async function openBook(id) {
  state.bookId = id;
  var data = await api("/books/api/page?book_id=" + encodeURIComponent(id) + "&page=1");
  state.page = data.progress && data.progress[state.reader] ? data.progress[state.reader] : 1;
  state.totalPages = data.total_pages;
  byId("shelf").style.display = "none";
  byId("reader").classList.add("active");
  await loadPage();
}

function closeReader() {
  byId("reader").classList.remove("active");
  byId("shelf").style.display = "block";
  loadBooks();
}

async function loadPage() {
  var data = await api("/books/api/page?book_id=" + encodeURIComponent(state.bookId) + "&page=" + state.page);
  state.page = data.page;
  state.totalPages = data.total_pages;
  byId("readerTitle").textContent = data.title;
  byId("content").textContent = data.content;
  byId("pageJump").value = String(data.page);
  byId("pageJump").max = String(data.total_pages);
  byId("totalPages").textContent = data.total_pages;
  byId("prevBtn").disabled = state.page <= 1;
  byId("nextBtn").disabled = state.page >= state.totalPages;
  renderComments(data.comments || []);
  await loadAnnotations();
  await postJson("/books/api/progress", { book_id: state.bookId, reader: state.reader, page: state.page });
}

async function changePage(delta) {
  var next = state.page + delta;
  if (next < 1 || next > state.totalPages) return;
  state.page = next;
  await loadPage();
}

async function jumpPage() {
  var next = parseInt(byId("pageJump").value, 10);
  if (!Number.isFinite(next)) return;
  state.page = Math.max(1, Math.min(state.totalPages, next));
  await loadPage();
}

async function markReadAndNext() {
  await postJson("/books/api/mark-read", {
    bookId: state.bookId,
    chunkId: chunkId(),
    reader: state.reader
  });
  if (state.page < state.totalPages) {
    state.page += 1;
    await loadPage();
  }
}

function renderComments(comments) {
  var list = byId("commentsList");
  if (!comments.length) {
    list.innerHTML = '<div class="empty">这一页还没有旧批注</div>';
    return;
  }
  list.innerHTML = comments.map(function (comment) {
    return [
      '<div class="comment">',
      '<div class="comment-author">' + (comment.author === "kld" ? "KLD" : "Layla") + '</div>',
      '<div class="comment-content">' + esc(comment.content) + '</div>',
      '<div class="comment-time">' + new Date(comment.time).toLocaleString("zh-CN") + '</div>',
      '</div>'
    ].join("");
  }).join("");
}

async function addComment() {
  var input = byId("commentInput");
  var content = input.value.trim();
  if (!content) return;
  await postJson("/books/api/comments", {
    book_id: state.bookId,
    page: state.page,
    author: state.reader,
    content: content
  });
  input.value = "";
  await loadPage();
}

function annotationLabel(annotation) {
  var author = annotation.author === "claude" || annotation.author === "kld" ? "KLD" : "Layla";
  return author + " · " + (annotation.kind || "annotation") + " · " + (annotation.status || "published");
}

function renderAnnotation(annotation, replies) {
  var replyHtml = (replies[annotation.id] || []).map(function (reply) {
    return renderAnnotation(reply, replies);
  }).join("");
  return [
    '<article class="annotation ' + (annotation.parentId ? "reply" : "") + '">',
    '<div class="annotation-meta">' + esc(annotationLabel(annotation)) + '</div>',
    annotation.quote ? '<div class="annotation-quote">“' + esc(annotation.quote) + '”</div>' : '',
    '<div class="annotation-note">' + esc(annotation.note) + '</div>',
    '<div class="composer-actions"><button class="text-btn" type="button" data-reply-id="' + esc(annotation.id) + '">回复</button></div>',
    '</article>',
    replyHtml
  ].join("");
}

function bindAnnotationReplies() {
  Array.prototype.forEach.call(document.querySelectorAll("[data-reply-id]"), function (button) {
    button.addEventListener("click", async function () {
      var note = prompt("写一句回复：");
      if (!note || !note.trim()) return;
      await postJson("/books/api/replies", { parentId: button.getAttribute("data-reply-id"), note: note.trim() });
      await loadAnnotations();
    });
  });
}

async function loadAnnotations() {
  var data = await api("/books/api/annotations?bookId=" + encodeURIComponent(state.bookId) + "&chunkId=" + chunkId());
  var annotations = data.annotations || [];
  var roots = [];
  var replies = {};
  annotations.forEach(function (annotation) {
    if (annotation.parentId) {
      if (!replies[annotation.parentId]) replies[annotation.parentId] = [];
      replies[annotation.parentId].push(annotation);
    } else {
      roots.push(annotation);
    }
  });
  byId("annotationsList").innerHTML = roots.length
    ? roots.map(function (annotation) { return renderAnnotation(annotation, replies); }).join("")
    : '<div class="empty">这一页还没有新批注</div>';
  bindAnnotationReplies();
}

async function saveAnnotation(status) {
  var input = byId("annotationInput");
  var note = input.value.trim();
  if (!note) return;
  var selection = String(window.getSelection ? window.getSelection() : "").trim();
  await postJson("/books/api/annotations", {
    bookId: state.bookId,
    chunkId: chunkId(),
    page: state.page,
    quote: selection,
    note: note,
    author: status === "open" ? "user" : state.reader,
    kind: status === "open" ? "question" : "annotation",
    status: status
  });
  input.value = "";
  await loadAnnotations();
}

async function submitNotes() {
  var data = await postJson("/books/api/submit-notes", {
    bookId: state.bookId,
    sessionId: state.sessionId,
    contextMode: "chunk-once-per-session"
  });
  var count = data.submitted ? data.submitted.length : 0;
  byId("annotationStatus").textContent = count ? "已发送 " + count + " 条开放笔记给 KLD。" : "没有待发送的开放笔记。";
  await loadAnnotations();
}

async function searchBook() {
  var query = byId("searchInput").value.trim();
  if (!query) return;
  var data = await api("/books/api/search?bookId=" + encodeURIComponent(state.bookId) + "&query=" + encodeURIComponent(query));
  var results = data.results || [];
  byId("searchResults").innerHTML = results.length
    ? results.map(function (item) {
      return '<button class="search-result" type="button" data-search-page="' + item.page + '"><div class="annotation-meta">第 ' + item.page + ' 页</div><div class="search-snippet">' + esc(item.snippet) + '</div></button>';
    }).join("")
    : '<div class="empty">没有搜到</div>';
  Array.prototype.forEach.call(document.querySelectorAll("[data-search-page]"), function (button) {
    button.addEventListener("click", async function () {
      state.page = parseInt(button.getAttribute("data-search-page") || "1", 10);
      await loadPage();
      byId("searchResults").innerHTML = "";
    });
  });
}

loadBooks().catch(function (error) {
  byId("shelf").innerHTML = '<div class="card empty">加载失败：' + esc(error.message) + '</div>';
});
`;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>共读小屋</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="page">
    <header class="page-header">
      <div class="heart">♡</div>
      <h1>我们的共读小屋</h1>
      <div class="subtitle">READING HOME</div>
    </header>

    <section id="shelf"></section>

    <section id="reader" class="reader">
      <div class="top-row">
        <button class="icon-btn" type="button" onclick="closeReader()">返回</button>
        <div class="title" id="readerTitle"></div>
        <button class="icon-btn" type="button" onclick="loadPage()">刷新</button>
      </div>

      <div class="reader-switch">
        <button id="readerLayla" class="icon-btn active" type="button" onclick="setReader('layla')">Layla</button>
        <button id="readerKld" class="icon-btn" type="button" onclick="setReader('kld')">KLD</button>
      </div>

      <div class="search-row">
        <input id="searchInput" placeholder="搜这本书里的句子或词">
        <button class="icon-btn" type="button" onclick="searchBook()">搜索</button>
      </div>
      <div id="searchResults"></div>

      <div class="content-panel" id="content"></div>

      <div class="pager">
        <button class="icon-btn" id="prevBtn" type="button" onclick="changePage(-1)">上一页</button>
        <span class="page-info"><input class="jump-input" id="pageJump" type="number" min="1" value="1" onkeydown="if(event.key==='Enter')jumpPage()"> / <span id="totalPages">1</span></span>
        <button class="icon-btn" id="nextBtn" type="button" onclick="changePage(1)">下一页</button>
      </div>

      <div class="tools-row">
        <button class="icon-btn" type="button" onclick="jumpPage()">跳转</button>
        <button class="icon-btn" type="button" onclick="markReadAndNext()">读完本页</button>
      </div>

      <section class="section">
        <div class="section-title">
          <span>新批注</span>
          <button class="text-btn" type="button" onclick="submitNotes()">发送开放笔记给 KLD</button>
        </div>
        <div id="annotationsList"></div>
        <div class="card composer">
          <textarea id="annotationInput" placeholder="选中正文里的句子后，可以把这一页的想法存在边注里..."></textarea>
          <div class="composer-actions">
            <button class="icon-btn" type="button" onclick="saveAnnotation('open')">先存给我</button>
            <button class="btn" type="button" onclick="saveAnnotation('published')">保存批注</button>
          </div>
          <div class="status" id="annotationStatus"></div>
        </div>
      </section>

      <section class="section">
        <div class="section-title"><span>旧批注</span></div>
        <div id="commentsList"></div>
        <div class="card composer">
          <textarea id="commentInput" placeholder="保留旧评论入口，方便兼容以前的数据..."></textarea>
          <div class="composer-actions"><button class="btn" type="button" onclick="addComment()">保存旧评论</button></div>
        </div>
      </section>
    </section>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;

export function handleBooksReaderPage(request: Request, env: Env): Response {
  if (!isAuthorized(request, env)) return unauthorized();
  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
