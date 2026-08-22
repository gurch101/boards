import qrcode from "qrcode-generator";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import mermaid from "mermaid";
import { Marked } from "marked";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns3, Copy, Ellipsis, Funnel, LayoutDashboard, Pencil, Plus, Search, Share2, Table2, Trash2, X, createElement } from "lucide";
import { queryCards } from "../src/query";
import { formatDateUtc } from "../src/date";

const makeIcon = (nodes, size = 18) => { const svg = createElement(nodes, { width: size, height: size, class: "icon", "aria-hidden": "true" }); return svg.outerHTML; };
const icons = {
  trash: makeIcon(Trash2), arrowDown: makeIcon(ArrowDown), arrowLeft: makeIcon(ArrowLeft), arrowRight: makeIcon(ArrowRight), arrowUp: makeIcon(ArrowUp), copy: makeIcon(Copy),
  board: makeIcon(LayoutDashboard), columns: makeIcon(Columns3), edit: makeIcon(Pencil), filter: makeIcon(Funnel), more: makeIcon(Ellipsis), plus: makeIcon(Plus),
  search: makeIcon(Search), share: makeIcon(Share2), table: makeIcon(Table2), x: makeIcon(X)
};
const iconByName = { copy: icons.copy, "layout-dashboard": icons.board, plus: icons.plus, search: icons.search, share: icons.share, trash: icons.trash, x: icons.x };
document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = iconByName[element.dataset.icon] || ""; });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const html = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const markdown = new Marked({ gfm: true, renderer: { code({ text, lang }) { const language = String(lang || "").trim().split(/\s+/)[0].toLocaleLowerCase(); if (language === "mermaid") return `<pre class="mermaid">${html(text)}</pre>`; const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value; return `<pre><code class="hljs${language ? ` language-${html(language)}` : ""}">${highlighted}</code></pre>`; } } });
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: '"SFMono-Regular", Consolas, monospace' });
const state = { capability: "", bootstrap: null, board: null, boardRequests: new Map(), cardsById: new Map(), listPages: new Map(), listQueryCounts: null, tablePage: null, tableRequest: 0, viewMode: "board", config: { search: "", columns: [], filters: [], groupBy: null, sorts: [] }, activeCardId: null, draggingCardId: null, draggingListId: null, editingTags: [], tagSuggestionIndex: 0, timer: null };
let nextOptimisticId = -1, boardMutationQueue = Promise.resolve();
function optimisticId() { return nextOptimisticId--; }
function queueBoardMutation(snapshot, mutation) {
  const operation = boardMutationQueue.catch(() => {}).then(() => mutation(snapshot.board.revision));
  boardMutationQueue = operation.catch(() => {});
  return operation;
}
const getCard = id => state.cardsById.get(Number(id)) || state.board?.cards?.find(card => card.id === Number(id));
function cacheCards(cards) { for (const card of cards || []) state.cardsById.set(card.id, card); }
const dialogs = { board: $("#board-dialog"), list: $("#list-dialog"), deleteConfirm: $("#delete-confirm-dialog"), card: $("#card-dialog"), view: $("#view-dialog"), share: $("#share-dialog") };
let pendingDeleteAction = null;
let markdownRenderVersion = 0, markdownRenderTimer = null;
$$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));

async function renderCardDescription() {
  const version = ++markdownRenderVersion, source = $("#card-description").value, preview = $("#card-description-preview");
  if (!source.trim()) { preview.innerHTML = '<p class="markdown-empty">Markdown preview will appear here.</p>'; return; }
  preview.innerHTML = DOMPurify.sanitize(String(markdown.parse(source)));
  $$("a", preview).forEach(link => { link.target = "_blank"; link.rel = "noopener noreferrer"; });
  for (const diagram of $$(".mermaid", preview)) {
    if (version !== markdownRenderVersion) return;
    try { await mermaid.run({ nodes: [diagram], suppressErrors: true }); }
    catch { if (diagram.isConnected) diagram.insertAdjacentHTML("afterend", '<p class="mermaid-error">Unable to render this Mermaid diagram.</p>'); }
  }
}
$("#card-description").oninput = () => { clearTimeout(markdownRenderTimer); markdownRenderTimer = setTimeout(renderCardDescription, 160); };
function setMarkdownMode(mode) { const workspace = $(".markdown-workspace"); workspace.dataset.mode = mode; $$('[data-markdown-mode]').forEach(button => { const active = button.dataset.markdownMode === mode; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }); if (mode !== "markdown") renderCardDescription(); }
$$('[data-markdown-mode]').forEach(button => button.onclick = () => setMarkdownMode(button.dataset.markdownMode));
$("#card-description-preview").onclick = event => { if ($(".markdown-workspace").dataset.mode !== "preview") return; event.preventDefault(); setMarkdownMode("markdown"); $("#card-description").focus(); };
new MutationObserver(() => { if (dialogs.card.open) { const card = getCard($("#card-form").cardId.value); state.editingTags = (card?.tags || []).map(tag => ({ ...tag })); $("#card-tag-input").value = ""; renderSelectedTags(); closeTagSuggestions(); setMarkdownMode(card ? "preview" : "split"); } }).observe(dialogs.card, { attributes: true, attributeFilter: ["open"] });

function toast(message, isError = false) { const el = $("#toast"); el.textContent = message; el.className = `toast show${isError ? " error" : ""}`; clearTimeout(el._timer); el._timer = setTimeout(() => el.className = "toast", 3200); }
function openDeleteConfirmation(title, message, label, action) { $("#delete-confirm-title").textContent = title; $("#delete-confirm-message").textContent = message; $("#delete-confirm-label").textContent = label; pendingDeleteAction = action; dialogs.deleteConfirm.showModal(); setTimeout(() => $("#delete-confirm-button").focus(), 0); }
$("#delete-confirm-button").onclick = async () => { const action = pendingDeleteAction; pendingDeleteAction = null; dialogs.deleteConfirm.close(); if (action) await action(); };
dialogs.deleteConfirm.addEventListener("close", () => { pendingDeleteAction = null; });
async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(state.capability ? { Authorization: `Bearer ${state.capability}` } : {}), ...(options.revision !== undefined ? { "If-Match": `"${options.revision}"` } : {}) };
  const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 412 && state.board) { toast("This board changed. Reloading the latest version.", true); await loadBoard(state.board.board.id); } throw new Error(payload.error?.message || `Request failed (${response.status})`); }
  return payload;
}
function setRoute(section, boardId) { const url = new URL(location.href); url.search = ""; if (boardId) url.searchParams.set("board", boardId); else if (section !== "boards") url.searchParams.set("section", section); history.pushState({}, "", url); route(); }
async function boot() {
  const match = /^\/p\/([A-Za-z0-9_-]{43})/.exec(location.pathname);
  if (!match) { const remembered = localStorage.getItem("boards.privatePath"); if (/^\/p\/[A-Za-z0-9_-]{43}$/.test(remembered || "")) { location.replace(remembered); return; } const created = await api("/api/spaces", { method: "POST", body: "{}" }); location.replace(created.data.path); return; }
  state.capability = match[1]; localStorage.setItem("boards.privatePath", location.pathname);
  await refreshBootstrap(); $("#loading").hidden = true; $("#shell").hidden = false; route();
}
async function refreshBootstrap() { state.bootstrap = (await api("/api/bootstrap")).data; }
async function route() { const boardId = Number(new URLSearchParams(location.search).get("board")); if (boardId) { await loadBoard(boardId); return; } renderBoards(); }

function pageHead(eyebrow, title, description, action = "") { return `<header class="page-head"><div><p class="eyebrow">${html(eyebrow)}</p><h1>${html(title)}</h1>${description ? `<p>${html(description)}</p>` : ""}</div>${action}</header>`; }
function emptyState(icon, title, copy, action) { return `<div class="empty-state"><div class="empty-icon">${icon}</div><h2>${html(title)}</h2><p>${html(copy)}</p>${action}</div>`; }

function renderBoards() {
  const boards = state.bootstrap.boards.filter(board => !board.archived_at);
  $("#app").className = "page"; $("#app").innerHTML = pageHead("Workspace", "Your boards", "", `<div class="page-actions"><button id="new-board" class="button primary">${icons.plus} New board</button></div>`) + `<div class="cards-grid">${boards.length ? boards.map(board => `<article class="board-tile${board.pending ? " pending-create" : ""}" draggable="${board.pending ? "false" : "true"}" tabindex="0" role="link" data-board-id="${board.id}" aria-label="${board.pending ? "Creating" : "Open"} ${html(board.name)}"${board.pending ? ' aria-busy="true"' : ""}><div class="tile-top"><h2>${html(board.name)}</h2>${board.pending ? '<span class="pending-label">Creating…</span>' : `<button class="icon-button delete-board" data-id="${board.id}" title="Delete board" aria-label="Delete ${html(board.name)}">${icons.trash}</button>`}</div><p>${html(board.description || "")}</p></article>`).join("") : emptyState(icons.board, "Create your first board", "Start with To do, Doing, and Done—then shape it around your work.", `<button id="empty-action" class="button primary">${icons.plus} New board</button>`)}</div>`;
  $("#new-board").onclick = () => openBoardDialog(); $("#empty-action")?.addEventListener("click", () => openBoardDialog());
  $$(".board-tile").forEach(tile => { const boardId = Number(tile.dataset.boardId), warm = () => { if (boardId > 0) requestBoard(boardId).catch(() => {}); }; tile.onpointerenter = warm; tile.onpointerdown = warm; tile.onfocus = warm; tile.onclick = event => { if (boardId > 0 && !event.target.closest(".delete-board")) setRoute("boards", boardId); }; tile.onkeydown = event => { if (boardId > 0 && (event.key === "Enter" || event.key === " ") && !event.target.closest(".delete-board")) { event.preventDefault(); setRoute("boards", boardId); } }; tile.ondragstart = event => { if (boardId < 0) { event.preventDefault(); return; } event.dataTransfer.setData("text/board-id", tile.dataset.boardId); }; tile.ondragover = event => event.preventDefault(); tile.ondrop = async event => { event.preventDefault(); const moved = Number(event.dataTransfer.getData("text/board-id")), beforeId = boardId; if (!moved || moved === beforeId || beforeId < 0) return; const board = state.bootstrap.boards.find(item => item.id === moved); try { await api(`/api/boards/${moved}/move`, { method: "POST", revision: board.revision, body: JSON.stringify({ beforeId }) }); await refreshBootstrap(); renderBoards(); } catch (error) { toast(error.message, true); } }; });
  $$(".delete-board").forEach(button => button.onclick = event => { event.stopPropagation(); const board = state.bootstrap.boards.find(item => item.id === Number(button.dataset.id)); openDeleteConfirmation("Delete board permanently?", `“${board.name}” and all of its lists and cards will be permanently deleted. This cannot be undone.`, "Delete board", async () => { try { await api(`/api/boards/${board.id}`, { method: "DELETE", revision: board.revision }); await refreshBootstrap(); renderBoards(); toast("Board deleted"); } catch (error) { toast(error.message, true); } }); });
}

