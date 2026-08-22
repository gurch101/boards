import type { BoardRow, CardModel, ListRow, Space, Tag } from "./types";
import { validationError } from "./errors";

type AnyRow = Record<string, unknown>;

export async function readCards(db: D1Database, spaceId: number, boardId: number, includeArchived = false): Promise<CardModel[]> {
  const [cards, tagRows] = await db.batch([
    db.prepare(`SELECT id,board_id,list_id,title,description,sort_order,archived_at,created_at,updated_at FROM cards WHERE space_id=? AND board_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY list_id,sort_order,id`).bind(spaceId, boardId),
    db.prepare(`SELECT ct.card_id,t.id,t.name,t.color FROM card_tags ct JOIN tags t ON t.id=ct.tag_id AND t.space_id=ct.space_id WHERE ct.card_id IN (SELECT id FROM cards WHERE board_id=? AND space_id=? ${includeArchived ? "" : "AND archived_at IS NULL"}) ORDER BY ct.card_id,t.name`).bind(boardId, spaceId)
  ]) as [D1Result<AnyRow>, D1Result<AnyRow>];
  if (!cards.results.length) return [];
  const tagMap = new Map<number, Tag[]>();
  for (const row of tagRows.results) { const cardId = Number(row.card_id); tagMap.set(cardId, [...(tagMap.get(cardId) || []), { id: Number(row.id), name: String(row.name), color: String(row.color) }]); }
  return cards.results.map(row => ({ id: Number(row.id), board_id: Number(row.board_id), list_id: Number(row.list_id), title: String(row.title), description: String(row.description), sort_order: Number(row.sort_order), archived_at: row.archived_at === null ? null : Number(row.archived_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at), tags: tagMap.get(Number(row.id)) || [] }));
}

export async function readCardsByIds(db: D1Database, spaceId: number, boardId: number, cardIds: number[]): Promise<CardModel[]> {
  if (!cardIds.length) return [];
  const wanted = [...new Set(cardIds.map(Number).filter(Number.isFinite))], placeholders = wanted.map(() => "?").join(",");
  const [cards, tagRows] = await db.batch([
    db.prepare(`SELECT id,board_id,list_id,title,description,sort_order,archived_at,created_at,updated_at FROM cards WHERE space_id=? AND board_id=? AND id IN (${placeholders})`).bind(spaceId, boardId, ...wanted),
    db.prepare(`SELECT ct.card_id,t.id,t.name,t.color FROM card_tags ct JOIN tags t ON t.id=ct.tag_id AND t.space_id=ct.space_id WHERE ct.card_id IN (${placeholders}) ORDER BY ct.card_id,t.name`).bind(...wanted)
  ]) as [D1Result<AnyRow>, D1Result<AnyRow>];
  const tagMap = new Map<number, Tag[]>();
  for (const row of tagRows.results) { const cardId = Number(row.card_id); tagMap.set(cardId, [...(tagMap.get(cardId) || []), { id: Number(row.id), name: String(row.name), color: String(row.color) }]); }
  const byId = new Map(cards.results.map(row => [Number(row.id), { id: Number(row.id), board_id: Number(row.board_id), list_id: Number(row.list_id), title: String(row.title), description: String(row.description), sort_order: Number(row.sort_order), archived_at: row.archived_at === null ? null : Number(row.archived_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at), tags: tagMap.get(Number(row.id)) || [] } as CardModel]));
  return wanted.flatMap(cardId => byId.has(cardId) ? [byId.get(cardId)!] : []);
}

