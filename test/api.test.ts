import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, SELF } from "cloudflare:test";

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const origin = "https://boards.test";
async function createSpace() {
  const response = await SELF.fetch(`${origin}/api/spaces`, { method: "POST", headers: { Origin: origin, "content-type": "application/json" }, body: "{}" });
  const payload = await response.json() as { data: { path: string } };
  return payload.data.path.split("/").at(-1)!;
}
function request(key: string, path: string, options: RequestInit = {}) { return SELF.fetch(`${origin}${path}`, { ...options, headers: { Authorization: `Bearer ${key}`, Origin: origin, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers } }); }
async function createBoard(key: string, name = "Test board") { const response = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name }) }); return ((await response.json()) as any).data.id as number; }

describe("Boards API", () => {
  it("creates spaces without card schema data", async () => {
    const key = await createSpace();
    const bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    expect(bootstrap.data).not.toHaveProperty("templates");
  });

  it("serves the application shell directly at root and private paths", async () => {
    const root = await SELF.fetch(`${origin}/`, { redirect: "manual" });
    expect(root.status).toBe(200);
    expect(root.headers.get("location")).toBeNull();
    const rootHtml = await root.text();
    expect(rootHtml).toContain('id="shell"');
    expect(rootHtml).toContain('id="share-space"');
    expect(rootHtml).toContain('class="brand-mark app-icon"');
    expect(rootHtml).not.toContain('data-icon="layout-dashboard"');
    expect(rootHtml).not.toContain('id="settings-menu"');
    expect(rootHtml).not.toContain('id="settings-menu-button"');
    expect(rootHtml).toMatch(/app\.bundle\.js\?v=[a-f0-9]+/);
    expect(rootHtml).not.toContain('id="keyboard-shortcuts"');
    expect(rootHtml).not.toContain('id="command-dialog"');
    expect(rootHtml).not.toContain('class="sidebar"');
    expect(rootHtml).toContain("data-close-dialog");
    expect(rootHtml).not.toContain('value="cancel"');
    expect(rootHtml).toContain('id="delete-confirm-dialog"');
    expect(rootHtml).not.toContain('data-route="archive"');
    expect(rootHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(rootHtml).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(rootHtml).toContain('name="apple-mobile-web-app-capable" content="yes"');

    const key = await createSpace();
    const privatePage = await SELF.fetch(`${origin}/p/${key}`, { redirect: "manual" });
    expect(privatePage.status).toBe(200);
    expect(privatePage.headers.get("location")).toBeNull();
    expect(await privatePage.text()).toContain('id="shell"');
  });

  it("serves an installable web app manifest", async () => {
    const response = await SELF.fetch(`${origin}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as any;
    expect(manifest).toMatchObject({ name: "Boards", start_url: "/", display: "standalone", theme_color: "#090810" });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192" }),
      expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" })
    ]));
  });

  it("serves interactive API documentation and its OpenAPI document", async () => {
    const docs = await SELF.fetch(`${origin}/docs`);
    expect(docs.status).toBe(200);
    const docsHtml = await docs.text();
    expect(docsHtml).toContain("<elements-api");
    expect(docsHtml).toContain('apiDescriptionUrl="/openapi.json"');
    expect(docsHtml).toContain("@stoplight/elements@9.0.15");

    const specResponse = await SELF.fetch(`${origin}/openapi.json`);
    expect(specResponse.status).toBe(200);
    expect(specResponse.headers.get("content-type")).toContain("application/json");
    const spec = (await specResponse.json()) as any;
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.components.securitySchemes.capability).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.paths["/api/spaces"].post.security).toEqual([]);
    expect(spec.paths["/api/boards/{id}"].patch.parameters).toContainEqual({ $ref: "#/components/parameters/IfMatch" });
    expect(spec.paths["/api/boards/{boardId}/cards/{cardId}/move"].post.operationId).toBe("moveCard");
  });

  it("enforces capability authentication, same-origin writes, and private response headers", async () => {
    const key = await createSpace();
    const unauthorized = await SELF.fetch(`${origin}/api/bootstrap`);
    expect(unauthorized.status).toBe(401);
    expect(((await unauthorized.json()) as any).error.code).toBe("unauthorized");

    const bootstrap = await request(key, "/api/bootstrap");
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store, private");
    expect(bootstrap.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(bootstrap.headers.get("x-request-id")).toBeTruthy();

    const crossOrigin = await SELF.fetch(`${origin}/api/boards`, { method: "POST", headers: { Authorization: `Bearer ${key}`, Origin: "https://attacker.test", "content-type": "application/json" }, body: JSON.stringify({ name: "Rejected" }) });
    expect(crossOrigin.status).toBe(401);
    expect(((await crossOrigin.json()) as any).error.code).toBe("origin_rejected");

    const malformed = await request(key, "/api/boards", { method: "POST", body: "{" });
    expect(malformed.status).toBe(422);
    expect(((await malformed.json()) as any).error.code).toBe("validation_failed");
  });

  it("updates and reorders boards and manages list metadata and filtered counts", async () => {
    const key = await createSpace(), firstId = await createBoard(key, "First"), secondId = await createBoard(key, "Second");
    const moved = await request(key, `/api/boards/${secondId}/move`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ beforeId: firstId }) });
    expect(moved.status).toBe(200);
    let bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    expect(bootstrap.data.boards.map((board: any) => board.name)).toEqual(["Second", "First"]);

    const renamed = await request(key, `/api/boards/${firstId}`, { method: "PATCH", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name: "Renamed", description: "Updated description" }) });
    expect(renamed.status).toBe(200);
    const addedList = await request(key, `/api/boards/${firstId}/lists`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({ name: "Review" }) });
    const listId = ((await addedList.json()) as any).data.id;
    const renamedList = await request(key, `/api/boards/${firstId}/lists/${listId}`, { method: "PATCH", headers: { "If-Match": '"2"' }, body: JSON.stringify({ name: "Ready for review" }) });
    expect(renamedList.status).toBe(200);
    const card = await request(key, `/api/boards/${firstId}/cards`, { method: "POST", headers: { "If-Match": '"3"' }, body: JSON.stringify({ listId, title: "Needle", description: "Searchable details", tags: ["Release"] }) });
    expect(card.status).toBe(201);

    const counts = (await (await request(key, `/api/boards/${firstId}/lists/counts`, { method: "POST", body: JSON.stringify({ search: "release" }) })).json()) as any;
    expect(counts.data.counts).toContainEqual({ listId, count: 1 });
    const snapshot = (await (await request(key, `/api/boards/${firstId}`)).json()) as any;
    expect(snapshot.data.board).toMatchObject({ name: "Renamed", description: "Updated description" });
    expect(snapshot.data.lists.find((list: any) => list.id === listId).name).toBe("Ready for review");
    bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    expect(bootstrap.data.boards.find((board: any) => board.id === firstId)).toMatchObject({ name: "Renamed", description: "Updated description" });
  });

  it("creates an isolated structured board and rejects stale writes", async () => {
    const key = await createSpace();
    const boardResponse = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "Launch" }) });
    expect(boardResponse.status).toBe(201);
    const boardId = ((await boardResponse.json()) as any).data.id;
    const boardSnapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(boardSnapshot.data.lists.map((item: any) => item.name)).toEqual(["To do", "Doing", "Done"]);

    const cardResponse = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ listId: boardSnapshot.data.lists[0].id, title: "Ship search", tags: [{ name: "Urgent", color: "pink" }, "urgent", "Frontend", "Priority:High", "Due date:2026-08-20" ] }) });
    expect(cardResponse.status).toBe(201);
    const cardId = ((await cardResponse.json()) as any).data.id;
    const queryResponse = await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ search: "high" }) });
    expect(queryResponse.status).toBe(200);
    expect(((await queryResponse.json()) as any).data.cards.map((item: any) => item.title)).toEqual(["Ship search"]);
    const tagSearch = await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ search: "frontend", filters: [{ field: "tags", operator: "any", value: "Urgent" }], groupBy: "tags" }) });
    const tagResult = (await tagSearch.json()) as any;
    expect(tagResult.data.cards[0].tags.map((tag: any) => tag.name)).toEqual(["Due date:2026-08-20", "Frontend", "Priority:High", "Urgent"]);
    expect(tagResult.data.cards[0].tags.find((tag: any) => tag.name === "Urgent").color).toBe("pink");
    expect(tagResult.data.groups.map((group: any) => group.label)).toEqual(["Due date:2026-08-20", "Frontend", "Priority:High", "Urgent"]);
    const facetQuery = await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ filters: [{ field: "tag:priority", operator: "any", value: ["High"] }, { field: "tag:due date", operator: "gte", value: "2026-08-19" }], groupBy: "tag:priority" }) });
    const facetResult = (await facetQuery.json()) as any;
    expect(facetResult.data.cards.map((card: any) => card.title)).toEqual(["Ship search"]);
    expect(facetResult.data.groups.map((group: any) => group.label)).toEqual(["High"]);

    const secondCard = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({ listId: boardSnapshot.data.lists[0].id, title: "Check metrics", tags: [{ name: "Priority:Low", color: "cyan" }] }) });
    expect(secondCard.status).toBe(201);
    const recoloredCard = await request(key, `/api/boards/${boardId}/cards/${cardId}`, { method: "PATCH", headers: { "If-Match": '"2"' }, body: JSON.stringify({ tags: [{ name: "Priority:High", color: "yellow", colorScope: "key" }] }) });
    expect(recoloredCard.status).toBe(200);
    const recoloredSnapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(recoloredSnapshot.data.tags.filter((tag: any) => tag.name.startsWith("Priority:")).map((tag: any) => [tag.name, tag.color])).toEqual([["Priority:High", "yellow"], ["Priority:Low", "yellow"]]);
    const singleValueColor = await request(key, `/api/boards/${boardId}/cards/${cardId}`, { method: "PATCH", headers: { "If-Match": '"3"' }, body: JSON.stringify({ tags: [{ name: "Priority:High", color: "pink", colorScope: "value" }] }) });
    expect(singleValueColor.status).toBe(200);
    const singleValueSnapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(singleValueSnapshot.data.tags.filter((tag: any) => tag.name.startsWith("Priority:")).map((tag: any) => [tag.name, tag.color])).toEqual([["Priority:High", "pink"], ["Priority:Low", "yellow"]]);

    const staleResponse = await request(key, `/api/boards/${boardId}/lists`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name: "Blocked" }) });
    expect(staleResponse.status).toBe(412);
    const otherKey = await createSpace();
    expect((await request(otherKey, `/api/boards/${boardId}`)).status).toBe(404);
  });

  it("atomically accepts only one concurrent write for a board revision", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Concurrent");
    const writes = await Promise.all(["First writer", "Second writer"].map(name => request(key, `/api/boards/${boardId}`, { method: "PATCH", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name }) })));
    expect(writes.map(response => response.status).sort()).toEqual([200, 412]);
    const success = writes.find(response => response.status === 200)!;
    expect(((await success.json()) as any).revision).toBe(1);
    const stale = writes.find(response => response.status === 412)!;
    expect(((await stale.json()) as any).error.code).toBe("stale_revision");
    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.board.revision).toBe(1);
    expect(["First writer", "Second writer"]).toContain(snapshot.data.board.name);
  });

  it("rolls back card writes and revisions when tags are invalid", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Tag validation");
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const listId = snapshot.data.lists[0].id, tooManyTags = Array.from({ length: 21 }, (_, index) => `Tag ${index}`);
    const rejectedCreate = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ listId, title: "Must not persist", tags: tooManyTags }) });
    expect(rejectedCreate.status).toBe(422);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.board.revision).toBe(0);
    expect(snapshot.data.cards).toEqual([]);
    expect(snapshot.data.tags).toEqual([]);

    const created = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ listId, title: "Original", tags: ["Valid"] }) });
    const cardId = ((await created.json()) as any).data.id;
    const rejectedPatch = await request(key, `/api/boards/${boardId}/cards/${cardId}`, { method: "PATCH", headers: { "If-Match": '"1"' }, body: JSON.stringify({ title: "Must roll back", tags: [`Due date:${"2".repeat(40)}`] }) });
    expect(rejectedPatch.status).toBe(422);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.board.revision).toBe(1);
    expect(snapshot.data.cards[0]).toMatchObject({ id: cardId, title: "Original" });
    expect(snapshot.data.cards[0].tags.map((tag: any) => tag.name)).toEqual(["Valid"]);
  });

  it("moves a card to an exact position within a list", async () => {
    const key = await createSpace();
    const bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    const boardCreated = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "Ordered" }) });
    const boardId = ((await boardCreated.json()) as any).data.id;
    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const listId = snapshot.data.lists[0].id;
    const cardIds: number[] = [];
    for (const [revision, title] of ["First", "Second", "Third"].entries()) {
      const created = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": `"${revision}"` }, body: JSON.stringify({ listId, title }) });
      cardIds.push(((await created.json()) as any).data.id);
    }
    const moved = await request(key, `/api/boards/${boardId}/cards/${cardIds[2]}/move`, { method: "POST", headers: { "If-Match": '"3"' }, body: JSON.stringify({ listId, beforeId: cardIds[0] }) });
    expect(moved.status).toBe(200);
    const reordered = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(reordered.data.cards.filter((card: any) => card.list_id === listId).map((card: any) => card.title)).toEqual(["Third", "First", "Second"]);
  });

  it("updates cards and moves them between lists at the start and end", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Card lifecycle");
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const [firstList, secondList] = snapshot.data.lists;
    const firstCard = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ listId: firstList.id, title: "First" }) });
    const firstCardId = ((await firstCard.json()) as any).data.id;
    const movingCard = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({ listId: firstList.id, title: "Moving" }) });
    const movingCardId = ((await movingCard.json()) as any).data.id;
    const existingTarget = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"2"' }, body: JSON.stringify({ listId: secondList.id, title: "Target" }) });
    expect(existingTarget.status).toBe(201);

    const updated = await request(key, `/api/boards/${boardId}/cards/${firstCardId}`, { method: "PATCH", headers: { "If-Match": '"3"' }, body: JSON.stringify({ title: "First updated", description: "Find this phrase", tags: ["Backend"] }) });
    expect(updated.status).toBe(200);
    const search = (await (await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ search: "find this phrase" }) })).json()) as any;
    expect(search.data.cards.map((card: any) => card.id)).toEqual([firstCardId]);

    const movedStart = await request(key, `/api/boards/${boardId}/cards/${movingCardId}/move`, { method: "POST", headers: { "If-Match": '"4"' }, body: JSON.stringify({ listId: secondList.id, placement: "start" }) });
    expect(movedStart.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.cards.filter((card: any) => card.list_id === secondList.id).map((card: any) => card.title)).toEqual(["Moving", "Target"]);

    const movedEnd = await request(key, `/api/boards/${boardId}/cards/${movingCardId}/move`, { method: "POST", headers: { "If-Match": '"5"' }, body: JSON.stringify({ listId: secondList.id, placement: "end" }) });
    expect(movedEnd.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.cards.filter((card: any) => card.list_id === secondList.id).map((card: any) => card.title)).toEqual(["Target", "Moving"]);

    const invalidMove = await request(key, `/api/boards/${boardId}/cards/${movingCardId}/move`, { method: "POST", headers: { "If-Match": '"6"' }, body: JSON.stringify({ listId: 999999 }) });
    expect(invalidMove.status).toBe(422);
    expect(((await invalidMove.json()) as any).error.code).toBe("validation_failed");
  });

  it("moves an entire list to an exact board position", async () => {
    const key = await createSpace();
    const bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    const boardCreated = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "List ordering" }) });
    const boardId = ((await boardCreated.json()) as any).data.id;
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const [todo, , done] = snapshot.data.lists;

    const movedFirst = await request(key, `/api/boards/${boardId}/lists/${done.id}/move`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ beforeId: todo.id }) });
    expect(movedFirst.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.lists.map((list: any) => list.name)).toEqual(["Done", "To do", "Doing"]);

    const movedLast = await request(key, `/api/boards/${boardId}/lists/${done.id}/move`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({}) });
    expect(movedLast.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.lists.map((list: any) => list.name)).toEqual(["To do", "Doing", "Done"]);
  });

  it("loads boards through 1000 cards completely and cursor-pages larger lists", async () => {
    const key = await createSpace();
    const bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    const boardCreated = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "Scale" }) });
    const boardId = ((await boardCreated.json()) as any).data.id;
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const listId = snapshot.data.lists[0].id, spaceId = bootstrap.data.space.id, now = Date.now();
    for (let start = 0; start < 1001; start += 100) {
      await env.DB.batch(Array.from({ length: Math.min(100, 1001 - start) }, (_, offset) => { const index = start + offset; return env.DB.prepare("INSERT INTO cards(space_id,board_id,list_id,title,description,search_text,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(spaceId, boardId, listId, `Card ${String(index).padStart(4, "0")}`, "", `card ${String(index).padStart(4, "0")}`, index * 1024, now + index, now + index); }));
    }
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data).toMatchObject({ cardCount: 1001, loadMode: "paginated", cards: [] });
    expect(snapshot.data.listCardCounts).toContainEqual({ listId, count: 1001 });

    const first = (await (await request(key, `/api/boards/${boardId}/lists/${listId}/cards/query`, { method: "POST", body: JSON.stringify({ limit: 50 }) })).json()) as any;
    expect(first.data.cards).toHaveLength(50); expect(first.data.total).toBe(1001); expect(first.data.nextCursor).toBeTypeOf("string"); expect(first.data.nextCardId).toBeTypeOf("number");
    const second = (await (await request(key, `/api/boards/${boardId}/lists/${listId}/cards/query`, { method: "POST", body: JSON.stringify({ limit: 50, cursor: first.data.nextCursor }) })).json()) as any;
    expect(second.data.cards).toHaveLength(50); expect(new Set([...first.data.cards, ...second.data.cards].map((card: any) => card.id)).size).toBe(100);

    await env.DB.prepare("DELETE FROM cards WHERE board_id=? AND sort_order=(SELECT MAX(sort_order) FROM cards WHERE board_id=?)").bind(boardId, boardId).run();
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.loadMode).toBe("complete"); expect(snapshot.data.cards).toHaveLength(1000);
  });

  it("rejects list cursors after a board revision changes", async () => {
    const key = await createSpace(), bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    const boardId = ((await (await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "Cursors" }) })).json()) as any).data.id;
    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any, listId = snapshot.data.lists[0].id;
    for (const [revision, title] of ["One", "Two"].entries()) await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": `"${revision}"` }, body: JSON.stringify({ listId, title }) });
    const first = (await (await request(key, `/api/boards/${boardId}/lists/${listId}/cards/query`, { method: "POST", body: JSON.stringify({ limit: 1 }) })).json()) as any;
    await request(key, `/api/boards/${boardId}`, { method: "PATCH", headers: { "If-Match": '"2"' }, body: JSON.stringify({ description: "Changed" }) });
    const stale = await request(key, `/api/boards/${boardId}/lists/${listId}/cards/query`, { method: "POST", body: JSON.stringify({ limit: 1, cursor: first.data.nextCursor }) });
    expect(stale.status).toBe(409); expect(((await stale.json()) as any).error.code).toBe("cursor_expired");
  });

  it("paginates board queries and rejects cursors after query results change", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Board query cursors");
    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any, listId = snapshot.data.lists[0].id;
    for (const [revision, title] of ["Charlie", "Alpha", "Bravo"].entries()) await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": `"${revision}"` }, body: JSON.stringify({ listId, title }) });
    const config = { sorts: [{ field: "title", direction: "asc" }] };
    const first = (await (await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ config, limit: 2 }) })).json()) as any;
    expect(first.data.cards.map((card: any) => card.title)).toEqual(["Alpha", "Bravo"]);
    expect(first.data).toMatchObject({ total: 3 });
    expect(first.data.nextCursor).toBeTypeOf("string");
    const second = (await (await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ config, limit: 2, cursor: first.data.nextCursor }) })).json()) as any;
    expect(second.data.cards.map((card: any) => card.title)).toEqual(["Charlie"]);
    expect(second.data.nextCursor).toBeNull();

    await request(key, `/api/boards/${boardId}`, { method: "PATCH", headers: { "If-Match": '"3"' }, body: JSON.stringify({ description: "Changed" }) });
    const stale = await request(key, `/api/boards/${boardId}/query`, { method: "POST", body: JSON.stringify({ config, limit: 2, cursor: first.data.nextCursor }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.code).toBe("cursor_expired");
  });

  it("creates, updates, defaults, and deletes saved table views", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Views");
    const first = await request(key, `/api/boards/${boardId}/views`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name: "First view", isDefault: true, config: { search: "first" } }) });
    const firstId = ((await first.json()) as any).data.id;
    const second = await request(key, `/api/boards/${boardId}/views`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({ name: "Second view", isDefault: true, config: { groupBy: "list" } }) });
    const secondId = ((await second.json()) as any).data.id;
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.views.filter((view: any) => Number(view.is_default)).map((view: any) => view.id)).toEqual([secondId]);

    const replaced = await request(key, `/api/boards/${boardId}/views/${firstId}`, { method: "PUT", headers: { "If-Match": '"2"' }, body: JSON.stringify({ name: "First renamed", isDefault: true, config: { filters: [{ field: "title", operator: "contains", value: "ship" }] } }) });
    expect(replaced.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.views.filter((view: any) => Number(view.is_default)).map((view: any) => view.id)).toEqual([firstId]);
    expect(snapshot.data.views.find((view: any) => view.id === firstId)).toMatchObject({ name: "First renamed", config: { filters: [{ field: "title", operator: "contains", value: "ship" }] } });

    const deleted = await request(key, `/api/boards/${boardId}/views/${secondId}`, { method: "DELETE", headers: { "If-Match": '"3"' } });
    expect(deleted.status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.views.map((view: any) => view.id)).toEqual([firstId]);
  });

  it("preserves the default view and revision when a view write conflicts", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "View conflicts");
    const first = await request(key, `/api/boards/${boardId}/views`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name: "Default view", isDefault: true, config: {} }) });
    const firstId = ((await first.json()) as any).data.id;
    const second = await request(key, `/api/boards/${boardId}/views`, { method: "POST", headers: { "If-Match": '"1"' }, body: JSON.stringify({ name: "Other view", isDefault: false, config: {} }) });
    const secondId = ((await second.json()) as any).data.id;

    const duplicate = await request(key, `/api/boards/${boardId}/views`, { method: "POST", headers: { "If-Match": '"2"' }, body: JSON.stringify({ name: "Other view", isDefault: true, config: {} }) });
    expect(duplicate.status).toBe(409);
    const conflictingUpdate = await request(key, `/api/boards/${boardId}/views/${secondId}`, { method: "PUT", headers: { "If-Match": '"2"' }, body: JSON.stringify({ name: "Default view", isDefault: true, config: { search: "changed" } }) });
    expect(conflictingUpdate.status).toBe(409);

    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.board.revision).toBe(2);
    expect(snapshot.data.views.filter((view: any) => Number(view.is_default)).map((view: any) => view.id)).toEqual([firstId]);
    expect(snapshot.data.views.find((view: any) => view.id === secondId)).toMatchObject({ name: "Other view", config: {} });
  });

  it("returns a generic 500 response for unexpected database failures", async () => {
    const key = await createSpace(), boardId = await createBoard(key, "Server failure");
    await env.DB.prepare("CREATE TRIGGER fail_board_update BEFORE UPDATE ON boards BEGIN SELECT RAISE(ABORT,'sensitive database failure'); END").run();
    const response = await request(key, `/api/boards/${boardId}`, { method: "PATCH", headers: { "If-Match": '"0"' }, body: JSON.stringify({ name: "Must not persist" }) });
    await env.DB.prepare("DROP TRIGGER fail_board_update").run();
    expect(response.status).toBe(500);
    const payload = (await response.json()) as any;
    expect(payload.error).toEqual({ code: "internal_error", message: "An unexpected server error occurred" });
    const snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.board).toMatchObject({ name: "Server failure", revision: 0 });
  });

  it("permanently deletes cards, lists, and boards", async () => {
    const key = await createSpace();
    let bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    const boardCreated = await request(key, "/api/boards", { method: "POST", body: JSON.stringify({ name: "Disposable" }) });
    const boardId = ((await boardCreated.json()) as any).data.id;
    let snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    const firstListId = snapshot.data.lists[0].id;
    const cardCreated = await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"0"' }, body: JSON.stringify({ listId: firstListId, title: "Delete me" }) });
    const cardId = ((await cardCreated.json()) as any).data.id;
    expect((await request(key, `/api/boards/${boardId}/cards/${cardId}`, { method: "DELETE", headers: { "If-Match": '"1"' } })).status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.cards).toEqual([]);

    await request(key, `/api/boards/${boardId}/cards`, { method: "POST", headers: { "If-Match": '"2"' }, body: JSON.stringify({ listId: firstListId, title: "Deleted with list" }) });
    expect((await request(key, `/api/boards/${boardId}/lists/${firstListId}`, { method: "DELETE", headers: { "If-Match": '"3"' } })).status).toBe(200);
    snapshot = (await (await request(key, `/api/boards/${boardId}`)).json()) as any;
    expect(snapshot.data.lists.some((list: any) => list.id === firstListId)).toBe(false);
    expect(snapshot.data.cards).toEqual([]);

    expect((await request(key, `/api/boards/${boardId}`, { method: "DELETE", headers: { "If-Match": '"4"' } })).status).toBe(204);
    expect((await request(key, `/api/boards/${boardId}`)).status).toBe(404);
    bootstrap = (await (await request(key, "/api/bootstrap")).json()) as any;
    expect(bootstrap.data.boards.some((board: any) => board.id === boardId)).toBe(false);
  });
});