function openShareDialog() {
  const shareUrl = `${location.origin}/p/${state.capability}`, qrContainer = $("#share-qr");
  $("#share-url").value = shareUrl;
  if (qrContainer.dataset.url !== shareUrl) {
    try {
      const qr = qrcode(0, "M"); qr.addData(shareUrl); qr.make();
      qrContainer.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true, title: "Private Boards space QR code", alt: "Scan to open this private Boards space on another device." });
      qrContainer.dataset.url = shareUrl;
    } catch { qrContainer.innerHTML = "<p>QR code unavailable. Use Copy link instead.</p>"; }
  }
  dialogs.share.showModal();
}
$("#copy-share-url").onclick = async () => {
  const input = $("#share-url");
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
    else { input.select(); if (!document.execCommand("copy")) throw new Error(); input.setSelectionRange(0, 0); }
    toast("Private link copied");
  } catch { input.focus(); input.select(); toast("Couldn’t copy automatically. Copy the selected link."); }
};

function openBoardDialog(board = null) { const form = $("#board-form"), editing = Boolean(board?.id); form.reset(); form.dataset.boardId = editing ? board.id : ""; form.dataset.revision = editing ? board.revision : ""; form.name.value = editing ? board.name : ""; form.description.value = editing ? board.description || "" : ""; $("#board-dialog-eyebrow").textContent = editing ? "Board settings" : "Workspace"; $("#board-dialog-title").textContent = editing ? "Rename board" : "New board"; $("#save-board").textContent = editing ? "Save changes" : "Create board"; dialogs.board.showModal(); setTimeout(() => form.name.focus(), 0); }
$("#board-form").onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, boardId = Number(form.dataset.boardId || 0), data = { name: form.name.value.trim(), description: form.description.value };
  if (boardId) { try { await api(`/api/boards/${boardId}`, { method: "PATCH", revision: Number(form.dataset.revision), body: JSON.stringify(data) }); dialogs.board.close(); await loadBoard(boardId); toast("Board updated"); } catch (error) { toast(error.message, true); } return; }
  const tempId = optimisticId(), now = Date.now(), optimistic = { id: tempId, name: data.name, description: data.description, revision: 0, sort_order: Math.max(0, ...state.bootstrap.boards.map(board => Number(board.sort_order) || 0)) + 1024, archived_at: null, created_at: now, updated_at: now, pending: true };
  state.bootstrap.boards.push(optimistic); dialogs.board.close(); renderBoards();
  try { const result = await api("/api/boards", { method: "POST", body: JSON.stringify(data) }); Object.assign(optimistic, { id: result.data.id, revision: result.revision, pending: false }); renderBoards(); setRoute("boards", result.data.id); toast("Board created"); }
  catch (error) { state.bootstrap.boards = state.bootstrap.boards.filter(board => board !== optimistic); renderBoards(); toast(error.message, true); }
};

