package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// CloudAccount is one cloud a person connected for indexing. Strictly theirs: every query takes the
// owner's id, so another person's account id is simply not found.
type CloudAccount struct {
	ID         int64       `json:"id"`
	UserID     int64       `json:"-"`
	Kind       string      `json:"kind"`
	Name       string      `json:"name"`
	Root       string      `json:"root"`
	Via        string      `json:"via"`
	Config     string      `json:"-"` // JSON of the non-secret fields
	Secret     string      `json:"-"` // sealed
	Login      string      `json:"login"`
	Status     string      `json:"status"`
	Error      string      `json:"error,omitempty"`
	Cursor     string      `json:"-"`
	LastScanAt *string     `json:"last_scan_at,omitempty"`
	CreatedAt  string      `json:"created_at"`
	Counts     CloudCounts `json:"counts"`
}

type CloudCounts struct {
	Items    int `json:"items"`
	Photos   int `json:"photos"`
	Videos   int `json:"videos"`
	Located  int `json:"located"`
	Imported int `json:"imported"`
}

// CloudItem is a photo or video found in a cloud account.
type CloudItem struct {
	ID              int64    `json:"id"`
	AccountID       int64    `json:"account_id"`
	RemoteID        string   `json:"-"`
	Path            string   `json:"path"`
	Name            string   `json:"name"`
	Mime            string   `json:"mime"`
	Size            int64    `json:"size"`
	ETag            string   `json:"-"`
	ModifiedAt      string   `json:"modified_at,omitempty"`
	TakenAt         string   `json:"taken_at,omitempty"`
	Width           int      `json:"width,omitempty"`
	Height          int      `json:"height,omitempty"`
	Lat             *float64 `json:"lat,omitempty"`
	Lon             *float64 `json:"lon,omitempty"`
	City            string   `json:"city,omitempty"`
	Country         string   `json:"country,omitempty"`
	Camera          string   `json:"camera,omitempty"`
	Video           bool     `json:"video"`
	DurationMs      int64    `json:"duration_ms,omitempty"`
	WebURL          string   `json:"web_url,omitempty"`
	ThumbRef        string   `json:"-"`
	Indexed         bool     `json:"-"`
	ImportedAssetID string   `json:"imported_asset_id,omitempty"`
	ImportStatus    string   `json:"import_status,omitempty"`
	HasThumb        bool     `json:"has_thumb"`
}

const cloudAccountCols = `id, user_id, kind, name, root, via, config, secret, login, status, error, cursor, last_scan_at, created_at`

