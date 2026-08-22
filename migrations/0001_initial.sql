PRAGMA foreign_keys = ON;

CREATE TABLE spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'My workspace',
  created_at INTEGER NOT NULL
);

CREATE TABLE boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(space_id, id)
);
CREATE INDEX idx_boards_space ON boards(space_id, archived_at, sort_order);

CREATE TABLE board_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(space_id, id)
);
CREATE INDEX idx_lists_board ON board_lists(board_id, archived_at, sort_order);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES board_lists(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(space_id, id)
);
CREATE INDEX idx_cards_list ON cards(board_id, list_id, archived_at, sort_order);
CREATE INDEX idx_cards_board_updated ON cards(board_id, archived_at, updated_at DESC);

CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(board_id, name),
  UNIQUE(space_id, id)
);
CREATE UNIQUE INDEX idx_views_default ON saved_views(board_id) WHERE is_default = 1;
CREATE INDEX idx_views_board ON saved_views(board_id, name);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(space_id, normalized_name),
  UNIQUE(space_id, id)
);
CREATE INDEX idx_tags_space_name ON tags(space_id, normalized_name);

CREATE TABLE card_tags (
  space_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY(card_id, tag_id),
  FOREIGN KEY(space_id, card_id) REFERENCES cards(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY(space_id, tag_id) REFERENCES tags(space_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_card_tags_tag ON card_tags(space_id, tag_id, card_id);