function splitFacetTag(name) { const at = String(name || "").indexOf(":"); if (at < 1) return null; const key = String(name).slice(0, at).trim(), value = String(name).slice(at + 1).trim(); return key && value ? { key, normalizedKey: key.normalize("NFKC").toLocaleLowerCase(), value, type: key.toLocaleLowerCase().includes("date") ? "date" : "select" } : null; }
function tagFacets(snapshot) { const facets = new Map(); for (const tag of snapshot.tags || []) { const parsed = splitFacetTag(tag.name); if (!parsed) continue; const facet = facets.get(parsed.normalizedKey) || { id: `tag:${parsed.normalizedKey}`, name: parsed.key, type: parsed.type, values: [] }; if (!facet.values.includes(parsed.value)) facet.values.push(parsed.value); facets.set(parsed.normalizedKey, facet); } return [...facets.values()].map(facet => ({ ...facet, values: facet.values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) })); }
function fieldLabel(snapshot, ref) { const builtins = { title: "Title", description: "Description", list: "List", tags: "Tags", created_at: "Created", updated_at: "Updated" }; return builtins[ref] || tagFacets(snapshot).find(facet => facet.id === ref)?.name || ref; }
function allColumns(snapshot) { return [{ id: "title", name: "Title" }, { id: "list", name: "List" }, { id: "tags", name: "Tags" }, ...tagFacets(snapshot), { id: "created_at", name: "Created" }, { id: "updated_at", name: "Updated" }]; }
function selectOptions(snapshot, selected = "", allowNone = false, context = "default") { const columns = allColumns(snapshot).filter(column => context !== "group-sort" || column.id !== "tags"); return `${allowNone ? '<option value="">None</option>' : ""}${columns.map(column => `<option value="${column.id}" ${String(selected) === column.id ? "selected" : ""}>${html(column.name)}</option>`).join("")}`; }
function requestBoard(boardId) {
  const existing = state.boardRequests.get(boardId); if (existing && Date.now() - existing.startedAt < 10000) return existing.promise;
  const entry = { startedAt: Date.now(), promise: null }; entry.promise = api(`/api/boards/${boardId}`).then(result => result.data).catch(error => { if (state.boardRequests.get(boardId) === entry) state.boardRequests.delete(boardId); throw error; }); state.boardRequests.set(boardId, entry); return entry.promise;
}
function renderBoardLoading(boardId) { const summary = state.bootstrap.boards.find(board => Number(board.id) === Number(boardId)); $("#app").className = "board-page"; $("#app").innerHTML = `<header class="board-header"><button class="icon-button back" aria-label="Back to boards">${icons.arrowLeft}</button><div class="board-title"><h1>${html(summary?.name || "Board")}</h1><p>Loading…</p></div></header><div class="board-loading"><span></span><span></span><span></span></div>`; $(".back").onclick = () => setRoute("boards"); }
async function loadBoard(boardId) { renderBoardLoading(boardId); const promise = requestBoard(boardId), request = state.boardRequests.get(boardId); try { const snapshot = await promise; if (Number(new URLSearchParams(location.search).get("board")) !== Number(boardId)) return; if (state.boardRequests.get(boardId) === request) state.boardRequests.delete(boardId); state.board = snapshot; state.cardsById = new Map(); cacheCards(state.board.cards); state.listPages = new Map(); state.tablePage = null; const defaultView = state.board.views.find(view => Number(view.is_default)), encoded = new URLSearchParams(location.search).get("view"); let linked = null; if (encoded) try { linked = JSON.parse(decodeURIComponent(escape(atob(encoded.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(encoded.length / 4) * 4,"="))))); } catch {} state.config = linked || (defaultView ? structuredClone(defaultView.config) : { search: "", columns: allColumns(state.board).map(item => item.id), filters: [], groupBy: null, sorts: [] }); if (linked) state.viewMode = "table"; renderBoard(); } catch (error) { if (Number(new URLSearchParams(location.search).get("board")) !== Number(boardId)) return; toast(error.message, true); await refreshBootstrap(); setRoute("boards"); } }
function renderBoard() {
  const s = state.board, activeLists = s.lists.filter(list => !list.archived_at); $("#app").className = "board-page";
  $("#app").innerHTML = `<header class="board-header"><button class="icon-button back" aria-label="Back to boards">${icons.arrowLeft}</button><div class="board-title"><h1>${html(s.board.name)}</h1><p>${s.cardCount ?? s.cards.filter(card => !card.archived_at).length} cards</p></div><div class="board-actions"><div class="segmented"><button data-board-mode="board" class="${state.viewMode === "board" ? "active" : ""}">${icons.board} Board</button><button data-board-mode="table" class="${state.viewMode === "table" ? "active" : ""}">${icons.table} Table</button></div><details class="board-menu-wrap"><summary id="board-menu" class="button ghost small" aria-label="Board actions">${icons.more}</summary><div class="board-action-menu"><button id="rename-board" type="button">${icons.edit} Rename board</button><button id="delete-board" type="button" class="danger-item">${icons.trash} Delete board</button></div></details></div></header><div id="board-tools" class="board-tools"></div><div id="board-content"></div>`;
  $(".back").onclick = () => setRoute("boards"); $$('[data-board-mode]', $("#app")).forEach(button => button.onclick = () => { state.viewMode = button.dataset.boardMode; renderBoard(); });
  $("#rename-board").onclick = () => { $(".board-menu-wrap").open = false; openBoardDialog(s.board); };
  $("#delete-board").onclick = () => { $(".board-menu-wrap").open = false; openDeleteConfirmation("Delete board permanently?", `“${s.board.name}” and all of its lists and cards will be permanently deleted. This cannot be undone.`, "Delete board", async () => { try { await api(`/api/boards/${s.board.id}`, { method: "DELETE", revision: s.board.revision }); await refreshBootstrap(); setRoute("boards"); toast("Board deleted"); } catch (error) { toast(error.message, true); } }); };
  renderTools(); if (state.viewMode === "board") renderLanes(activeLists); else runTableQuery();
}
function renderTools() {
  const s = state.board, tools = $("#board-tools");
  tools.innerHTML = `<div class="search-wrap"><span>${icons.search}</span><input id="board-search" class="control" type="search" placeholder="Search this board…" value="${html(state.config.search || "")}"></div>${state.viewMode === "table" ? `<select id="group-by" class="control" style="width:auto"><option value="">No grouping</option>${selectOptions(s, state.config.groupBy, false, "group-sort")}</select><button id="add-filter" class="button ghost small">${icons.filter} Filter</button><button id="columns" class="button ghost small">${icons.columns} Columns</button><button id="save-view" class="button secondary small">${icons.plus} Save view</button>` : ""}<div id="saved-views" class="saved-views-row" aria-label="Saved views"${s.views.length ? "" : " hidden"}>${s.views.map(view => `<span class="saved-view"><button class="load-view" data-id="${view.id}">${html(view.name)}${Number(view.is_default) ? " · default" : ""}</button><button class="delete-view" data-id="${view.id}" aria-label="Delete view">${icons.x}</button></span>`).join("")}</div><div id="filters"></div>`;
  $("#board-search").oninput = event => { state.config.search = event.target.value; clearTimeout(state.timer); state.timer = setTimeout(() => state.viewMode === "board" ? (s.loadMode === "paginated" ? refreshListCounts() : renderLanes(s.lists.filter(list => !list.archived_at))) : runTableQuery(), 180); updateUrlConfig(); };
  $$(".load-view").forEach(button => button.onclick = () => { const view = s.views.find(item => Number(item.id) === Number(button.dataset.id)); state.config = structuredClone(view.config); state.viewMode = "table"; renderBoard(); });
  $$(".delete-view").forEach(button => button.onclick = () => { const view = s.views.find(item => Number(item.id) === Number(button.dataset.id)); if (!view) return; openDeleteConfirmation("Delete saved view permanently?", `“${view.name}” will be permanently deleted. This cannot be undone.`, "Delete view", async () => { try { await api(`/api/boards/${s.board.id}/views/${view.id}`, { method: "DELETE", revision: s.board.revision }); await loadBoard(s.board.id); toast("View deleted"); } catch (error) { toast(error.message, true); } }); });
  if (state.viewMode !== "table") return;
  $("#group-by").onchange = event => { state.config.groupBy = event.target.value || null; runTableQuery(); updateUrlConfig(); };
  $("#add-filter").onclick = () => { state.config.filters ||= []; state.config.filters.push({ field: "title", operator: "contains", value: "" }); renderBoard(); };
  $("#columns").onclick = showColumns; $("#save-view").onclick = () => { $("#view-form").reset(); dialogs.view.showModal(); };
  renderFilters();
}
function tagFilterField(ref) { if (ref === "created_at" || ref === "updated_at") return { id: ref, name: fieldLabel(state.board, ref), type: "date", values: [] }; if (ref === "tags") return { id: "tags", name: "Tags", type: "select", values: (state.board.tags || []).map(tag => tag.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }; return tagFacets(state.board).find(item => item.id === ref); }
function filterOperators(ref) { const facet = tagFilterField(ref); if (facet?.type === "date") return [["equals","on"],["gte","on or after"],["lte","on or before"],["gt","after"],["lt","before"],["empty","is empty"],["not_empty","is not empty"]]; if (facet) return [["any","contains any"],["all","contains all"],["none","contains none"],["empty","is empty"],["not_empty","is not empty"]]; return [["contains","contains"],["equals","equals"],["not_equals","does not equal"],["gt","greater than"],["lt","less than"],["empty","is empty"],["not_empty","is not empty"]]; }
function filterValueHtml(filter, index) { const facet = tagFilterField(filter.field); if (facet?.type === "date") return `<input class="control filter-value" type="date" value="${html(filter.value || "")}">`; if (facet) { const values = Array.isArray(filter.value) ? filter.value : filter.value ? [filter.value] : []; return `<div class="facet-filter-control" data-filter-index="${index}" data-values="${html(JSON.stringify(values))}"><div class="facet-filter-tags"></div><input class="facet-filter-input" autocomplete="off" placeholder="Select ${html(facet.name)}…"><div class="facet-filter-options" hidden></div></div>`; } return `<input class="control filter-value" value="${html(Array.isArray(filter.value) ? filter.value.join(",") : filter.value || "")}" placeholder="Value">`; }
function bindFacetFilter(control, facet, sync) {
  const selected = () => JSON.parse(control.dataset.values || "[]"), tags = $(".facet-filter-tags", control), input = $(".facet-filter-input", control), options = $(".facet-filter-options", control);
  const render = (showOptions = document.activeElement === input) => {
    const values = selected();
    tags.innerHTML = values.map(value => `<span class="tag tag-cyan">${html(value)}<button type="button" data-remove-facet="${html(value)}">${icons.x}</button></span>`).join("");
    $$('[data-remove-facet]', tags).forEach(button => button.onclick = () => { control.dataset.values = JSON.stringify(values.filter(value => value !== button.dataset.removeFacet)); render(false); sync(); });
    const query = input.value.trim().toLocaleLowerCase(), available = facet.values.filter(value => !values.includes(value) && (!query || value.toLocaleLowerCase().includes(query)));
    options.hidden = !showOptions || !available.length;
    options.innerHTML = available.map(value => `<button type="button" data-facet-value="${html(value)}">${html(value)}</button>`).join("");
    $$('[data-facet-value]', options).forEach(button => { button.onmousedown = event => event.preventDefault(); button.onclick = () => { control.dataset.values = JSON.stringify([...values, button.dataset.facetValue]); input.value = ""; render(true); sync(); input.focus(); }; });
  };
  input.onfocus = () => render(true); input.oninput = () => render(true); input.onblur = () => setTimeout(() => options.hidden = true, 100); render(false);
}
function renderFilters() {
  const host = $("#filters"); if (!host || !state.config.filters?.length) { if (host) host.innerHTML = ""; return; }
  host.className = "filter-panel"; host.innerHTML = state.config.filters.map((filter, index) => `<div class="filter-row" data-index="${index}"><select class="control filter-field">${selectOptions(state.board, filter.field)}</select><select class="control filter-op">${filterOperators(filter.field).map(([value,label]) => `<option value="${value}" ${filter.operator === value ? "selected" : ""}>${label}</option>`).join("")}</select>${filterValueHtml(filter, index)}<button class="icon-button remove-filter" aria-label="Remove filter">${icons.x}</button></div>`).join("");
  $$(".filter-row", host).forEach(row => { const index = Number(row.dataset.index), sync = () => { const filter = state.config.filters[index]; filter.operator = $(".filter-op", row).value; const facetControl = $(".facet-filter-control", row), valueControl = $(".filter-value", row); filter.value = facetControl ? JSON.parse(facetControl.dataset.values || "[]") : valueControl?.value || ""; runTableQuery(); updateUrlConfig(); }; $(".filter-field", row).onchange = event => { const filter = state.config.filters[index], facet = tagFilterField(event.target.value); filter.field = event.target.value; filter.operator = facet?.type === "date" ? "gte" : facet ? "any" : "contains"; filter.value = facet?.type === "date" ? "" : facet ? [] : ""; renderBoard(); }; $(".filter-op", row).onchange = sync; $(".filter-value", row)?.addEventListener("input", () => { clearTimeout(state.timer); state.timer = setTimeout(sync, 180); }); const facet = tagFilterField(state.config.filters[index].field), facetControl = $(".facet-filter-control", row); if (facet && facetControl) bindFacetFilter(facetControl, facet, sync); $(".remove-filter", row).onclick = () => { state.config.filters.splice(index, 1); renderBoard(); }; });
}
function showColumns(event) { $(".columns-menu")?.remove(); const menu = document.createElement("div"); menu.className = "columns-menu"; menu.style.top = `${event.target.offsetTop + event.target.offsetHeight + 5}px`; menu.style.left = `${event.target.offsetLeft}px`; const selected = new Set(state.config.columns?.length ? state.config.columns : allColumns(state.board).map(item => item.id)); menu.innerHTML = allColumns(state.board).map(column => `<label class="check"><input type="checkbox" value="${column.id}" ${selected.has(column.id) ? "checked" : ""}> ${html(column.name)}</label>`).join(""); menu.onchange = () => { state.config.columns = $$("input:checked", menu).map(input => input.value); runTableQuery(); updateUrlConfig(); }; $("#board-tools").append(menu); setTimeout(() => document.addEventListener("click", function close(e) { if (!menu.contains(e.target) && e.target !== event.target) { menu.remove(); document.removeEventListener("click", close); } }), 0); }
function updateUrlConfig() { const url = new URL(location.href); if (state.viewMode === "table") url.searchParams.set("view", btoa(unescape(encodeURIComponent(JSON.stringify(state.config)))).replaceAll("=", "")); else url.searchParams.delete("view"); history.replaceState({}, "", url); }

function visibleCards() { return queryCards(state.board.cards.filter(card => !card.archived_at), state.board.lists, { search: state.config.search || "" }).cards; }
function cardSearch(card) { return [card.title, card.description, ...(card.tags || []).map(tag => tag.name)].join(" ").normalize("NFKC").toLocaleLowerCase(); }
function displayValue(_field, value) { if (value === null || value === undefined || value === "") return ""; if (typeof value === "number" && value > 1e12) return formatDateUtc(value); return String(value); }
const LIST_VIRTUAL_THRESHOLD = 100, LIST_WINDOW_SIZE = 40, LIST_ITEM_HEIGHT = 76, LIST_OVERSCAN = 8;
function virtualListState(listId) { const page = state.listPages.get(listId); if (page) return page; state.listVirtuals ||= new Map(); const key = `${state.board.board.id}:${listId}`; if (!state.listVirtuals.has(key)) state.listVirtuals.set(key, { virtualStart: 0, virtualScrollTop: 0 }); return state.listVirtuals.get(key); }
function virtualListMarkup(listId, cards) { if (cards.length <= LIST_VIRTUAL_THRESHOLD) return cards.map(cardHtml).join(""); const virtual = virtualListState(listId), maxStart = Math.max(0, cards.length - LIST_WINDOW_SIZE), start = Math.min(virtual.virtualStart || 0, maxStart), end = Math.min(cards.length, start + LIST_WINDOW_SIZE); return `<div class="virtual-spacer" style="height:${start * LIST_ITEM_HEIGHT}px" aria-hidden="true"></div>${cards.slice(start, end).map(cardHtml).join("")}<div class="virtual-spacer" data-next-card-id="${cards[end]?.id || ""}" style="height:${(cards.length - end) * LIST_ITEM_HEIGHT}px" aria-hidden="true"></div>`; }
function bindVirtualLists(root) { $$(".list-cards", root).filter(host => host.querySelector(".virtual-spacer")).forEach(host => { const listId = Number(host.closest(".list").dataset.listId), virtual = virtualListState(listId); host.classList.add("virtualized"); host.scrollTop = virtual.virtualScrollTop || 0; host.onscroll = () => { virtual.virtualScrollTop = host.scrollTop; const cards = state.board.loadMode === "paginated" ? state.listPages.get(listId)?.cards || [] : visibleCards().filter(card => card.list_id === listId).sort((a, b) => a.sort_order - b.sort_order), next = Math.max(0, Math.floor(host.scrollTop / LIST_ITEM_HEIGHT) - LIST_OVERSCAN); if (next === virtual.virtualStart) return; virtual.virtualStart = next; const scrollTop = host.scrollTop; host.innerHTML = virtualListMarkup(listId, cards); host.scrollTop = scrollTop; bindCards(); }; }); }
function laneHtml(list, cards, total, page = null) { const paged = state.board.loadMode === "paginated", pagination = paged ? `<div class="list-pagination">${page?.nextCursor ? `<span>${cards.length} of ${total}</span><button class="button ghost small load-list-more" type="button">Load more</button><div class="list-end-drop">Move to end</div>` : ""}${page?.error ? `<button class="button ghost small retry-list" type="button">Retry</button>` : ""}</div>` : ""; return `<section class="list${paged ? " paged-list" : ""}${list.pending ? " pending-create" : ""}" draggable="${list.pending ? "false" : "true"}" data-list-id="${list.id}"${list.pending ? ' aria-busy="true"' : ""}><div class="list-head"><h2>${html(list.name)}</h2><span>${list.pending ? '<span class="pending-label">Adding…</span>' : `<span class="count">${total}</span><button class="icon-button list-menu" aria-label="List actions">${icons.more}</button>`}</span></div><div class="list-cards">${virtualListMarkup(list.id, cards)}${page?.loading && !cards.length ? '<div class="list-loading">Loading cards…</div>' : ""}</div>${pagination}<button class="add-card">${icons.plus} Add a card</button></section>`; }
function boardCanvasHtml(lists, laneData) { return `<div class="board-canvas">${lists.map(list => { const data = laneData(list); return laneHtml(list, data.cards, data.total, data.page); }).join("")}<button id="add-list" class="add-list">${icons.plus} Add another list</button></div>`; }
function renderLanes(lists) {
  if (state.board.loadMode === "paginated") { renderPagedLanes(lists); return; }
  const cards = visibleCards();
  $("#board-content").innerHTML = boardCanvasHtml(lists, list => { const laneCards = cards.filter(card => card.list_id === list.id).sort((a, b) => a.sort_order - b.sort_order); return { cards: laneCards, total: laneCards.length }; });
  const canvas = $(".board-canvas");
  bindLaneInteractions(canvas); bindVirtualLists(canvas);
}
function listCount(listId) { const queryCounts = state.listQueryCounts; if (queryCounts?.boardId === state.board.board.id && queryCounts.search === String(state.config.search || "")) return queryCounts.counts.get(listId) || 0; return state.board.listCardCounts?.find(item => item.listId === listId)?.count || 0; }
async function refreshListCounts() { const boardId = state.board.board.id, search = String(state.config.search || ""); state.listPages = new Map(); try { const result = (await api(`/api/boards/${boardId}/lists/counts`, { method: "POST", body: JSON.stringify({ search }) })).data; if (state.board?.board.id !== boardId || String(state.config.search || "") !== search) return; state.listQueryCounts = { boardId, search, counts: new Map(result.counts.map(item => [item.listId, item.count])) }; renderPagedLanes(state.board.lists.filter(list => !list.archived_at)); } catch (error) { toast(error.message, true); } }
function renderPagedLanes(lists) {
  const search = String(state.config.search || "");
  for (const list of lists) { const page = state.listPages.get(list.id); if (page && page.search !== search) state.listPages.delete(list.id); }
  const previousScroll = $(".board-canvas")?.scrollLeft || 0;
  $("#board-content").innerHTML = boardCanvasHtml(lists, list => { const page = state.listPages.get(list.id), cards = page?.cards || []; return { cards, total: page?.total ?? listCount(list.id), page }; });
  const canvas = $(".board-canvas"); canvas.scrollLeft = previousScroll; bindLaneInteractions(canvas); bindVirtualLists(canvas);
  const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { const listId = Number(entry.target.dataset.listId); if (!state.listPages.has(listId)) loadListPage(listId); observer.unobserve(entry.target); } }, { root: canvas, rootMargin: "0px 320px" });
  $$(".paged-list", canvas).forEach(list => observer.observe(list));
  $$(".load-list-more", canvas).forEach(button => button.onclick = () => loadListPage(Number(button.closest(".list").dataset.listId), true));
  $$(".retry-list", canvas).forEach(button => button.onclick = () => loadListPage(Number(button.closest(".list").dataset.listId), Boolean(state.listPages.get(Number(button.closest(".list").dataset.listId))?.cards.length)));
  $$(".list-end-drop", canvas).forEach(zone => { let hoverTimer; zone.ondragenter = () => { hoverTimer = setTimeout(() => loadListPage(Number(zone.closest(".list").dataset.listId), true), 500); }; zone.ondragleave = () => clearTimeout(hoverTimer); zone.ondragover = event => { if (state.draggingCardId) event.preventDefault(); }; zone.ondrop = event => { event.preventDefault(); clearTimeout(hoverTimer); const cardId = state.draggingCardId || Number(event.dataTransfer.getData("text/card-id")); if (cardId) moveCard(cardId, Number(zone.closest(".list").dataset.listId), null, "end"); }; });
  const moreObserver = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { const listId = Number(entry.target.closest(".list").dataset.listId), page = state.listPages.get(listId); if (page && !page.autoLoaded) { page.autoLoaded = true; loadListPage(listId, true, true); } moreObserver.unobserve(entry.target); } }, { rootMargin: "240px 0px" });
  $$(".load-list-more", canvas).forEach(button => moreObserver.observe(button));
}
async function loadListPage(listId, append = false, automatic = false) {
  const previous = state.listPages.get(listId), search = String(state.config.search || ""), page = append && previous?.search === search ? previous : { cards: [], nextCursor: null, total: listCount(listId), search };
  if (page.loading || (append && !page.nextCursor)) return; if (append) page.autoLoaded = true; page.loading = true; page.error = ""; state.listPages.set(listId, page);
  let added = [];
  try { const result = (await api(`/api/boards/${state.board.board.id}/lists/${listId}/cards/query`, { method: "POST", body: JSON.stringify({ search, limit: 50, cursor: append ? page.nextCursor : null }) })).data; added = result.cards; page.cards = append ? [...page.cards, ...result.cards] : result.cards; page.total = result.total; page.nextCursor = result.nextCursor; page.nextCardId = result.nextCardId; cacheCards(result.cards); }
  catch (error) { if (append && /changed|beginning/i.test(error.message)) { state.listPages.delete(listId); loadListPage(listId); return; } page.error = error.message; } finally { page.loading = false; if (state.viewMode === "board" && state.board.loadMode === "paginated") { if (state.draggingCardId && append && added.length) { const host = $(`.list[data-list-id="${listId}"] .list-cards`), preview = host?.querySelector(".card-drop-preview"), markup = added.map(cardHtml).join(""); if (preview) preview.insertAdjacentHTML("beforebegin", markup); else host?.insertAdjacentHTML("beforeend", markup); bindCards(); } else renderPagedLanes(state.board.lists.filter(list => !list.archived_at)); } }
}
function bindLaneInteractions(canvas) {
  bindCards(); $$(".add-card", canvas).forEach(button => button.onclick = () => openCardDialogFromList(Number(button.closest(".list").dataset.listId))); $("#add-list").onclick = () => openListDialog();
  $$(".list-menu", canvas).forEach(button => button.onclick = () => { const listId = Number(button.closest(".list").dataset.listId), list = state.board.lists.find(item => item.id === listId); if (!list?.pending) openListDialog(list); });
  $$(".list", canvas).forEach(list => { const listId = Number(list.dataset.listId), host = $(".list-cards", list); list.ondragstart = event => { if (event.target.closest(".card")) return; if (listId < 0) { event.preventDefault(); return; } state.draggingListId = listId; list.classList.add("dragging-list"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/list-id", String(listId)); }; list.ondragend = () => { state.draggingListId = null; list.classList.remove("dragging-list"); clearListDropPreview(); }; list.ondragover = event => { if (!state.draggingCardId) return; event.preventDefault(); event.stopPropagation(); showCardDropPreview(host, event.clientY); }; list.ondrop = event => { if (!state.draggingCardId) return; event.preventDefault(); event.stopPropagation(); const preview = host.querySelector(".card-drop-preview"); if (!preview) return; const cardId = state.draggingCardId || Number(event.dataTransfer.getData("text/card-id")), page = state.listPages.get(listId), beforeId = Number(preview.dataset.beforeId || 0) || page?.nextCardId || null; if (cardId) moveCard(cardId, listId, beforeId, undefined, preview); else clearCardDropPreviews(); }; });
  canvas.ondragover = event => { if (!state.draggingListId) return; event.preventDefault(); showListDropPreview(canvas, event.clientX); }; canvas.ondrop = event => { if (!state.draggingListId) return; event.preventDefault(); const preview = canvas.querySelector(".list-drop-preview"); if (!preview) return; const listId = state.draggingListId || Number(event.dataTransfer.getData("text/list-id")), beforeId = Number(preview.dataset.beforeId || 0) || null; clearListDropPreview(); if (listId) moveList(listId, beforeId); };
  bindTouchDragging(canvas);
}

function bindTouchDragging(canvas) {
  if (!matchMedia("(pointer: coarse)").matches) return;
  let pending = null, drag = null, lastEdgeScroll = 0, suppressClicksUntil = 0;
  const cancelPending = () => { if (pending?.timer) clearTimeout(pending.timer); pending = null; };
  const positionGhost = (x, y) => { if (drag?.ghost) { drag.ghost.style.left = `${x}px`; drag.ghost.style.top = `${y}px`; } };
  const closestVisibleList = (x, y) => {
    const hit = document.elementFromPoint(x, y)?.closest(".list");
    if (hit && canvas.contains(hit)) return hit;
    return [...canvas.querySelectorAll(".list:not(.dragging-list)")].filter(list => { const rect = list.getBoundingClientRect(); return rect.right > 0 && rect.left < innerWidth; }).sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.offsetWidth / 2 - x) - Math.abs(b.getBoundingClientRect().left + b.offsetWidth / 2 - x))[0] || null;
  };
  const updateTarget = (x, y) => {
    const bounds = canvas.getBoundingClientRect(), now = Date.now(), edge = 44;
    if (now - lastEdgeScroll > 500 && (x < bounds.left + edge || x > bounds.right - edge)) { canvas.scrollBy({ left: (x < bounds.left + edge ? -1 : 1) * canvas.clientWidth, behavior: "smooth" }); lastEdgeScroll = now; }
    if (drag.type === "card") { const list = closestVisibleList(x, y), host = list?.querySelector(".list-cards"); if (host) showCardDropPreview(host, y); }
    else showListDropPreview(canvas, x);
  };
  const finish = event => {
    cancelPending();
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag; drag = null; suppressClicksUntil = Date.now() + 500;
    current.source.classList.remove(current.type === "card" ? "dragging" : "dragging-list"); current.ghost.remove(); canvas.classList.remove("touch-dragging", "card-dragging");
    try { current.source.releasePointerCapture(event.pointerId); } catch {}
    if (current.type === "card") { const preview = canvas.querySelector(".card-drop-preview"), host = preview?.closest(".list-cards"), listId = Number(host?.closest(".list")?.dataset.listId), beforeId = Number(preview?.dataset.beforeId || 0) || state.listPages.get(listId)?.nextCardId || null; state.draggingCardId = null; if (preview && listId) moveCard(current.id, listId, beforeId, undefined, preview); else clearCardDropPreviews(); }
    else { const preview = canvas.querySelector(".list-drop-preview"), beforeId = Number(preview?.dataset.beforeId || 0) || null; clearListDropPreview(); state.draggingListId = null; if (preview) moveList(current.id, beforeId); }
  };
  canvas.addEventListener("click", event => { if (Date.now() < suppressClicksUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  canvas.addEventListener("contextmenu", event => { if (event.target.closest(".card,.list")) event.preventDefault(); });
  canvas.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" || event.button !== 0 || event.target.closest("button,input,textarea,select,a")) return;
    const card = event.target.closest(".card"), list = event.target.closest(".list"); if (!list) return;
    const source = card || list, type = card ? "card" : "list", id = Number(source.dataset[type === "card" ? "cardId" : "listId"]);
    pending = { pointerId: event.pointerId, source, type, id, x: event.clientX, y: event.clientY };
    pending.timer = setTimeout(() => {
      if (!pending) return;
      drag = pending; pending = null; suppressClicksUntil = Date.now() + 500; source.setPointerCapture(event.pointerId);
      const ghost = document.createElement("div"); ghost.className = `touch-drag-ghost ${type}`; ghost.textContent = type === "card" ? getCard(id)?.title || "Card" : source.querySelector(".list-head h2")?.textContent || "List"; document.body.append(ghost); drag.ghost = ghost;
      source.classList.add(type === "card" ? "dragging" : "dragging-list"); canvas.classList.add("touch-dragging");
      if (type === "card") { state.draggingCardId = id; canvas.classList.add("card-dragging"); } else state.draggingListId = id;
      positionGhost(event.clientX, event.clientY); navigator.vibrate?.(20);
    }, 360);
  }, { passive: true });
  canvas.addEventListener("pointermove", event => {
    if (pending && event.pointerId === pending.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 9) cancelPending();
    if (!drag || event.pointerId !== drag.pointerId) return; event.preventDefault(); positionGhost(event.clientX, event.clientY); updateTarget(event.clientX, event.clientY);
  }, { passive: false });
  canvas.addEventListener("pointerup", finish); canvas.addEventListener("pointercancel", finish);
}
function activeTagFilter(name) { const normalized = name.normalize("NFKC").toLocaleLowerCase(); if (state.viewMode === "board") return String(state.config.search || "").normalize("NFKC").toLocaleLowerCase() === normalized; return (state.config.filters || []).filter(item => item.field === "tags" && item.operator === "any").some(filter => (Array.isArray(filter.value) ? filter.value : [filter.value]).some(value => String(value || "").normalize("NFKC").toLocaleLowerCase() === normalized)); }
function tagBadgesHtml(tags) { return tags?.length ? `<div class="card-tags">${tags.map(tag => `<button type="button" class="tag tag-${tagColor(tag)} tag-filter${activeTagFilter(tag.name) ? " active" : ""}" data-filter-tag="${html(tag.name)}" aria-label="Filter by tag ${html(tag.name)}" aria-pressed="${activeTagFilter(tag.name)}">${html(tag.name)}</button>`).join("")}</div>` : ""; }
function filterByTag(name) {
  if (state.viewMode === "board") {
    state.config.search = activeTagFilter(name) ? "" : name; updateUrlConfig();
    if (state.board.loadMode === "paginated") { $("#board-search").value = state.config.search; refreshListCounts(); } else renderBoard();
    return;
  }
  const clear = activeTagFilter(name); state.config.filters = (state.config.filters || []).filter(filter => filter.field !== "tags" || filter.operator !== "any"); if (!clear) state.config.filters.push({ field: "tags", operator: "any", value: [name] });
  updateUrlConfig(); renderBoard();
}
function bindTagFilters(root = document) { $$(".tag-filter", root).forEach(button => button.onclick = event => { event.preventDefault(); event.stopPropagation(); filterByTag(button.dataset.filterTag); }); }
function cardHtml(card) { return `<article class="card${card.pending ? " pending-create" : ""}" draggable="${card.pending ? "false" : "true"}" tabindex="0" data-card-id="${card.id}"${card.pending ? ' aria-busy="true"' : ""}><h3>${html(card.title)}</h3>${tagBadgesHtml(card.tags)}${card.pending ? '<span class="pending-label">Saving…</span>' : ""}</article>`; }
function currentCardBeforeId(cardId) { const card = getCard(cardId); if (!card) return null; const cards = state.board.loadMode === "complete" ? state.board.cards.filter(item => !item.archived_at && item.list_id === card.list_id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id) : state.listPages.get(card.list_id)?.cards || [], index = cards.findIndex(item => item.id === card.id); return index >= 0 ? cards[index + 1]?.id || state.listPages.get(card.list_id)?.nextCardId || null : null; }
function cardMoveChanges(cardId, listId, beforeId = null, placement) { const card = getCard(cardId); if (!card || card.list_id !== listId) return Boolean(card); const cards = state.board.loadMode === "complete" ? state.board.cards.filter(item => !item.archived_at && item.list_id === listId).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id) : state.listPages.get(listId)?.cards || []; if (placement === "start") return cards[0]?.id !== cardId; if (placement === "end") return (cards.at(-1)?.id || null) !== cardId || Boolean(state.listPages.get(listId)?.nextCardId); return Number(currentCardBeforeId(cardId) || 0) !== Number(beforeId || 0); }
function showCardDropPreview(host, pointerY) { const card = getCard(state.draggingCardId); if (!card) return; const before = [...host.querySelectorAll(".card:not(.dragging)")].find(element => pointerY < element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2), boundary = host.querySelector(".virtual-spacer[data-next-card-id]"), beforeId = Number(before?.dataset.cardId || boundary?.dataset.nextCardId || state.listPages.get(Number(host.closest(".list").dataset.listId))?.nextCardId || 0) || null, listId = Number(host.closest(".list").dataset.listId); if (!cardMoveChanges(card.id, listId, beforeId)) { clearCardDropPreviews(); return; } let preview = host.querySelector(".card-drop-preview"); if (!preview) { clearCardDropPreviews(); preview = document.createElement("div"); preview.className = "card-drop-preview"; preview.innerHTML = `<small>Move here</small><strong>${html(card.title)}</strong>`; host.classList.add("drop-target"); host.closest(".list")?.classList.add("card-drop-target"); } preview.dataset.beforeId = beforeId || ""; host.insertBefore(preview, before || boundary || null); }
function clearCardDropPreview(host) { host.querySelector(".card-drop-preview")?.remove(); host.classList.remove("drop-target"); host.closest(".list")?.classList.remove("card-drop-target"); }
function clearCardDropPreviews() { $$(".list-cards").forEach(clearCardDropPreview); }
function placeCardOptimistically(cardId, listId, beforeId = null, placement, preview = null) {
  const element = $(`.card[data-card-id="${Number(cardId)}"]`), host = preview?.closest(".list-cards") || $(`.list[data-list-id="${Number(listId)}"] .list-cards`);
  if (!element || !host) { clearCardDropPreviews(); return false; }
  const sourceList = element.closest(".list"), targetList = host.closest(".list"), sourceCount = sourceList ? $(".count", sourceList) : null, targetCount = targetList ? $(".count", targetList) : null;
  element.classList.remove("dragging"); element.classList.add("pending-move"); element.setAttribute("aria-busy", "true");
  if (preview?.isConnected) preview.replaceWith(element);
  else {
    const before = placement === "start" ? host.querySelector(".card") : beforeId ? host.querySelector(`.card[data-card-id="${Number(beforeId)}"]`) : null;
    const boundary = host.querySelector(".virtual-spacer[data-next-card-id]");
    host.insertBefore(element, before || boundary || null);
  }
  if (sourceList && targetList && sourceList !== targetList) {
    if (sourceCount) sourceCount.textContent = String(Math.max(0, Number(sourceCount.textContent) - 1));
    if (targetCount) targetCount.textContent = String(Number(targetCount.textContent) + 1);
  }
  clearCardDropPreviews();
  return true;
}
function applyOptimisticCardMove(snapshot, cardId, listId, beforeId = null, placement) {
  const card = getCard(cardId), oldListId = card.list_id, search = String(state.config.search || ""), matchesSearch = queryCards([card], snapshot.lists, { search }).cards.length > 0;
  card.list_id = listId; card.updated_at = Date.now();
  const targetCards = knownCards(snapshot).filter(item => item !== card && !item.archived_at && item.list_id === listId).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id), beforeIndex = beforeId ? targetCards.findIndex(item => item.id === Number(beforeId)) : -1, insertAt = placement === "start" ? 0 : placement === "end" || beforeIndex < 0 ? targetCards.length : beforeIndex;
  targetCards.splice(insertAt, 0, card); targetCards.forEach((item, index) => item.sort_order = index * 1024);
  if (oldListId !== listId) {
    changeListCount(snapshot, oldListId, -1); changeListCount(snapshot, listId, 1);
    const queryCounts = state.listQueryCounts; if (matchesSearch && queryCounts?.boardId === snapshot.board.id && queryCounts.search === search) { queryCounts.counts.set(oldListId, Math.max(0, Number(queryCounts.counts.get(oldListId) || 0) - 1)); queryCounts.counts.set(listId, Number(queryCounts.counts.get(listId) || 0) + 1); }
  }
  for (const [pageListId, page] of state.listPages) {
    const contained = page.cards?.includes(card); if (contained) page.cards = page.cards.filter(item => item !== card);
    if (oldListId !== listId && contained) page.total = Math.max(0, Number(page.total || 0) - 1);
    if (pageListId !== listId) continue;
    const cards = page.cards || [], pageBefore = beforeId ? cards.findIndex(item => item.id === Number(beforeId)) : -1, pageAt = placement === "start" ? 0 : placement === "end" || pageBefore < 0 ? cards.length : pageBefore;
    cards.splice(pageAt, 0, card); page.cards = cards; if (oldListId !== listId) page.total = Number(page.total || 0) + 1;
  }
}
function finishOptimisticCardMove(cardId) { const element = $(`.card[data-card-id="${Number(cardId)}"]`); element?.classList.remove("pending-move"); element?.removeAttribute("aria-busy"); }
function currentListBeforeId(listId) { const lists = state.board.lists.filter(list => !list.archived_at).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id), index = lists.findIndex(list => list.id === listId); return index >= 0 ? lists[index + 1]?.id || null : null; }
function listMoveChanges(listId, beforeId = null) { return Number(currentListBeforeId(listId) || 0) !== Number(beforeId || 0); }
function showListDropPreview(canvas, pointerX) { const before = [...canvas.querySelectorAll(".list:not(.dragging-list)")].find(list => pointerX < list.getBoundingClientRect().left + list.getBoundingClientRect().width / 2), beforeId = Number(before?.dataset.listId || 0) || null; if (!listMoveChanges(state.draggingListId, beforeId)) { clearListDropPreview(); return; } let preview = canvas.querySelector(".list-drop-preview"); if (!preview) { preview = document.createElement("div"); preview.className = "list-drop-preview"; preview.innerHTML = "<span>Move list here</span>"; } preview.dataset.beforeId = beforeId || ""; canvas.insertBefore(preview, before || $("#add-list")); }
function clearListDropPreview() { $(".list-drop-preview")?.remove(); }
function bindCards() { $$(".card").forEach(element => { const card = getCard(element.dataset.cardId); if (!card) return; element.onfocus = () => state.activeCardId = card.id; element.onclick = () => { if (card.pending) return; state.activeCardId = card.id; openCardDialog(card, card.list_id); }; element.ondragstart = event => { event.stopPropagation(); if (card.pending || event.target.closest(".tag-filter")) { event.preventDefault(); return; } state.activeCardId = card.id; state.draggingCardId = card.id; element.classList.add("dragging"); $(".board-canvas")?.classList.add("card-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/card-id", String(card.id)); }; element.ondragend = event => { event.stopPropagation(); state.draggingCardId = null; element.classList.remove("dragging"); $(".board-canvas")?.classList.remove("card-dragging"); clearCardDropPreviews(); }; element.onkeydown = event => { if (card.pending) return; if (event.key === "Enter") openCardDialog(card, card.list_id); if (event.altKey && ["ArrowLeft","ArrowRight"].includes(event.key)) { event.preventDefault(); const lists = state.board.lists.filter(list => !list.archived_at), at = lists.findIndex(list => list.id === card.list_id), next = lists[at + (event.key === "ArrowRight" ? 1 : -1)]; if (next) moveCard(card.id, next.id); } }; }); bindTagFilters(); }
function openListDialog(list = null) { const form = $("#list-form"); form.reset(); form.listId.value = list?.id || ""; form.name.value = list?.name || ""; $("#list-dialog-title").textContent = list ? "Edit list" : "New list"; $("#save-list").textContent = list ? "Save changes" : "Add list"; $("#delete-list").hidden = !list; dialogs.list.showModal(); setTimeout(() => form.name.focus(), 0); }
$("#list-form").onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, listId = Number(form.listId.value), name = form.name.value.trim(); if (!name) return;
  if (listId) { try { await api(`/api/boards/${state.board.board.id}/lists/${listId}`, { method: "PATCH", revision: state.board.board.revision, body: JSON.stringify({ name }) }); dialogs.list.close(); await loadBoard(state.board.board.id); toast("List updated"); } catch (error) { toast(error.message, true); } return; }
  const snapshot = state.board, tempId = optimisticId(), optimistic = { id: tempId, board_id: snapshot.board.id, name, sort_order: Math.max(0, ...snapshot.lists.map(list => Number(list.sort_order) || 0)) + 1024, archived_at: null, pending: true };
  snapshot.lists.push(optimistic); snapshot.listCardCounts.push({ listId: tempId, count: 0 });
  if (snapshot.loadMode === "paginated") state.listPages.set(tempId, { cards: [], total: 0, nextCursor: null, search: String(state.config.search || "") });
  dialogs.list.close(); renderBoard();
  queueBoardMutation(snapshot, revision => api(`/api/boards/${snapshot.board.id}/lists`, { method: "POST", revision, body: JSON.stringify({ name }) }))
    .then(result => {
      const realId = result.data.id; optimistic.id = realId; optimistic.pending = false; snapshot.board.revision = result.revision;
      const count = snapshot.listCardCounts.find(item => item.listId === tempId); if (count) count.listId = realId;
      const page = state.listPages.get(tempId); if (page) { state.listPages.delete(tempId); state.listPages.set(realId, page); }
      for (const card of [...snapshot.cards, ...state.cardsById.values()]) if (card.list_id === tempId) card.list_id = realId;
      if (state.board === snapshot) renderBoard(); toast("List added");
    })
    .catch(error => {
      snapshot.lists = snapshot.lists.filter(list => list !== optimistic); snapshot.listCardCounts = snapshot.listCardCounts.filter(item => item.listId !== tempId); state.listPages.delete(tempId);
      if (state.board === snapshot) renderBoard(); toast(error.message, true);
    });
};
$("#delete-list").onclick = () => { const listId = Number($("#list-form").listId.value), list = state.board.lists.find(item => item.id === listId); if (!list) return; dialogs.list.close(); openDeleteConfirmation("Delete list permanently?", `“${list.name}” and every card in it will be permanently deleted. This cannot be undone.`, "Delete list", async () => { try { await api(`/api/boards/${state.board.board.id}/lists/${listId}`, { method: "DELETE", revision: state.board.board.revision }); await loadBoard(state.board.board.id); toast("List deleted"); } catch (error) { toast(error.message, true); } }); };
async function moveCard(cardId, listId, beforeId = null, placement = undefined, preview = null) {
  if (!cardMoveChanges(cardId, listId, beforeId, placement)) { clearCardDropPreviews(); return; }
  const snapshot = state.board, previous = captureCardMutation(snapshot), placed = placeCardOptimistically(cardId, listId, beforeId, placement, preview); applyOptimisticCardMove(snapshot, cardId, listId, beforeId, placement);
  try { const result = await queueBoardMutation(snapshot, revision => api(`/api/boards/${snapshot.board.id}/cards/${cardId}/move`, { method: "POST", revision, body: JSON.stringify({ listId, beforeId, placement }) })); snapshot.board.revision = result.revision; finishOptimisticCardMove(cardId); toast("Card moved"); }
  catch (error) { restoreCardMutation(snapshot, previous); if (placed && state.board === snapshot) renderBoard(); toast(error.message, true); }
}
async function moveList(listId, beforeId = null) { if (!listMoveChanges(listId, beforeId)) { state.draggingListId = null; return; } try { await api(`/api/boards/${state.board.board.id}/lists/${listId}/move`, { method: "POST", revision: state.board.board.revision, body: JSON.stringify({ beforeId }) }); state.draggingListId = null; await loadBoard(state.board.board.id); toast("List moved"); } catch (error) { state.draggingListId = null; toast(error.message, true); } }