func scanCloudAccount(row interface{ Scan(...any) error }) (*CloudAccount, error) {
	a := &CloudAccount{}
	var last sql.NullString
	if err := row.Scan(&a.ID, &a.UserID, &a.Kind, &a.Name, &a.Root, &a.Via, &a.Config, &a.Secret, &a.Login, &a.Status, &a.Error, &a.Cursor, &last, &a.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if last.Valid {
		a.LastScanAt = &last.String
	}
	return a, nil
}

func (s *Store) CreateCloudAccount(ctx context.Context, a *CloudAccount) error {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO cloud_accounts (user_id, kind, name, root, via, config, secret, login, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
		a.UserID, a.Kind, a.Name, a.Root, a.Via, a.Config, a.Secret, a.Login)
	if err != nil {
		return err
	}
	a.ID, _ = res.LastInsertId()
	a.Status = "idle"
	return nil
}

// GetCloudAccount answers ErrNotFound for an id that is not the person's.
func (s *Store) GetCloudAccount(ctx context.Context, userID, id int64) (*CloudAccount, error) {
	return scanCloudAccount(s.DB.QueryRowContext(ctx, `SELECT `+cloudAccountCols+` FROM cloud_accounts WHERE id = ? AND user_id = ?`, id, userID))
}

// CloudAccountByID is for the background scanner, which acts for the account's owner.
func (s *Store) CloudAccountByID(ctx context.Context, id int64) (*CloudAccount, error) {
	return scanCloudAccount(s.DB.QueryRowContext(ctx, `SELECT `+cloudAccountCols+` FROM cloud_accounts WHERE id = ?`, id))
}

func (s *Store) ListCloudAccounts(ctx context.Context, userID int64) ([]*CloudAccount, error) {
	q := `SELECT ` + cloudAccountCols + ` FROM cloud_accounts`
	args := []any{}
	if userID > 0 {
		q += ` WHERE user_id = ?`
		args = append(args, userID)
	}
	rows, err := s.DB.QueryContext(ctx, q+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*CloudAccount{}
	for rows.Next() {
		a, err := scanCloudAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, a := range out {
		a.Counts, _ = s.CloudCounts(ctx, a.ID)
	}
	return out, nil
}

func (s *Store) UpdateCloudAccount(ctx context.Context, a *CloudAccount) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_accounts SET name = ?, root = ?, via = ?, config = ?, secret = ?, login = ? WHERE id = ? AND user_id = ?`,
		a.Name, a.Root, a.Via, a.Config, a.Secret, a.Login, a.ID, a.UserID)
	return err
}

func (s *Store) SetCloudSecret(ctx context.Context, id int64, sealed string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_accounts SET secret = ? WHERE id = ?`, sealed, id)
	return err
}

func (s *Store) SetCloudStatus(ctx context.Context, id int64, status, msg string, finished bool) error {
	q := `UPDATE cloud_accounts SET status = ?, error = ?`
	if finished {
		q += `, last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
	}
	_, err := s.DB.ExecContext(ctx, q+` WHERE id = ?`, status, msg, id)
	return err
}

func (s *Store) SetCloudCursor(ctx context.Context, id int64, cursor string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_accounts SET cursor = ? WHERE id = ?`, cursor, id)
	return err
}

func (s *Store) DeleteCloudAccount(ctx context.Context, userID, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM cloud_accounts WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CloudCounts(ctx context.Context, accountID int64) (CloudCounts, error) {
	var c CloudCounts
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(video = 0), 0), COALESCE(SUM(video = 1), 0),
		COALESCE(SUM(lat IS NOT NULL), 0), COALESCE(SUM(import_status <> ''), 0) FROM cloud_items WHERE account_id = ?`, accountID).
		Scan(&c.Items, &c.Photos, &c.Videos, &c.Located, &c.Imported)
	return c, err
}

// ---- items ----

const cloudItemCols = `i.id, i.account_id, i.remote_id, i.path, i.name, i.mime, i.size, i.etag, i.modified_at, i.taken_at, i.width, i.height,
	i.lat, i.lon, i.city, i.country, i.camera, i.video, i.duration_ms, i.web_url, i.thumb_ref, i.indexed, i.imported_asset_id, i.import_status`

func scanCloudItem(row interface{ Scan(...any) error }) (*CloudItem, error) {
	it := &CloudItem{}
	var lat, lon sql.NullFloat64
	if err := row.Scan(&it.ID, &it.AccountID, &it.RemoteID, &it.Path, &it.Name, &it.Mime, &it.Size, &it.ETag, &it.ModifiedAt, &it.TakenAt,
		&it.Width, &it.Height, &lat, &lon, &it.City, &it.Country, &it.Camera, &it.Video, &it.DurationMs, &it.WebURL, &it.ThumbRef,
		&it.Indexed, &it.ImportedAssetID, &it.ImportStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if lat.Valid && lon.Valid {
		it.Lat, it.Lon = &lat.Float64, &lon.Float64
	}
	return it, nil
}

// UpsertCloudItem records a listed file. When the file changed (etag, size or time) its metadata is
// read again; otherwise what was indexed stays. It reports whether the item still needs indexing.
func (s *Store) UpsertCloudItem(ctx context.Context, it *CloudItem, scan int64) (needsIndex bool, err error) {
	var id int64
	var etag, mod string
	var size int64
	var indexed bool
	err = s.DB.QueryRowContext(ctx, `SELECT id, etag, size, modified_at, indexed FROM cloud_items WHERE account_id = ? AND remote_id = ?`, it.AccountID, it.RemoteID).
		Scan(&id, &etag, &size, &mod, &indexed)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := s.DB.ExecContext(ctx, `INSERT INTO cloud_items (account_id, remote_id, path, name, mime, size, etag, modified_at, taken_at, sort_at,
			width, height, lat, lon, camera, video, duration_ms, web_url, thumb_ref, indexed, seen_scan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			it.AccountID, it.RemoteID, it.Path, it.Name, it.Mime, it.Size, it.ETag, it.ModifiedAt, it.TakenAt, firstOf(it.TakenAt, it.ModifiedAt),
			it.Width, it.Height, nullF(it.Lat), nullF(it.Lon), it.Camera, it.Video, it.DurationMs, it.WebURL, it.ThumbRef, it.Indexed, scan)
		if err != nil {
			return false, err
		}
		it.ID, _ = res.LastInsertId()
		return !it.Indexed, nil
	case err != nil:
		return false, err
	}
	it.ID = id
	changed := etag != it.ETag || size != it.Size || mod != it.ModifiedAt
	if changed || it.Indexed {
		// new content, or the provider handed over fresh metadata: take the listing as it is
		_, err = s.DB.ExecContext(ctx, `UPDATE cloud_items SET path=?, name=?, mime=?, size=?, etag=?, modified_at=?, taken_at=?, sort_at=?, width=?, height=?,
			lat=?, lon=?, camera=?, video=?, duration_ms=?, web_url=?, thumb_ref=?, indexed=?, geocoded=CASE WHEN ? THEN 0 ELSE geocoded END, index_error='', seen_scan=? WHERE id=?`,
			it.Path, it.Name, it.Mime, it.Size, it.ETag, it.ModifiedAt, it.TakenAt, firstOf(it.TakenAt, it.ModifiedAt), it.Width, it.Height,
			nullF(it.Lat), nullF(it.Lon), it.Camera, it.Video, it.DurationMs, it.WebURL, it.ThumbRef, it.Indexed, changed, scan, id)
		return changed && !it.Indexed, err
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE cloud_items SET path=?, name=?, web_url=?, thumb_ref=?, seen_scan=? WHERE id=?`, it.Path, it.Name, it.WebURL, it.ThumbRef, scan, id)
	return !indexed, err
}

// SaveCloudMeta stores what was read from the file itself.
func (s *Store) SaveCloudMeta(ctx context.Context, it *CloudItem, indexErr string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_items SET taken_at=?, sort_at=?, width=?, height=?, lat=?, lon=?, camera=?, duration_ms=?, indexed=1, index_error=? WHERE id=?`,
		it.TakenAt, firstOf(it.TakenAt, it.ModifiedAt), it.Width, it.Height, nullF(it.Lat), nullF(it.Lon), it.Camera, it.DurationMs, indexErr, it.ID)
	return err
}

