# Boards

Boards is a private project manager with Trello-style boards, tag-based organization, searchable cards, and configurable table views.

The browser UI is dependency-free HTML, CSS, and JavaScript. A Hono Cloudflare Worker owns validation and persistence, using local SQLite through Wrangler during development and Cloudflare D1 when deployed.

## Local development

Requirements: Node.js 22+ and npm.

```sh
npm install
npm run migrate:local
npm run dev
```

Wrangler prints the local URL. Opening `/` creates a private space and redirects to `/p/<capability>`. Local data is stored under `.wrangler/`.

Run the checks with:

```sh
npm run typecheck
npm test
```

The interactive API reference is available at `/docs`, and its OpenAPI 3.0 document is served at `/openapi.json`. The reference uses the open-source Stoplight Elements frontend. Create a space, copy the capability from the returned path into the Bearer authentication field, and use the current board revision in `If-Match` when testing mutations.

## Private spaces

Possession of `/p/<capability>` grants full access to that space. Only the SHA-256 hash of the capability is stored in D1. There are no accounts and no recovery flow in v1, so bookmark the private URL. The browser remembers only the path for convenience.

Authenticated API requests send the capability as a bearer token. Mutations within a board also send its current revision through `If-Match`; stale writes receive `412 Precondition Failed` and the browser reloads the authoritative board.

## Data and API

The migrations create normalized tables for spaces, boards, lists, cards, tags, card-tag relationships, and saved views. Deleting boards, lists, or cards is permanent.

Principal endpoints are:

- `POST /api/spaces` and `GET /api/bootstrap`
- `GET|POST|PATCH|DELETE /api/boards[/:id]`
- Board-scoped list, card, move, query, and saved-view endpoints

Board snapshots include `cardCount`, per-list counts, and a `loadMode`. Boards with at most 1,000 cards return a complete card snapshot and execute search, filters, grouping, and ordered multi-sort in the browser. Larger boards return metadata first and use cursor pages: `POST /api/boards/:id/query` pages table results and `POST /api/boards/:boardId/lists/:listId/cards/query` independently pages a list in canonical card order. Cursors are tied to the board revision and query, so stale result sets fail with `cursor_expired` instead of mixing pages.

Grouping by tags intentionally returns a card in each matching tag group. Page limits are capped at 200 cards; the browser defaults to 100 table rows and 50 cards per list.

When a loaded list or table exceeds 100 items, the browser window-renders the visible rows with overscan and spacer elements. Large lists use independent vertical scrollers, while table headers remain sticky; pagination and exact drag/drop boundaries continue to operate against the full loaded order.

## D1 administration

The sibling `d1-admin` package is mounted at `/admin`. For local development, add this to an untracked `.dev.vars` file:

```text
D1_ADMIN_DEV=true
```

The bypass is valid only on localhost. Deployed environments fail closed unless `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are configured and Cloudflare Access sends a valid assertion. Protect both `/admin` and `/admin/*`; never set `D1_ADMIN_DEV` in a deployed environment.

## Preview and production

Create databases once and put their IDs in `wrangler.toml`:

```sh
npx wrangler d1 create boards-preview
npx wrangler d1 create boards-production
```

Preview:

```sh
npm run migrate:preview
npm run deploy:preview
```

Production:

```sh
npx wrangler d1 export boards-production --remote --output boards-production-backup.sql
npm run migrate:production
npm run deploy:production
```

Add the production custom-domain route under `[env.production]` before the first production deployment.

After deploying, verify private-space creation, an existing bookmarked URL, rejection of an invalid capability, board creation, a card move, a table query, stale-write recovery, static assets, and `/admin` access control.

## Rollback

Worker deployments are versioned and can be rolled back through Cloudflare. D1 migrations are forward-only. Before a production migration, export the database; to reverse an incompatible migration, restore that export into a replacement D1 database, change the binding, and redeploy. Never log capability paths or authorization headers.

## V1 boundaries

V1 is private and single-user. Accounts, memberships, live collaboration, attachments, comments, checklists, notifications, automations, offline synchronization, import/export, and external integrations are intentionally deferred. Every domain row is scoped by `space_id`, and board-level revisions provide the boundary for adding collaborative workspaces later.