function tagColor(tag) { return ["lime", "cyan", "pink", "purple", "yellow"].includes(tag?.color) ? tag.color : "purple"; }
const tagColors = ["lime", "cyan", "pink", "purple", "yellow"];
function randomTagColor() { return tagColors[Math.floor(Math.random() * tagColors.length)]; }
function colorForNewTag(name) { const facet = splitFacetTag(name), existing = facet ? (state.board.tags || []).find(tag => splitFacetTag(tag.name)?.normalizedKey === facet.normalizedKey) : null; if (existing) return tagColor(existing); const normalized = name.normalize("NFKC").toLocaleLowerCase(); state.draftTagColors ||= new Map(); if (!state.draftTagColors.has(normalized)) state.draftTagColors.set(normalized, randomTagColor()); return state.draftTagColors.get(normalized); }
function renderSelectedTags() {
  $("#selected-tags").innerHTML = state.editingTags.map((tag, index) => `<span class="tag tag-${tagColor(tag)}"><button class="tag-name" type="button" tabindex="-1" data-edit-tag="${index}" aria-label="Edit ${html(tag.name)}">${html(tag.name)}</button><button type="button" tabindex="-1" data-remove-tag="${index}" aria-label="Remove ${html(tag.name)}">${icons.x}</button></span>`).join("");
  $$('[data-edit-tag]').forEach(button => button.onclick = () => openTagEditor(Number(button.dataset.editTag)));
  $$('[data-remove-tag]').forEach(button => button.onclick = () => { state.editingTags.splice(Number(button.dataset.removeTag), 1); renderSelectedTags(); closeTagSuggestions(); });
}
function closeTagSuggestions() { state.tagSuggestions = []; state.tagSuggestionIndex = 0; $("#tag-suggestions").hidden = true; $("#card-tag-input").setAttribute("aria-expanded", "false"); }
function availableTagSuggestions() { const query = $("#card-tag-input").value.trim(), normalized = query.normalize("NFKC").toLocaleLowerCase(), selected = new Set(state.editingTags.map(tag => tag.name.normalize("NFKC").toLocaleLowerCase())); const matches = (state.board.tags || []).filter(tag => !selected.has(tag.name.normalize("NFKC").toLocaleLowerCase()) && (!normalized || tag.name.normalize("NFKC").toLocaleLowerCase().includes(normalized))).slice(0, 8).map(tag => ({ tag, create: false })); if (query && !selected.has(normalized) && !(state.board.tags || []).some(tag => tag.name.normalize("NFKC").toLocaleLowerCase() === normalized)) matches.push({ tag: { name: query, color: colorForNewTag(query) }, create: true }); return matches; }
function renderTagSuggestions() {
  const host = $("#tag-suggestions"), input = $("#card-tag-input"), query = input.value.trim(), at = query.indexOf(":"), draftKey = at > 0 ? query.slice(0, at).trim() : "";
  if (draftKey.toLocaleLowerCase().includes("date") && at === query.length - 1) { state.tagSuggestions = []; host.hidden = false; input.setAttribute("aria-expanded", "true"); host.innerHTML = `<div class="date-tag-create"><strong>${html(draftKey)}</strong><input id="new-tag-date" type="date"><button id="add-date-tag" class="button secondary small" type="button">Add date</button></div>`; $("#new-tag-date").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); addDateTag(draftKey); } }; $("#add-date-tag").onclick = () => addDateTag(draftKey); setTimeout(() => $("#new-tag-date")?.focus(), 0); return; }
  const suggestions = availableTagSuggestions(); state.tagSuggestions = suggestions; if (state.tagSuggestionIndex >= suggestions.length) state.tagSuggestionIndex = Math.max(0, suggestions.length - 1); host.hidden = !suggestions.length; input.setAttribute("aria-expanded", String(Boolean(suggestions.length))); host.innerHTML = suggestions.map((item, index) => `<button type="button" role="option" aria-selected="${index === state.tagSuggestionIndex}" class="tag-suggestion${index === state.tagSuggestionIndex ? " active" : ""}" data-tag-suggestion="${index}"><span class="tag-dot tag-${tagColor(item.tag)}"></span><span>${item.create ? `Create “${html(item.tag.name)}”` : html(item.tag.name)}</span></button>`).join(""); $$('[data-tag-suggestion]').forEach(button => { button.onmousedown = event => event.preventDefault(); button.onclick = () => addTagSuggestion(Number(button.dataset.tagSuggestion)); });
}
function addDateTag(key) { const value = $("#new-tag-date")?.value; if (!value) return; const name = `${key}:${value}`; state.editingTags.push({ name, color: colorForNewTag(name) }); $("#card-tag-input").value = ""; renderSelectedTags(); renderTagSuggestions(); }
function addTagSuggestion(index = state.tagSuggestionIndex) { const item = state.tagSuggestions?.[index]; if (!item) return; state.editingTags.push(item.tag); $("#card-tag-input").value = ""; state.tagSuggestionIndex = 0; renderSelectedTags(); renderTagSuggestions(); $("#card-tag-input").focus(); }
function optimisticCardTags(snapshot, inputs) {
  const seen = new Set();
  return inputs.flatMap(input => {
    const normalized = input.name.normalize("NFKC").toLocaleLowerCase(), existing = snapshot.tags.find(tag => tag.name.normalize("NFKC").toLocaleLowerCase() === normalized);
    if (seen.has(normalized)) return []; seen.add(normalized);
    if (existing) { if (input.color) existing.color = input.color; return [existing]; }
    const tag = { id: optimisticId(), name: input.name, color: input.color || tagColor(input), pending: true }; snapshot.tags.push(tag); return [tag];
  });
}
function knownCards(snapshot) { return [...new Set([...snapshot.cards, ...state.cardsById.values(), ...(state.tablePage?.cards || []), ...[...state.listPages.values()].flatMap(page => page.cards || [])])]; }
function captureCardMutation(snapshot) {
  return {
    tags: snapshot.tags.map(tag => ({ ...tag })),
    cards: knownCards(snapshot).map(card => ({ card, list_id: card.list_id, title: card.title, description: card.description, sort_order: card.sort_order, updated_at: card.updated_at, pending: card.pending, tags: (card.tags || []).map(tag => ({ ...tag })) })),
    listCardCounts: snapshot.listCardCounts.map(item => ({ ...item })),
    queryCounts: state.listQueryCounts ? new Map(state.listQueryCounts.counts) : null,
    pages: new Map([...state.listPages].map(([id, page]) => [id, { cards: [...(page.cards || [])], total: page.total }])),
    table: state.tablePage ? { cards: [...state.tablePage.cards], groups: structuredClone(state.tablePage.groups || []), total: state.tablePage.total, nextCursor: state.tablePage.nextCursor } : null
  };
}
function restoreCardMutation(snapshot, saved) {
  snapshot.tags = saved.tags;
  for (const item of saved.cards) Object.assign(item.card, { list_id: item.list_id, title: item.title, description: item.description, sort_order: item.sort_order, updated_at: item.updated_at, pending: item.pending, tags: item.tags });
  snapshot.listCardCounts = saved.listCardCounts;
  if (saved.queryCounts && state.listQueryCounts) state.listQueryCounts.counts = saved.queryCounts;
  for (const [id, page] of saved.pages) { const current = state.listPages.get(id); if (current) Object.assign(current, page); }
  if (saved.table && state.tablePage) Object.assign(state.tablePage, saved.table);
}
function recolorOptimisticTags(snapshot, input) {
  if (!input.color) return;
  const normalized = input.name.normalize("NFKC").toLocaleLowerCase(), facet = splitFacetTag(input.name), matches = tag => input.colorScope === "key" && facet ? splitFacetTag(tag.name)?.normalizedKey === facet.normalizedKey : tag.name.normalize("NFKC").toLocaleLowerCase() === normalized;
  for (const tag of snapshot.tags) if (matches(tag)) tag.color = input.color;
  for (const card of knownCards(snapshot)) for (const tag of card.tags || []) if (matches(tag)) tag.color = input.color;
}
function changeListCount(snapshot, listId, delta) { const count = snapshot.listCardCounts.find(item => item.listId === listId); if (count) count.count = Math.max(0, Number(count.count || 0) + delta); }
function applyOptimisticCardUpdate(snapshot, card, body, tagInputs) {
  const oldListId = card.list_id, search = String(state.config.search || ""), oldMatches = queryCards([{ ...card, tags: (card.tags || []).map(tag => ({ ...tag })) }], snapshot.lists, { search }).cards.length > 0;
  for (const input of tagInputs) recolorOptimisticTags(snapshot, input);
  card.title = body.title; card.description = body.description; card.list_id = body.listId; card.updated_at = Date.now(); card.tags = optimisticCardTags(snapshot, tagInputs); card.pending = true;
  const newMatches = queryCards([card], snapshot.lists, { search }).cards.length > 0;
  if (oldListId !== card.list_id) { changeListCount(snapshot, oldListId, -1); changeListCount(snapshot, card.list_id, 1); }
  const queryCounts = state.listQueryCounts;
  if (queryCounts?.boardId === snapshot.board.id && queryCounts.search === search) {
    if (oldMatches) queryCounts.counts.set(oldListId, Math.max(0, Number(queryCounts.counts.get(oldListId) || 0) - 1));
    if (newMatches) queryCounts.counts.set(card.list_id, Number(queryCounts.counts.get(card.list_id) || 0) + 1);
  }
  for (const [listId, page] of state.listPages) {
    const hadCard = page.cards?.includes(card); if (hadCard && (listId !== card.list_id || !newMatches)) { page.cards = page.cards.filter(item => item !== card); page.total = Math.max(0, Number(page.total || 0) - 1); }
    else if (!hadCard && listId === card.list_id && newMatches) { page.cards = [...page.cards, card]; page.total = Number(page.total || 0) + 1; }
  }
}
function renderOptimisticCardMutation(snapshot) {
  if (state.board !== snapshot) return;
  if (state.viewMode === "board") { renderBoard(); return; }
  const source = snapshot.loadMode === "complete" ? snapshot.cards : state.tablePage?.cards || [], result = queryCards(source.filter(card => !card.archived_at), snapshot.lists, state.config);
  renderTable({ ...result, total: snapshot.loadMode === "complete" ? result.cards.length : state.tablePage?.total ?? result.cards.length, nextCursor: state.tablePage?.nextCursor || null });
}
function adjustOptimisticCard(snapshot, card, delta) {
  snapshot.cardCount = Math.max(0, Number(snapshot.cardCount || 0) + delta);
  let count = snapshot.listCardCounts.find(item => item.listId === card.list_id); if (!count && delta > 0) { count = { listId: card.list_id, count: 0 }; snapshot.listCardCounts.push(count); } if (count) count.count = Math.max(0, Number(count.count || 0) + delta);
  const matchesSearch = queryCards([card], snapshot.lists, { search: state.config.search || "" }).cards.length > 0, queryCounts = state.listQueryCounts;
  if (matchesSearch && queryCounts?.boardId === snapshot.board.id && queryCounts.search === String(state.config.search || "")) queryCounts.counts.set(card.list_id, Math.max(0, Number(queryCounts.counts.get(card.list_id) || 0) + delta));
  const page = state.listPages.get(card.list_id);
  if (page && matchesSearch) { page.total = Math.max(0, Number(page.total || 0) + delta); page.cards = delta > 0 ? [...page.cards, card] : page.cards.filter(item => item !== card); }
}
function tagEditorName() { const original = state.editingTags[state.editingTagIndex], originalFacet = splitFacetTag(original?.name), name = $("#tag-editor-name").value.trim(); return originalFacet?.type === "date" ? `${name}:${$("#tag-editor-date").value}` : name; }
function syncTagColorScope() { const facet = splitFacetTag(tagEditorName()), scope = $("#tag-color-scope"); scope.hidden = !facet; if (!facet) return; $("#tag-color-scope-value").textContent = `Only ${facet.key}:${facet.value}`; $("#tag-color-scope-key").textContent = `All ${facet.key}:* tags`; }
function openTagEditor(index) { const tag = state.editingTags[index], facet = splitFacetTag(tag.name); state.editingTagIndex = index; state.editingTagColor = tagColor(tag); $("#tag-editor-name").value = facet?.type === "date" ? facet.key : tag.name; $("#tag-editor-date-row").hidden = facet?.type !== "date"; $("#tag-editor-date").value = facet?.type === "date" ? facet.value : ""; const scope = $(`input[name="tagColorScope"][value="${tag.colorScope === "key" ? "key" : "value"}"]`); if (scope) scope.checked = true; syncTagColorScope(); $("#tag-color-palette").innerHTML = ["lime", "cyan", "pink", "purple", "yellow"].map(color => `<button type="button" class="tag-color-choice tag-${color}${color === state.editingTagColor ? " active" : ""}" data-tag-color="${color}" aria-label="${color}"></button>`).join(""); $$('[data-tag-color]').forEach(button => button.onclick = () => { state.editingTagColor = button.dataset.tagColor; $$('[data-tag-color]').forEach(item => item.classList.toggle("active", item === button)); }); $("#tag-editor").hidden = false; closeTagSuggestions(); }
$("#tag-editor-name").oninput = syncTagColorScope;
$("#tag-editor-date").oninput = syncTagColorScope;
$("#cancel-tag-edit").onclick = () => $("#tag-editor").hidden = true;
$("#save-tag-edit").onclick = () => { const index = state.editingTagIndex, original = state.editingTags[index], name = tagEditorName(); if (!name || name.endsWith(":")) return; const colorChanged = state.editingTagColor !== tagColor(original), nameChanged = name !== original.name, facet = splitFacetTag(name), colorScope = facet ? ($('input[name="tagColorScope"]:checked')?.value || "value") : "value"; state.editingTags[index] = { ...original, name, color: state.editingTagColor, colorChanged, nameChanged, colorScope }; $("#tag-editor").hidden = true; renderSelectedTags(); };
$("#card-tag-control").onclick = event => { if (!event.target.closest("button")) $("#card-tag-input").focus(); };
$("#card-tag-input").onfocus = renderTagSuggestions;
$("#card-tag-input").oninput = () => { state.tagSuggestionIndex = 0; renderTagSuggestions(); };
$("#card-tag-input").onblur = () => setTimeout(() => { if (!$("#tag-suggestions").contains(document.activeElement)) closeTagSuggestions(); }, 100);
$("#card-tag-input").onkeydown = event => { const suggestions = state.tagSuggestions || []; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!suggestions.length) return; state.tagSuggestionIndex = (state.tagSuggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length; renderTagSuggestions(); } else if (event.key === "Enter" || event.key === ",") { if (suggestions.length) { event.preventDefault(); addTagSuggestion(); } } else if (event.key === "Backspace" && !event.currentTarget.value && state.editingTags.length) { state.editingTags.pop(); renderSelectedTags(); closeTagSuggestions(); } else if (event.key === "Escape") closeTagSuggestions(); };