// PruneCloudItems drops what the last full scan no longer saw (deleted or moved out of the folder).
func (s *Store) PruneCloudItems(ctx context.Context, accountID, scan int64) (int64, error) {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM cloud_items WHERE account_id = ? AND seen_scan <> ?`, accountID, scan)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) DeleteCloudItemByRemote(ctx context.Context, accountID int64, remoteID string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM cloud_items WHERE account_id = ? AND remote_id = ?`, accountID, remoteID)
	return err
}

func (s *Store) CloudItemsToIndex(ctx context.Context, accountID int64, limit int) ([]*CloudItem, error) {
	return s.queryItems(ctx, `SELECT `+cloudItemCols+` FROM cloud_items i WHERE i.account_id = ? AND i.indexed = 0 ORDER BY i.id LIMIT ?`, accountID, limit)
}

func (s *Store) CloudItemsToGeocode(ctx context.Context, accountID int64, limit int) ([]*CloudItem, error) {
	return s.queryItems(ctx, `SELECT `+cloudItemCols+` FROM cloud_items i WHERE i.account_id = ? AND i.geocoded = 0 AND i.lat IS NOT NULL ORDER BY i.id LIMIT ?`, accountID, limit)
}

func (s *Store) SetCloudPlace(ctx context.Context, id int64, city, country string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_items SET city = ?, country = ?, geocoded = 1 WHERE id = ?`, city, country, id)
	return err
}

func (s *Store) SetCloudImport(ctx context.Context, id int64, status, assetID string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE cloud_items SET import_status = ?, imported_asset_id = ? WHERE id = ?`, status, assetID, id)
	return err
}

