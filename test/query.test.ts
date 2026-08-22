import { describe, expect, it } from "vitest";
import { queryCards } from "../src/query";
import { formatDateUtc } from "../src/date";
import type { CardModel, ListRow } from "../src/types";

const lists: ListRow[] = [{ id: 1, board_id: 1, name: "To do", sort_order: 0, archived_at: null }];
const cards: CardModel[] = [
  { id: 1, board_id: 1, list_id: 1, title: "Alpha", description: "First", sort_order: 0, archived_at: null, created_at: Date.UTC(2026, 7, 19, 23), updated_at: Date.UTC(2026, 7, 20, 12), tags: [{ id: 1, name: "Frontend", color: "cyan" }, { id: 2, name: "Priority:High", color: "lime" }, { id: 3, name: "Due date:2026-08-20", color: "pink" }] },
  { id: 2, board_id: 1, list_id: 1, title: "Beta", description: "Second", sort_order: 1024, archived_at: null, created_at: Date.UTC(2026, 7, 20), updated_at: Date.UTC(2026, 7, 21), tags: [] }
];

describe("queryCards", () => {
  it("searches, filters, groups, and sorts using tags and built-in fields", () => {
    expect(queryCards(cards, lists, { search: "frontend" }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { filters: [{ field: "tag:priority", operator: "any", value: ["high"] }] }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { sorts: [{ field: "title", direction: "desc" }] }).cards.map(card => card.id)).toEqual([2, 1]);
    expect(queryCards(cards, lists, { groupBy: "tag:priority" }).groups.map(group => group.label)).toEqual(["High", "No value"]);
  });

  it("labels timestamp groups as yyyy-mm-dd instead of integer timestamps", () => {
    expect(queryCards(cards, lists, { groupBy: "created_at" }).groups.map(group => group.label)).toEqual(["2026-08-19", "2026-08-20"]);
    expect(queryCards(cards, lists, { groupBy: "updated_at" }).groups.map(group => group.label)).toEqual(["2026-08-20", "2026-08-21"]);
    expect(queryCards(cards, lists, { filters: [{ field: "updated_at", operator: "gte", value: "2026-08-21" }] }).cards.map(card => card.id)).toEqual([2]);
  });

  it("uses UTC consistently for dates near a local-day boundary", () => {
    const nearMidnight = Date.UTC(2026, 7, 20, 0, 30);
    expect(formatDateUtc(nearMidnight)).toBe("2026-08-20");
    const boundaryCard = { ...cards[0], id: 3, created_at: nearMidnight };
    expect(queryCards([boundaryCard], lists, { groupBy: "created_at" }).groups[0].label).toBe(formatDateUtc(nearMidnight));
    expect(queryCards([boundaryCard], lists, { filters: [{ field: "created_at", operator: "equals", value: formatDateUtc(nearMidnight) }] }).cards.map(card => card.id)).toEqual([3]);
  });

  it("supports equality, comparison, emptiness, and tag set operators", () => {
    expect(queryCards(cards, lists, { filters: [{ field: "description", operator: "equals", value: "first" }] }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { filters: [{ field: "title", operator: "not_equals", value: "Alpha" }] }).cards.map(card => card.id)).toEqual([2]);
    expect(queryCards(cards, lists, { filters: [{ field: "tags", operator: "all", value: ["Frontend", "Priority:High"] }] }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { filters: [{ field: "tags", operator: "none", value: ["Frontend"] }] }).cards.map(card => card.id)).toEqual([2]);
    expect(queryCards(cards, lists, { filters: [{ field: "tags", operator: "empty" }] }).cards.map(card => card.id)).toEqual([2]);
    expect(queryCards(cards, lists, { filters: [{ field: "tags", operator: "not_empty" }] }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { filters: [{ field: "created_at", operator: "lt", value: "2026-08-20" }] }).cards.map(card => card.id)).toEqual([1]);
    expect(queryCards(cards, lists, { filters: [{ field: "title", operator: "any", value: ["Alpha"] }] }).cards).toEqual([]);
    expect(queryCards(cards, lists, { filters: [{ field: "title", operator: "true" }] }).cards).toEqual([]);
  });

  it("uses subsequent sort keys and stable board order to break ties", () => {
    const tied = cards.map(card => ({ ...card, title: "Same", description: card.id === 1 ? "Zulu" : "Alpha" }));
    expect(queryCards(tied, lists, { sorts: [{ field: "title", direction: "asc" }, { field: "description", direction: "asc" }] }).cards.map(card => card.id)).toEqual([2, 1]);
    expect(queryCards(tied, lists, { sorts: [{ field: "title", direction: "asc" }] }).cards.map(card => card.id)).toEqual([1, 2]);
  });
});