function openCardDialogFromList(listId) { $("#card-list-field").hidden = true; openCardDialog(null, listId); }
function openCardDialog(card, listId) { const form = $("#card-form"), lists = state.board.lists.filter(list => !list.archived_at).sort((a, b) => a.sort_order - b.sort_order), selectedListId = listId || card?.list_id || lists[0]?.id; form.reset(); form.cardId.value = card?.id || ""; form.listId.innerHTML = lists.map(list => `<option value="${list.id}" ${list.id === selectedListId ? "selected" : ""}>${html(list.name)}</option>`).join(""); form.title.value = card?.title || ""; form.description.value = card?.description || ""; $("#card-dialog-title").textContent = card ? "Edit card" : "New card"; const updateContext = () => $("#card-context").textContent = lists.find(list => list.id === Number(form.listId.value))?.name || "Card"; updateContext(); form.listId.onchange = updateContext; $("#delete-card").hidden = !card; dialogs.card.showModal(); setTimeout(() => form.title.focus(), 0); }
$("#card-form").onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget, cardId = Number(form.cardId.value), listId = Number(form.listId.value), originalCard = getCard(cardId), tagInputs = state.editingTags.map(tag => ({ name: tag.name, ...(!tag.id || tag.colorChanged || tag.nameChanged ? { color: tagColor(tag) } : {}), ...(tag.colorChanged ? { colorScope: tag.colorScope || "value" } : {}) })), body = { listId, title: form.title.value.trim(), description: form.description.value, tags: tagInputs };
  if (cardId) {
    const snapshot = state.board, previous = captureCardMutation(snapshot), oldListId = originalCard.list_id;
    applyOptimisticCardUpdate(snapshot, originalCard, body, tagInputs); dialogs.card.close(); renderOptimisticCardMutation(snapshot);
    queueBoardMutation(snapshot, async revision => {
      const updated = await api(`/api/boards/${snapshot.board.id}/cards/${cardId}`, { method: "PATCH", revision, body: JSON.stringify(body) });
      return oldListId !== originalCard.list_id ? api(`/api/boards/${snapshot.board.id}/cards/${cardId}/move`, { method: "POST", revision: updated.revision, body: JSON.stringify({ listId: originalCard.list_id }) }) : updated;
    }).then(result => {
      originalCard.pending = false; snapshot.board.revision = result.revision; for (const tag of snapshot.tags) tag.pending = false;
      renderOptimisticCardMutation(snapshot); toast("Card updated");
    }).catch(error => {
      restoreCardMutation(snapshot, previous); renderOptimisticCardMutation(snapshot); toast(error.message, true);
    });
    return;
  }
  const snapshot = state.board, tempId = optimisticId(), now = Date.now(), knownCards = [...snapshot.cards, ...state.cardsById.values()].filter(card => card.list_id === listId), optimistic = { id: tempId, board_id: snapshot.board.id, list_id: listId, title: body.title, description: body.description, sort_order: Math.max(0, ...knownCards.map(card => Number(card.sort_order) || 0)) + 1024, archived_at: null, created_at: now, updated_at: now, tags: optimisticCardTags(snapshot, tagInputs), pending: true };
  if (snapshot.loadMode === "complete") snapshot.cards.push(optimistic); state.cardsById.set(tempId, optimistic); adjustOptimisticCard(snapshot, optimistic, 1);
  dialogs.card.close(); renderBoard();
  queueBoardMutation(snapshot, revision => api(`/api/boards/${snapshot.board.id}/cards`, { method: "POST", revision, body: JSON.stringify({ ...body, listId: optimistic.list_id }) }))
    .then(result => {
      state.cardsById.delete(tempId); optimistic.id = result.data.id; optimistic.pending = false; snapshot.board.revision = result.revision; state.cardsById.set(optimistic.id, optimistic);
      if (state.board === snapshot) renderBoard(); toast("Card created");
    })
    .catch(error => {
      snapshot.cards = snapshot.cards.filter(card => card !== optimistic); state.cardsById.delete(tempId); adjustOptimisticCard(snapshot, optimistic, -1);
      snapshot.tags = snapshot.tags.filter(tag => !tag.pending || snapshot.cards.some(card => card.tags?.includes(tag)) || [...state.cardsById.values()].some(card => card.tags?.includes(tag)));
      if (state.board === snapshot) renderBoard(); toast(error.message, true);
    });
};
$("#delete-card").onclick = () => { const cardId = Number($("#card-form").cardId.value), card = getCard(cardId); if (!card) return; dialogs.card.close(); openDeleteConfirmation("Delete card permanently?", `“${card.title}” will be permanently deleted. This cannot be undone.`, "Delete card", async () => { try { await api(`/api/boards/${state.board.board.id}/cards/${cardId}`, { method: "DELETE", revision: state.board.board.revision }); await loadBoard(state.board.board.id); toast("Card deleted"); } catch (error) { toast(error.message, true); } }); };
dialogs.card.addEventListener("close", () => { const cardId = Number($("#card-form").cardId.value); if (cardId) state.activeCardId = cardId; $("#card-list-field").hidden = false; });