func (s *Store) CountCloudIndexed(ctx context.Context, accountID int64) (int, error) {
	var n int
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM cloud_items WHERE account_id = ? AND indexed = 1`, accountID).Scan(&n)
	return n, err
}

// GetCloudItem answers ErrNotFound for an item in somebody else's account.
func (s *Store) GetCloudItem(ctx context.Context, userID, id int64) (*CloudItem, *CloudAccount, error) {
	it, err := scanCloudItem(s.DB.QueryRowContext(ctx, `SELECT `+cloudItemCols+` FROM cloud_items i JOIN cloud_accounts a ON a.id = i.account_id
		WHERE i.id = ? AND a.user_id = ?`, id, userID))
	if err != nil {
		return nil, nil, err
	}
	a, err := s.GetCloudAccount(ctx, userID, it.AccountID)
	return it, a, err
}

type CloudQuery struct {
	UserID    int64
	AccountID int64 // 0: all of the person's accounts
	Filter    string
	Type      string
	Q         string
	Asc       bool
	Cursor    string
	Before    string // exclusive date boundary for a timeline jump
	Limit     int
}

func cloudItemsWhere(q CloudQuery) (string, []any) {
	where := []string{"a.user_id = ?"}
	args := []any{q.UserID}
	if q.AccountID > 0 {
		where = append(where, "i.account_id = ?")
		args = append(args, q.AccountID)
	}
	switch q.Filter {
	case "new":
		where = append(where, "i.import_status = ''")
	case "imported":
		where = append(where, "i.import_status <> ''")
	case "located":
		where = append(where, "i.lat IS NOT NULL")
	case "unlocated":
		where = append(where, "i.lat IS NULL")
	}
	switch q.Type {
	case "image":
		where = append(where, "i.video = 0")
	case "video":
		where = append(where, "i.video = 1")
	}
	if t := strings.TrimSpace(q.Q); t != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(t)) + "%"
		where = append(where, `(lower(i.path) LIKE ? ESCAPE '\' OR lower(i.city) LIKE ? ESCAPE '\' OR lower(i.country) LIKE ? ESCAPE '\' OR lower(i.camera) LIKE ? ESCAPE '\')`)
		args = append(args, like, like, like, like)
	}
	if q.Before != "" {
		where = append(where, "i.sort_at < ?")
		args = append(args, q.Before)
	}
	return ` FROM cloud_items i JOIN cloud_accounts a ON a.id = i.account_id WHERE ` + strings.Join(where, " AND "), args
}

type CloudBucket struct {
	TimeBucket string `json:"timeBucket"`
	Count      int    `json:"count"`
}

