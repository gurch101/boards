import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createD1Admin } from "d1-admin";
import { generateAccessKey, normalizeSearch, sha256 } from "./crypto";
import { cardTagStatements, parseCardTags, readBoard, readCards, readCardsByIds } from "./data";
import { ApiError, validationError } from "./errors";
import { queryCards } from "./query";
import type { Bindings, BoardRow, Space, ViewConfig } from "./types";

type Env = { Bindings: Bindings; Variables: { space: Space; capability: string } };
type AppContext = Context<Env>;
const app = new Hono<Env>();
const privateHeaders = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };

const admin = createD1Admin<Bindings>({
  database: env => env.DB, name: "Boards", basePath: "/admin",
  access: env => ({ teamDomain: String(env.CF_ACCESS_TEAM_DOMAIN || ""), audience: String(env.CF_ACCESS_AUD || ""), devBypass: env.D1_ADMIN_DEV === "true" }),
  tables: { spaces: { columns: { access_key_hash: { sensitive: true } } } }
});

function error(c: AppContext, status: 400 | 401 | 404 | 409 | 412 | 422 | 500, code: string, message: string, fieldErrors?: Record<string, string>) {
  return c.json({ error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } }, status);
}
function cleanName(value: unknown, label = "Name") { const name = String(value || "").trim(); if (!name) throw validationError(`${label} is required`); if (name.length > 120) throw validationError(`${label} must be 120 characters or fewer`); return name; }
function id(value: string | undefined) { return Number(value); }
function entityId() { const values = crypto.getRandomValues(new Uint32Array(2)); return (values[0] & 0xfffff) * 4294967296 + values[1] + 1; }
function expectedRevision(c: AppContext) { const raw = c.req.header("If-Match")?.replaceAll('"', ""); return raw && /^\d+$/.test(raw) ? Number(raw) : null; }
async function body<T>(c: AppContext) { return c.req.json<T>().catch(() => { throw validationError("A valid JSON body is required"); }); }
async function boardFor(c: AppContext, boardId: number) { return c.env.DB.prepare("SELECT id,space_id,name,description,revision,sort_order,archived_at,created_at,updated_at FROM boards WHERE id=? AND space_id=?").bind(boardId, c.var.space.id).first<BoardRow>(); }
type BoardLookup = { board: BoardRow; response?: never } | { board?: never; response: Response };
async function loadBoardRow(c: AppContext, boardId: number): Promise<BoardLookup> { const board = await boardFor(c, boardId); return board ? { board } : { response: error(c, 404, "not_found", "Board not found") }; }
async function commitBoardMutation(c: AppContext, board: BoardRow, statements: D1PreparedStatement[]) {
  const expected = expectedRevision(c), db = c.env.DB;
  const claim = db.prepare("UPDATE boards SET revision=revision+1,updated_at=? WHERE id=? AND space_id=? AND revision=?").bind(Date.now(), board.id, board.space_id, expected);
  const assertClaimed = db.prepare("INSERT INTO boards(space_id,name,description,revision,sort_order,created_at,updated_at) SELECT NULL,'','',0,0,0,0 WHERE changes()=0");
  try { const results = await db.batch([claim, assertClaimed, ...statements]); return { results: results.slice(2), revision: Number(expected) + 1 }; }
  catch (cause) { if (/NOT NULL constraint failed: boards\.space_id/i.test(cause instanceof Error ? cause.message : String(cause))) throw new ApiError(412, "stale_revision", "The board changed; reload and try again"); throw cause; }
}
function encodeCursor(value: unknown) { return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decodeCursor<T>(value: unknown): T | null { try { const raw = String(value || "").replaceAll("-", "+").replaceAll("_", "/"); return JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "="))) as T; } catch { return null; } }
function pageLimit(value: unknown, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : fallback; }
function querySignature(config: ViewConfig) { return JSON.stringify({ search: config.search || "", filters: config.filters || [], groupBy: config.groupBy || null, sorts: config.sorts || [] }); }