async function runTableQuery(append = false) { const host = $("#board-content"); if (!host) return; if (state.board.loadMode === "complete") { const result = queryCards(state.board.cards, state.board.lists, state.config); renderTable({ ...result, total: result.cards.length, nextCursor: null }); return; } const request = ++state.tableRequest; if (!append) { state.tablePage = { cards: [], groups: [], total: 0, nextCursor: null }; host.innerHTML = '<p class="muted table-loading">Loading cards…</p>'; } const page = state.tablePage; try { const result = (await api(`/api/boards/${state.board.board.id}/query`, { method: "POST", body: JSON.stringify({ config: state.config, limit: 100, cursor: append ? page.nextCursor : null }) })).data; if (request !== state.tableRequest) return; page.cards = append ? [...page.cards, ...result.cards] : result.cards; page.total = result.total; page.nextCursor = result.nextCursor; const groups = new Map(append ? page.groups.map(group => [group.key, group]) : []); for (const group of result.groups || []) { const existing = groups.get(group.key); groups.set(group.key, existing ? { ...existing, count: group.count, cardIds: [...existing.cardIds, ...group.cardIds] } : group); } page.groups = [...groups.values()]; cacheCards(result.cards); renderTable(page); } catch (error) { if (request === state.tableRequest) host.innerHTML = `<p class="muted">${html(error.message)}</p>`; } }
function cellValue(card, ref) { if (ref === "title") return card.title; if (ref === "description") return card.description; if (ref === "list") return state.board.lists.find(list => list.id === card.list_id)?.name || ""; if (ref === "tags") return (card.tags || []).map(tag => tag.name).join(", "); if (ref.startsWith("tag:")) { const key = ref.slice(4); return (card.tags || []).flatMap(tag => { const facet = splitFacetTag(tag.name); return facet?.normalizedKey === key ? [facet.value] : []; }).join(", "); } if (ref === "created_at" || ref === "updated_at") return formatDateUtc(card[ref]); return ""; }
function tableCellHtml(card, ref) { if (ref === "tags") return tagBadgesHtml(card.tags) || '<span class="muted">—</span>'; return html(cellValue(card, ref) || "—"); }
function tableHeaderHtml(ref) { const index = (state.config.sorts || []).findIndex(sort => sort.field === ref), sort = index >= 0 ? state.config.sorts[index] : null, label = fieldLabel(state.board, ref), next = !sort ? "ascending" : sort.direction === "asc" ? "descending" : "no sorting"; return `<th aria-sort="${sort ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}"><button type="button" class="table-sort" data-sort-field="${html(ref)}" aria-label="Sort ${html(label)} ${next}"><span>${html(label)}</span>${sort ? `<span class="sort-indicator">${sort.direction === "asc" ? icons.arrowUp : icons.arrowDown}<b>${index + 1}</b></span>` : '<span class="sort-idle" aria-hidden="true">↕</span>'}</button></th>`; }
function toggleTableSort(ref) { state.config.sorts ||= []; const index = state.config.sorts.findIndex(sort => sort.field === ref); if (index < 0) state.config.sorts.push({ field: ref, direction: "asc" }); else if (state.config.sorts[index].direction === "asc") state.config.sorts[index].direction = "desc"; else state.config.sorts.splice(index, 1); runTableQuery(); updateUrlConfig(); }
const TABLE_VIRTUAL_THRESHOLD = 100, TABLE_WINDOW_SIZE = 80, TABLE_ROW_HEIGHT = 30, TABLE_OVERSCAN = 15;
function tableRows(result) { const cardById = new Map(result.cards.map(card => [card.id, card])); return result.groups?.length ? result.groups.flatMap(group => [{ group }, ...group.cardIds.map(id => ({ card: cardById.get(id) })).filter(item => item.card)]) : result.cards.map(card => ({ card })); }
function tableRowHtml(row, columns) { return row.group ? `<tr class="group-row"><td colspan="${columns.length}">${html(row.group.label)} <span class="count">${row.group.count ?? row.group.cardIds.length}</span></td></tr>` : `<tr data-card-id="${row.card.id}">${columns.map(ref => `<td>${tableCellHtml(row.card, ref)}</td>`).join("")}</tr>`; }
function tableBodyMarkup(rows, columns, virtual) { if (!rows.length) return `<tr><td colspan="${columns.length}" class="muted">No cards match this view.</td></tr>`; if (rows.length <= TABLE_VIRTUAL_THRESHOLD) return rows.map(row => tableRowHtml(row, columns)).join(""); const maxStart = Math.max(0, rows.length - TABLE_WINDOW_SIZE), start = Math.min(virtual.start || 0, maxStart), end = Math.min(rows.length, start + TABLE_WINDOW_SIZE); return `<tr class="table-virtual-spacer" aria-hidden="true"><td colspan="${columns.length}" style="height:${start * TABLE_ROW_HEIGHT}px"></td></tr>${rows.slice(start, end).map(row => tableRowHtml(row, columns)).join("")}<tr class="table-virtual-spacer" aria-hidden="true"><td colspan="${columns.length}" style="height:${(rows.length - end) * TABLE_ROW_HEIGHT}px"></td></tr>`; }
function bindTableRows() { $$("tr[data-card-id]").forEach(row => row.onclick = () => { const card = getCard(row.dataset.cardId); if (card) openCardDialog(card, card.list_id); }); bindTagFilters($(".data-table")); }
function renderTable(result) { const columns = (state.config.columns?.length ? state.config.columns : allColumns(state.board).map(item => item.id)).filter(ref => allColumns(state.board).some(item => item.id === ref)), rows = tableRows(result), signature = JSON.stringify(state.config); if (!state.tableVirtual || state.tableVirtual.signature !== signature) state.tableVirtual = { signature, start: 0, scrollTop: 0 }; const virtual = state.tableVirtual, isVirtual = rows.length > TABLE_VIRTUAL_THRESHOLD; $("#board-content").innerHTML = `<div class="table-shell${isVirtual ? " virtualized" : ""}"><table class="data-table"><thead><tr>${columns.map(tableHeaderHtml).join("")}</tr></thead><tbody>${tableBodyMarkup(rows, columns, virtual)}</tbody></table>${result.nextCursor ? `<div class="table-pagination"><span>${result.cards.length} of ${result.total}</span><button id="load-table-more" class="button ghost small" type="button">Load more</button></div>` : ""}</div>`; const shell = $(".table-shell"); shell.scrollTop = virtual.scrollTop || 0; if (isVirtual) shell.onscroll = () => { virtual.scrollTop = shell.scrollTop; const next = Math.max(0, Math.floor(shell.scrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN); if (next === virtual.start) return; virtual.start = next; $(".data-table tbody", shell).innerHTML = tableBodyMarkup(rows, columns, virtual); bindTableRows(); }; $$(".table-sort").forEach(button => button.onclick = () => toggleTableSort(button.dataset.sortField)); bindTableRows(); $("#load-table-more")?.addEventListener("click", () => runTableQuery(true)); }
$("#view-form").onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; try { await api(`/api/boards/${state.board.board.id}/views`, { method: "POST", revision: state.board.board.revision, body: JSON.stringify({ name: form.name.value, isDefault: form.isDefault.checked, config: state.config }) }); dialogs.view.close(); await loadBoard(state.board.board.id); state.viewMode = "table"; renderBoard(); toast("View saved"); } catch (error) { toast(error.message, true); } };