export async function readBoard(db: D1Database, spaceId: number, boardId: number, includeArchived = false) {
  const [boardRows, lists, views, tags, counts] = await db.batch([
    db.prepare("SELECT id,space_id,name,description,revision,sort_order,archived_at,created_at,updated_at FROM boards WHERE id=? AND space_id=?").bind(boardId, spaceId),
    db.prepare(`SELECT id,board_id,name,sort_order,archived_at FROM board_lists WHERE board_id=? AND space_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY sort_order,id`).bind(boardId, spaceId),
    db.prepare("SELECT id,board_id,name,config_json,is_default,created_at,updated_at FROM saved_views WHERE board_id=? AND space_id=? ORDER BY name").bind(boardId, spaceId),
    db.prepare("SELECT id,name,color FROM tags WHERE space_id=? ORDER BY name").bind(spaceId),
    db.prepare(`SELECT list_id,COUNT(*) count FROM cards WHERE board_id=? AND space_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} GROUP BY list_id`).bind(boardId, spaceId)
  ]) as [D1Result<BoardRow>, D1Result<ListRow>, D1Result<AnyRow>, D1Result<Tag>, D1Result<{ list_id: number; count: number }>];
  const board = boardRows.results[0];
  if (!board) return null;
  const listCardCounts = counts.results.map(row => ({ listId: Number(row.list_id), count: Number(row.count) })), cardCount = listCardCounts.reduce((sum, item) => sum + item.count, 0), loadMode = cardCount <= 1000 || includeArchived ? "complete" as const : "paginated" as const;
  return { board, lists: lists.results, cards: loadMode === "complete" ? await readCards(db, spaceId, boardId, includeArchived) : [], cardCount, listCardCounts, loadMode, tags: tags.results, views: views.results.map(row => ({ ...row, config: JSON.parse(String(row.config_json)), config_json: undefined })) };
}

export type CardTagInput = { name: string; normalized: string; color: string; explicitColor: boolean; colorScope: "key" | "value" };

export function parseCardTags(input: unknown): CardTagInput[] {
  const palette = new Set(["lime", "cyan", "pink", "purple", "yellow"]), uniqueTags = new Map<string, { name: string; color?: string; colorScope?: "key" | "value" }>();
  if (Array.isArray(input)) for (const value of input) { const object = value && typeof value === "object" ? value as Record<string, unknown> : null, name = String(object?.name ?? value ?? "").trim(), normalized = name.normalize("NFKC").toLocaleLowerCase(), color = palette.has(String(object?.color)) ? String(object?.color) : undefined, colorScope = object?.colorScope === "key" ? "key" : "value"; if (name && !uniqueTags.has(normalized)) uniqueTags.set(normalized, { name, color, colorScope }); }
  const tags = [...uniqueTags.values()];
  if (tags.length > 20) throw validationError("A card can have at most 20 tags");
  const colors = ["lime", "cyan", "pink", "purple", "yellow"];
  return tags.map(inputTag => {
    if (inputTag.name.length > 40) throw validationError("Tags must be 40 characters or fewer");
    const normalized = inputTag.name.normalize("NFKC").toLocaleLowerCase();
    return { name: inputTag.name, normalized, color: inputTag.color || colors[Math.abs([...normalized].reduce((sum, char) => sum + char.codePointAt(0)!, 0)) % colors.length], explicitColor: Boolean(inputTag.color), colorScope: inputTag.colorScope || "value" };
  });
}

export function cardTagStatements(db: D1Database, space: Space, cardId: number, tags: CardTagInput[]) {
  const statements: D1PreparedStatement[] = [];
  for (const tag of tags) {
    statements.push(db.prepare("INSERT INTO tags(space_id,name,normalized_name,color,created_at) VALUES(?,?,?,?,?) ON CONFLICT(space_id,normalized_name) DO UPDATE SET color=CASE WHEN ? THEN excluded.color ELSE tags.color END").bind(space.id, tag.name, tag.normalized, tag.color, Date.now(), tag.explicitColor ? 1 : 0));
    const facetAt = tag.normalized.indexOf(":"), facetKey = facetAt > 0 ? tag.normalized.slice(0, facetAt).trim() : "";
    if (tag.explicitColor && facetKey && tag.colorScope === "key") statements.push(db.prepare("UPDATE tags SET color=? WHERE space_id=? AND instr(normalized_name,':')>1 AND trim(substr(normalized_name,1,instr(normalized_name,':')-1))=?").bind(tag.color, space.id, facetKey));
  }
  statements.push(db.prepare("DELETE FROM card_tags WHERE card_id=? AND space_id=?").bind(cardId, space.id));
  for (const tag of tags) statements.push(db.prepare("INSERT INTO card_tags(space_id,card_id,tag_id) SELECT ?,?,id FROM tags WHERE space_id=? AND normalized_name=?").bind(space.id, cardId, space.id, tag.normalized));
  return statements;
}