const lifecycle: MiddlewareHandler<Env> = async (c, next) => {
  const started = Date.now(); const requestId = crypto.randomUUID(); c.header("X-Request-ID", requestId);
  Object.entries(privateHeaders).forEach(([key, value]) => c.header(key, value));
  try { await next(); } finally {
    Object.entries(privateHeaders).forEach(([key, value]) => c.header(key, value));
    const path = c.req.path.startsWith("/p/") ? "/p/:capability" : c.req.path;
    console.log(JSON.stringify({ requestId, method: c.req.method, path, status: c.res.status, durationMs: Date.now() - started }));
  }
};
app.use("*", lifecycle);
app.all("/admin", c => admin.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/admin/*", c => admin.fetch(c.req.raw, c.env, c.executionCtx));

app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) { const origin = c.req.header("Origin"); if (origin && origin !== new URL(c.req.url).origin) return error(c, 401, "origin_rejected", "Cross-origin requests are not allowed"); }
  await next();
});

app.post("/api/spaces", async c => {
  const accessKey = generateAccessKey(), now = Date.now();
  const accessKeyHash = await sha256(accessKey);
  await c.env.DB.prepare("INSERT INTO spaces(access_key_hash,created_at) VALUES(?,?)").bind(accessKeyHash, now).run();
  return c.json({ data: { path: `/p/${accessKey}` } }, 201);
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/spaces") return next();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("Authorization") || "");
  if (!match) return error(c, 401, "unauthorized", "A valid private-space capability is required");
  const space = await c.env.DB.prepare("SELECT id,access_key_hash,name,created_at FROM spaces WHERE access_key_hash=?").bind(await sha256(match[1])).first<Space>();
  if (!space) return error(c, 401, "unauthorized", "This private-space capability is not valid");
  c.set("space", space); c.set("capability", match[1]); await next();
});

app.get("/api/bootstrap", async c => {
  const boards = await c.env.DB.prepare("SELECT id,name,description,revision,sort_order,archived_at,created_at,updated_at FROM boards WHERE space_id=? AND archived_at IS NULL ORDER BY sort_order,id").bind(c.var.space.id).all();
  return c.json({ data: { space: { id: c.var.space.id, name: c.var.space.name }, boards: boards.results } });
});

app.post("/api/boards", async c => {
  const input = await body<{ name?: unknown; description?: unknown }>(c), now = Date.now();
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) value FROM boards WHERE space_id=?").bind(c.var.space.id).first<{ value: number }>();
  const boardId = entityId();
  await c.env.DB.batch([c.env.DB.prepare("INSERT INTO boards(id,space_id,name,description,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(boardId, c.var.space.id, cleanName(input.name, "Board name"), String(input.description || ""), Number(max?.value || 0) + 1024, now, now), ...["To do", "Doing", "Done"].map((name, index) => c.env.DB.prepare("INSERT INTO board_lists(space_id,board_id,name,sort_order) VALUES(?,?,?,?)").bind(c.var.space.id, boardId, name, index * 1024))]);
  return c.json({ data: { id: boardId }, revision: 0 }, 201);
});
app.get("/api/boards/:id", async c => { const result = await readBoard(c.env.DB, c.var.space.id, id(c.req.param("id"))); return result ? c.json({ data: result, revision: result.board.revision }, 200, { ETag: `"${result.board.revision}"` }) : error(c, 404, "not_found", "Board not found"); });
app.patch("/api/boards/:id", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ name?: unknown; description?: unknown }>(c);
  const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("UPDATE boards SET name=?,description=? WHERE id=? AND space_id=?").bind(input.name === undefined ? board.name : cleanName(input.name, "Board name"), input.description === undefined ? board.description : String(input.description), board.id, c.var.space.id)]);
  return c.json({ data: { id: board.id }, revision: mutation.revision });
});
app.delete("/api/boards/:id", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board;
  await commitBoardMutation(c, board, [c.env.DB.prepare("DELETE FROM boards WHERE id=? AND space_id=?").bind(board.id, c.var.space.id)]); return c.body(null, 204);
});
app.post("/api/boards/:id/move", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ beforeId?: unknown }>(c), beforeId = Number(input.beforeId || 0); const rows = await c.env.DB.prepare("SELECT id FROM boards WHERE space_id=? AND archived_at IS NULL AND id<>? ORDER BY sort_order,id").bind(c.var.space.id, board.id).all<{ id: number }>(); const ids = rows.results.map(row => row.id), at = beforeId ? ids.indexOf(beforeId) : ids.length; ids.splice(at < 0 ? ids.length : at, 0, board.id); const mutation = await commitBoardMutation(c, board, ids.map((boardId, index) => c.env.DB.prepare("UPDATE boards SET sort_order=? WHERE id=? AND space_id=?").bind(index * 1024, boardId, c.var.space.id))); return c.json({ data: { id: board.id }, revision: mutation.revision });
});
app.post("/api/boards/:id/query", async c => {
  const snapshot = await readBoard(c.env.DB, c.var.space.id, id(c.req.param("id"))); if (!snapshot) return error(c, 404, "not_found", "Board not found");
  const input = await body<ViewConfig & { config?: ViewConfig; limit?: unknown; cursor?: unknown }>(c), config = input.config || input, legacy = !input.config && input.limit === undefined && input.cursor === undefined, limit = legacy ? Number.MAX_SAFE_INTEGER : pageLimit(input.limit, 100), signature = querySignature(config);
  const cursor = input.cursor ? decodeCursor<{ revision: number; offset: number; signature: string }>(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.revision !== snapshot.board.revision || cursor.signature !== signature)) return error(c, 409, "cursor_expired", "This result set changed; reload it from the beginning");
  const allCards = snapshot.loadMode === "complete" ? snapshot.cards : await readCards(c.env.DB, c.var.space.id, snapshot.board.id), result = queryCards(allCards, snapshot.lists, config), offset = Math.max(0, Number(cursor?.offset || 0)), cards = result.cards.slice(offset, offset + limit), ids = new Set(cards.map(card => card.id)), nextOffset = offset + cards.length;
  const groups = result.groups.map(group => ({ ...group, count: group.cardIds.length, cardIds: group.cardIds.filter(cardId => ids.has(cardId)) }));
  return c.json({ data: { cards, groups, total: result.cards.length, nextCursor: nextOffset < result.cards.length ? encodeCursor({ revision: snapshot.board.revision, offset: nextOffset, signature }) : null }, revision: snapshot.board.revision });
});

app.post("/api/boards/:boardId/lists/:listId/cards/query", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const listId = id(c.req.param("listId")), list = await c.env.DB.prepare("SELECT id FROM board_lists WHERE id=? AND board_id=? AND space_id=? AND archived_at IS NULL").bind(listId, board.id, c.var.space.id).first(); if (!list) return error(c, 404, "not_found", "List not found");
  const input = await body<{ search?: unknown; limit?: unknown; cursor?: unknown }>(c), search = normalizeSearch(input.search || ""), limit = pageLimit(input.limit, 50), signature = search;
  const cursor = input.cursor ? decodeCursor<{ revision: number; sortOrder: number; id: number; signature: string }>(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.revision !== board.revision || cursor.signature !== signature)) return error(c, 409, "cursor_expired", "This list changed; reload it from the beginning");
  const filter = search ? "AND instr(search_text,?)>0" : "", after = cursor ? "AND (sort_order>? OR (sort_order=? AND id>?))" : "", baseBindings: unknown[] = [board.id, listId, c.var.space.id, ...(search ? [search] : [])], afterBindings: unknown[] = cursor ? [cursor.sortOrder, cursor.sortOrder, cursor.id] : [];
  const total = await c.env.DB.prepare(`SELECT COUNT(*) count FROM cards WHERE board_id=? AND list_id=? AND space_id=? AND archived_at IS NULL ${filter}`).bind(...baseBindings).first<{ count: number }>();
  const rows = await c.env.DB.prepare(`SELECT id,sort_order FROM cards WHERE board_id=? AND list_id=? AND space_id=? AND archived_at IS NULL ${filter} ${after} ORDER BY sort_order,id LIMIT ?`).bind(...baseBindings, ...afterBindings, limit + 1).all<{ id: number; sort_order: number }>();
  const visible = rows.results.slice(0, limit), extra = rows.results[limit], cards = await readCardsByIds(c.env.DB, c.var.space.id, board.id, visible.map(row => Number(row.id))), last = visible.at(-1);
  return c.json({ data: { cards, total: Number(total?.count || 0), nextCardId: extra ? Number(extra.id) : null, nextCursor: extra && last ? encodeCursor({ revision: board.revision, sortOrder: Number(last.sort_order), id: Number(last.id), signature }) : null }, revision: board.revision });
});

app.post("/api/boards/:boardId/lists/counts", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ search?: unknown }>(c), search = normalizeSearch(input.search || ""), filter = search ? "AND instr(search_text,?)>0" : "";
  const rows = await c.env.DB.prepare(`SELECT list_id,COUNT(*) count FROM cards WHERE board_id=? AND space_id=? AND archived_at IS NULL ${filter} GROUP BY list_id`).bind(board.id, c.var.space.id, ...(search ? [search] : [])).all<{ list_id: number; count: number }>();
  return c.json({ data: { counts: rows.results.map(row => ({ listId: Number(row.list_id), count: Number(row.count) })) }, revision: board.revision });
});

app.post("/api/boards/:id/lists", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ name?: unknown }>(c), max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) value FROM board_lists WHERE board_id=?").bind(board.id).first<{ value: number }>();
  const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("INSERT INTO board_lists(space_id,board_id,name,sort_order) VALUES(?,?,?,?)").bind(c.var.space.id, board.id, cleanName(input.name, "List name"), Number(max?.value || 0) + 1024)]); return c.json({ data: { id: Number(mutation.results[0].meta.last_row_id) }, revision: mutation.revision }, 201);
});
app.patch("/api/boards/:boardId/lists/:listId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ name?: unknown }>(c); const list = await c.env.DB.prepare("SELECT name FROM board_lists WHERE id=? AND board_id=? AND space_id=?").bind(id(c.req.param("listId")), board.id, c.var.space.id).first<{ name: string }>(); if (!list) return error(c, 404, "not_found", "List not found");
  const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("UPDATE board_lists SET name=? WHERE id=?").bind(input.name === undefined ? list.name : cleanName(input.name, "List name"), id(c.req.param("listId")))]); return c.json({ data: { id: id(c.req.param("listId")) }, revision: mutation.revision });
});
app.delete("/api/boards/:boardId/lists/:listId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const listId = id(c.req.param("listId")), list = await c.env.DB.prepare("SELECT id FROM board_lists WHERE id=? AND board_id=? AND space_id=?").bind(listId, board.id, c.var.space.id).first(); if (!list) return error(c, 404, "not_found", "List not found");
  const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("DELETE FROM cards WHERE list_id=? AND board_id=? AND space_id=?").bind(listId, board.id, c.var.space.id), c.env.DB.prepare("DELETE FROM board_lists WHERE id=? AND board_id=? AND space_id=?").bind(listId, board.id, c.var.space.id)]); return c.json({ data: { deleted: true }, revision: mutation.revision });
});
app.post("/api/boards/:boardId/lists/:listId/move", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const listId = id(c.req.param("listId")), input = await body<{ beforeId?: unknown }>(c), beforeId = Number(input.beforeId || 0); const rows = await c.env.DB.prepare("SELECT id FROM board_lists WHERE board_id=? AND archived_at IS NULL AND id<>? ORDER BY sort_order,id").bind(board.id, listId).all<{ id: number }>(); const ids = rows.results.map(row => row.id), at = beforeId ? ids.indexOf(beforeId) : ids.length; ids.splice(at < 0 ? ids.length : at, 0, listId); const mutation = await commitBoardMutation(c, board, ids.map((item, index) => c.env.DB.prepare("UPDATE board_lists SET sort_order=? WHERE id=? AND board_id=?").bind(index * 1024, item, board.id))); return c.json({ data: { id: listId }, revision: mutation.revision });
});

app.post("/api/boards/:id/cards", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ listId?: unknown; title?: unknown; description?: unknown; tags?: unknown }>(c), listId = Number(input.listId), now = Date.now();
  const list = await c.env.DB.prepare("SELECT id FROM board_lists WHERE id=? AND board_id=? AND space_id=? AND archived_at IS NULL").bind(listId, board.id, c.var.space.id).first(); if (!list) return error(c, 422, "validation_failed", "Choose an active list");
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) value FROM cards WHERE board_id=? AND list_id=? AND archived_at IS NULL").bind(board.id, listId).first<{ value: number }>(); const title = cleanName(input.title, "Card title"), description = String(input.description || ""), tags = parseCardTags(input.tags), cardId = entityId();
  const insert = c.env.DB.prepare("INSERT INTO cards(id,space_id,board_id,list_id,title,description,search_text,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(cardId, c.var.space.id, board.id, listId, title, description, normalizeSearch(title, description, ...tags.map(tag => tag.name)), Number(max?.value || 0) + 1024, now, now);
  const mutation = await commitBoardMutation(c, board, [insert, ...cardTagStatements(c.env.DB, c.var.space, cardId, tags)]);
  return c.json({ data: { id: cardId }, revision: mutation.revision }, 201);
});
app.patch("/api/boards/:boardId/cards/:cardId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const card = await c.env.DB.prepare("SELECT id,board_id,title,description FROM cards WHERE id=? AND board_id=? AND space_id=?").bind(id(c.req.param("cardId")), board.id, c.var.space.id).first<{ id: number; board_id: number; title: string; description: string }>(); if (!card) return error(c, 404, "not_found", "Card not found");
  const input = await body<{ title?: unknown; description?: unknown; tags?: unknown }>(c), title = input.title === undefined ? card.title : cleanName(input.title, "Card title"), description = input.description === undefined ? card.description : String(input.description);
  const tags = input.tags === undefined ? null : parseCardTags(input.tags), existingTags = tags ? [] : (await c.env.DB.prepare("SELECT t.name FROM card_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.card_id=? AND ct.space_id=? ORDER BY t.name").bind(card.id, c.var.space.id).all<{ name: string }>()).results.map(tag => tag.name);
  const update = c.env.DB.prepare("UPDATE cards SET title=?,description=?,search_text=?,updated_at=? WHERE id=? AND space_id=?").bind(title, description, normalizeSearch(title, description, ...(tags ? tags.map(tag => tag.name) : existingTags)), Date.now(), card.id, c.var.space.id);
  const mutation = await commitBoardMutation(c, board, [update, ...(tags ? cardTagStatements(c.env.DB, c.var.space, card.id, tags) : [])]); return c.json({ data: { id: card.id }, revision: mutation.revision });
});
app.delete("/api/boards/:boardId/cards/:cardId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board; const cardId = id(c.req.param("cardId")), card = await c.env.DB.prepare("SELECT id FROM cards WHERE id=? AND board_id=? AND space_id=?").bind(cardId, board.id, c.var.space.id).first(); if (!card) return error(c, 404, "not_found", "Card not found"); const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("DELETE FROM cards WHERE id=? AND board_id=? AND space_id=?").bind(cardId, board.id, c.var.space.id)]); return c.json({ data: { deleted: true }, revision: mutation.revision });
});
app.post("/api/boards/:boardId/cards/:cardId/move", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board;
  const input = await body<{ listId?: unknown; beforeId?: unknown; placement?: "start" | "end" }>(c), listId = Number(input.listId), cardId = id(c.req.param("cardId")); const list = await c.env.DB.prepare("SELECT id FROM board_lists WHERE id=? AND board_id=? AND archived_at IS NULL").bind(listId, board.id).first(); if (!list) return error(c, 422, "validation_failed", "Choose an active list");
  const rows = await c.env.DB.prepare("SELECT id FROM cards WHERE board_id=? AND list_id=? AND archived_at IS NULL AND id<>? ORDER BY sort_order,id").bind(board.id, listId, cardId).all<{ id: number }>(); const ids = rows.results.map(row => row.id), before = Number(input.beforeId || 0), at = before ? Math.max(0, ids.indexOf(before)) : ids.length; ids.splice(at < 0 ? ids.length : at, 0, cardId);
  if (input.placement === "start") { const current = ids.indexOf(cardId); ids.splice(current, 1); ids.unshift(cardId); }
  const mutation = await commitBoardMutation(c, board, ids.map((item, index) => c.env.DB.prepare("UPDATE cards SET list_id=?,sort_order=?,updated_at=? WHERE id=? AND board_id=? AND space_id=?").bind(listId, index * 1024, Date.now(), item, board.id, c.var.space.id))); return c.json({ data: { id: cardId }, revision: mutation.revision });
});

app.post("/api/boards/:id/views", async c => {
  const found = await loadBoardRow(c, id(c.req.param("id"))); if (found.response) return found.response; const board = found.board; const input = await body<{ name?: unknown; config?: ViewConfig; isDefault?: boolean }>(c), now = Date.now(), statements = input.isDefault ? [c.env.DB.prepare("UPDATE saved_views SET is_default=0 WHERE board_id=?").bind(board.id)] : []; statements.push(c.env.DB.prepare("INSERT INTO saved_views(space_id,board_id,name,config_json,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(c.var.space.id, board.id, cleanName(input.name, "View name"), JSON.stringify(input.config || {}), input.isDefault ? 1 : 0, now, now)); const mutation = await commitBoardMutation(c, board, statements); return c.json({ data: { id: Number(mutation.results.at(-1)!.meta.last_row_id) }, revision: mutation.revision }, 201);
});
app.put("/api/boards/:boardId/views/:viewId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board; const viewId = id(c.req.param("viewId")), view = await c.env.DB.prepare("SELECT id FROM saved_views WHERE id=? AND board_id=? AND space_id=?").bind(viewId, board.id, c.var.space.id).first(); if (!view) return error(c, 404, "not_found", "Saved view not found"); const input = await body<{ name?: unknown; config?: ViewConfig; isDefault?: boolean }>(c), statements = input.isDefault ? [c.env.DB.prepare("UPDATE saved_views SET is_default=0 WHERE board_id=?").bind(board.id)] : []; statements.push(c.env.DB.prepare("UPDATE saved_views SET name=?,config_json=?,is_default=?,updated_at=? WHERE id=? AND board_id=? AND space_id=?").bind(cleanName(input.name, "View name"), JSON.stringify(input.config || {}), input.isDefault ? 1 : 0, Date.now(), viewId, board.id, c.var.space.id)); const mutation = await commitBoardMutation(c, board, statements); return c.json({ data: { id: viewId }, revision: mutation.revision });
});
app.delete("/api/boards/:boardId/views/:viewId", async c => {
  const found = await loadBoardRow(c, id(c.req.param("boardId"))); if (found.response) return found.response; const board = found.board; const mutation = await commitBoardMutation(c, board, [c.env.DB.prepare("DELETE FROM saved_views WHERE id=? AND board_id=? AND space_id=?").bind(id(c.req.param("viewId")), board.id, c.var.space.id)]); return c.json({ data: { deleted: true }, revision: mutation.revision });
});

function serveIndex(c: AppContext) {
  const url = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
}
function serveDocs(c: AppContext) {
  const url = new URL("/docs.html", c.req.url);
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
}
function serveOpenApi(c: AppContext) {
  const url = new URL("/openapi.json", c.req.url);
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
}
function serveManifest(c: AppContext) {
  const url = new URL("/manifest.webmanifest", c.req.url);
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
}
app.get("/", serveIndex);
app.get("/p/:capability", serveIndex);
app.get("/docs", serveDocs);
app.get("/openapi.json", serveOpenApi);
app.get("/manifest.webmanifest", serveManifest);
app.onError((cause, c) => {
  console.error(cause);
  if (cause instanceof ApiError) return error(c, cause.status, cause.code, cause.message);
  if (/UNIQUE constraint/i.test(cause instanceof Error ? cause.message : String(cause))) return error(c, 409, "conflict", "A record with that name already exists");
  return error(c, 500, "internal_error", "An unexpected server error occurred");
});

export default app;
export { queryCards } from "./query";