function closeBoardMenu(event) { const menu = $(".board-menu-wrap"); if (menu?.open && (!event || !menu.contains(event.target))) menu.open = false; }
$("#share-space").onclick = openShareDialog;
document.addEventListener("click", closeBoardMenu, true);
document.addEventListener("keydown", event => { if (event.key !== "Escape") return; const boardMenu = $(".board-menu-wrap"); if (boardMenu?.open) { boardMenu.open = false; $("#board-menu")?.focus(); } });
document.addEventListener("keydown", event => {
  const key = event.key.toLocaleLowerCase(), boardOpen = Boolean(new URLSearchParams(location.search).get("board") && state.board), fieldFocused = event.target.matches("input,textarea,select,[contenteditable=true]"), modalOpen = Boolean($("dialog[open]"));
  if (!boardOpen || fieldFocused || modalOpen || event.metaKey || event.ctrlKey || event.altKey) return;
  if (key === "a") { const lists = state.board.lists.filter(list => !list.archived_at).sort((a, b) => a.sort_order - b.sort_order), activeCard = getCard(state.activeCardId); if (!lists.length) return; event.preventDefault(); openCardDialog(null, activeCard?.list_id || lists[0].id); }
  else if (key === "/" && state.viewMode === "board") { event.preventDefault(); $("#board-search")?.focus(); }
});
$$('[data-route]').forEach(item => item.addEventListener("click", event => { event.preventDefault(); setRoute(item.dataset.route); })); window.addEventListener("popstate", route); boot().catch(error => { $("#loading").innerHTML = `<p>${html(error.message)}</p>`; });
