package store

import "context"

type Settings struct {
	Title         string `json:"title"`
	SetupComplete bool   `json:"setup_complete"`
}

func (s *Store) GetSettings(ctx context.Context, uid int64) (Settings, error) {
	var v string
	_ = s.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='setup_complete'`).Scan(&v)
	return Settings{Title: "Pocket Photos", SetupComplete: v == "1"}, nil
}
func (s *Store) SaveBoxSettings(ctx context.Context, st Settings) error {
	_, e := s.DB.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES('setup_complete','1') ON CONFLICT(key) DO UPDATE SET value='1'`)
	return e
}

// KV reads a box-wide value kept by the app itself ("" when unset).
func (s *Store) KV(ctx context.Context, key string) string {
	var v string
	_ = s.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	return v
}

// SetKV stores a box-wide value; "" removes it.
func (s *Store) SetKV(ctx context.Context, key, value string) error {
	if value == "" {
		_, e := s.DB.ExecContext(ctx, `DELETE FROM settings WHERE key=?`, key)
		return e
	}
	_, e := s.DB.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return e
}
