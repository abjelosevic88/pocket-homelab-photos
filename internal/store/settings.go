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
