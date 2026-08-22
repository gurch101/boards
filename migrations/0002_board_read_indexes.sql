CREATE INDEX idx_cards_board_list_order
ON cards(board_id, archived_at, list_id, sort_order, id);
