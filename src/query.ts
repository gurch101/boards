import { normalizeSearch } from "./crypto";
import { formatDateUtc } from "./date";
import type { CardModel, ListRow, ViewConfig } from "./types";

const empty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
const dateRefs = new Set(["created_at", "updated_at"]);
function rawValue(card: CardModel, lists: ListRow[], ref: string): string | string[] | number {
  if (ref === "title") return card.title;
  if (ref === "description") return card.description;
  if (ref === "list") return lists.find(list => list.id === card.list_id)?.name || "";
  if (ref === "tags") return card.tags.map(tag => tag.name);
  if (ref.startsWith("tag:")) { const facet = ref.slice(4).normalize("NFKC").toLocaleLowerCase(); return card.tags.flatMap(tag => { const at = tag.name.indexOf(":"); return at > 0 && tag.name.slice(0, at).trim().normalize("NFKC").toLocaleLowerCase() === facet ? [tag.name.slice(at + 1).trim()] : []; }); }
  if (ref === "created_at") return card.created_at;
  if (ref === "updated_at") return card.updated_at;
  return "";
}
function display(ref: string, value: unknown) { return dateRefs.has(ref) ? formatDateUtc(value) : empty(value) ? "" : String(value); }
function compare(a: unknown, b: unknown) {
  if (empty(a) && empty(b)) return 0; if (empty(a)) return 1; if (empty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
function matches(value: unknown, operator: string, expected: unknown): boolean {
  if (operator === "empty") return empty(value); if (operator === "not_empty") return !empty(value);
  if (operator === "contains") return String(value).toLocaleLowerCase().includes(String(expected ?? "").toLocaleLowerCase());
  if (operator === "equals") return compare(value, expected) === 0 || String(value).toLocaleLowerCase() === String(expected ?? "").toLocaleLowerCase();
  if (operator === "not_equals") return !matches(value, "equals", expected);
  if (operator === "gt") return compare(value, expected) > 0; if (operator === "gte") return compare(value, expected) >= 0; if (operator === "lt") return compare(value, expected) < 0; if (operator === "lte") return compare(value, expected) <= 0;
  if (Array.isArray(value)) {
    const actual = value.map(item => String(item).toLocaleLowerCase()), wanted = (Array.isArray(expected) ? expected : String(expected || "").split(",")).map(item => String(item).trim().toLocaleLowerCase()).filter(Boolean);
    if (operator === "any") return wanted.some(item => actual.includes(item)); if (operator === "all") return wanted.every(item => actual.includes(item)); if (operator === "none") return !wanted.some(item => actual.includes(item));
  }
  return false;
}
export function queryCards(cards: CardModel[], lists: ListRow[], config: ViewConfig) {
  const search = normalizeSearch(config.search || "");
  let items = cards.filter(card => (!search || normalizeSearch(card.title, card.description, ...card.tags.map(tag => tag.name)).includes(search)) && (config.filters || []).every(filter => { const value = rawValue(card, lists, filter.field); return matches(dateRefs.has(filter.field) ? display(filter.field, value) : value, filter.operator, filter.value); }));
  if (config.sorts?.length) items = [...items].sort((a, b) => { for (const sort of config.sorts || []) { const result = compare(rawValue(a, lists, sort.field), rawValue(b, lists, sort.field)); if (result) return sort.direction === "desc" ? -result : result; } return a.sort_order - b.sort_order || a.id - b.id; });
  const groups: Array<{ key: string; label: string; cardIds: number[] }> = [];
  if (config.groupBy) {
    const ref = config.groupBy, map = new Map<string, { label: string; ids: number[] }>();
    for (const card of items) {
      const value = rawValue(card, lists, ref);
      const entries: Array<readonly [string, string]> = (ref === "tags" || ref.startsWith("tag:")) && Array.isArray(value) ? value.map(item => [String(item).toLocaleLowerCase(), String(item)] as const) : [[empty(value) ? "__empty" : String(value), empty(value) ? "No value" : display(ref, value)] as const];
      if (!entries.length) entries.push(["__empty", "No value"]);
      for (const [key, label] of entries) { const group = map.get(key) || { label, ids: [] }; group.ids.push(card.id); map.set(key, group); }
    }
    for (const [key, group] of map) groups.push({ key, label: group.label, cardIds: group.ids });
    groups.sort((a, b) => a.key === "__empty" ? 1 : b.key === "__empty" ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  return { cards: items, groups };
}