// CloudTimeline aggregates the complete filtered index, not just the loaded page.
func (s *Store) CloudTimeline(ctx context.Context, q CloudQuery) ([]CloudBucket, error) {
	q.Before = ""
	base, args := cloudItemsWhere(q)
	rows, err := s.DB.QueryContext(ctx, `SELECT substr(i.sort_at,1,7), COUNT(*)`+base+` AND i.sort_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-*' AND substr(i.sort_at,6,2) BETWEEN '01' AND '12' GROUP BY substr(i.sort_at,1,7) ORDER BY substr(i.sort_at,1,7) DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	buckets := []CloudBucket{}
	for rows.Next() {
		var b CloudBucket
		if err := rows.Scan(&b.TimeBucket, &b.Count); err != nil {
			return nil, err
		}
		buckets = append(buckets, b)
	}
	return buckets, rows.Err()
}

// ListCloudItems pages through a person's indexed items, newest first.
func (s *Store) ListCloudItems(ctx context.Context, q CloudQuery) (items []*CloudItem, next string, total int, err error) {
	base, args := cloudItemsWhere(q)
	if err = s.DB.QueryRowContext(ctx, `SELECT COUNT(*)`+base, args...).Scan(&total); err != nil {
		return
	}
	dir, cmp := "DESC", "<"
	if q.Asc {
		dir, cmp = "ASC", ">"
	}
	page := base
	pargs := append([]any{}, args...)
	if q.Cursor != "" {
		at, id, ok := decodeCursor(q.Cursor)
		if !ok {
			return nil, "", 0, fmt.Errorf("bad cursor")
		}
		page += fmt.Sprintf(" AND (i.sort_at %s ? OR (i.sort_at = ? AND i.id %s ?))", cmp, cmp)
		pargs = append(pargs, at, at, id)
	}
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	items, err = s.queryItems(ctx, `SELECT `+cloudItemCols+`, i.sort_at`+page+fmt.Sprintf(` ORDER BY i.sort_at %s, i.id %s LIMIT ?`, dir, dir), append(pargs, limit+1)...)
	if err != nil {
		return
	}
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeCursor(firstOf(last.TakenAt, last.ModifiedAt), last.ID)
	}
	return
}

type CloudPoint struct {
	ID        int64   `json:"id"`
	AccountID int64   `json:"account_id"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	City      string  `json:"city,omitempty"`
	Country   string  `json:"country,omitempty"`
}

func (s *Store) CloudMap(ctx context.Context, userID, accountID int64) ([]CloudPoint, error) {
	q := `SELECT i.id, i.account_id, i.lat, i.lon, i.city, i.country FROM cloud_items i JOIN cloud_accounts a ON a.id = i.account_id WHERE a.user_id = ? AND i.lat IS NOT NULL`
	args := []any{userID}
	if accountID > 0 {
		q += ` AND i.account_id = ?`
		args = append(args, accountID)
	}
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CloudPoint{}
	for rows.Next() {
		var p CloudPoint
		if err := rows.Scan(&p.ID, &p.AccountID, &p.Lat, &p.Lon, &p.City, &p.Country); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) Geocache(ctx context.Context, key string) (city, country string, ok bool) {
	ok = s.DB.QueryRowContext(ctx, `SELECT city, country FROM geocache WHERE key = ?`, key).Scan(&city, &country) == nil
	return
}

func (s *Store) PutGeocache(ctx context.Context, key, city, country string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO geocache (key, city, country) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET city = excluded.city, country = excluded.country`, key, city, country)
	return err
}

func (s *Store) queryItems(ctx context.Context, q string, args ...any) ([]*CloudItem, error) {
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []*CloudItem{}
	for rows.Next() {
		var it *CloudItem
		if len(cols) > 24 { // with sort_at for the cursor
			var sortAt string
			it, err = scanCloudItem(scanExtra{rows, &sortAt})
		} else {
			it, err = scanCloudItem(rows)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

type scanExtra struct {
	rows  *sql.Rows
	extra *string
}

func (x scanExtra) Scan(dest ...any) error { return x.rows.Scan(append(dest, x.extra)...) }

func encodeCursor(at string, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%s|%d", at, id)))
}

func decodeCursor(c string) (string, int64, bool) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return "", 0, false
	}
	at, idStr, ok := strings.Cut(string(b), "|")
	var id int64
	if _, err := fmt.Sscan(idStr, &id); !ok || err != nil {
		return "", 0, false
	}
	return at, id, true
}

func firstOf(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func nullF(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}
