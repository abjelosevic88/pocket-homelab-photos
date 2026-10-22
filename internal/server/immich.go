package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type connection struct{ Base, Public, Secret, Kind, Via string }

func apiBase(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("configure a valid IMMICH_URL on the server")
	}
	return strings.TrimSuffix(strings.TrimRight(raw, "/"), "/api") + "/api", nil
}
func (s *Server) connection(ctx context.Context, u *store.User) (*connection, error) {
	var sealed, kind string
	e := s.store.DB.QueryRowContext(ctx, `SELECT secret,kind FROM connections WHERE user_id=?`, u.ID).Scan(&sealed, &kind)
	if e == nil {
		key, e := s.open(sealed)
		if e != nil {
			return nil, e
		}
		base, e := apiBase(s.cfg.ImmichURL)
		if e != nil {
			return nil, e
		}
		return &connection{base, s.cfg.ImmichPublicURL, key, kind, "direct"}, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	if s.core.Configured() {
		// Authorization must reflect Core's current switch, including for media
		// requests. Cached credentials (or stale-on-error fallback) bypass revocation.
		cred, e := s.core.ServiceForFresh(ctx, u.Email, "immich")
		if e != nil {
			return nil, e
		}
		base, e := apiBase(cred.URL)
		if e != nil {
			return nil, e
		}
		if cred.Key == "" {
			return nil, errors.New("add your Immich API key in Pocket Core")
		}
		public := cred.PublicURL
		if public == "" {
			public = s.cfg.ImmichPublicURL
		}
		if public == "" {
			public = strings.TrimSuffix(base, "/api")
		}
		return &connection{base, public, cred.Key, "api", "core"}, nil
	}
	return nil, errors.New("connect your Immich account to open your library")
}
func (s *Server) upstream(ctx context.Context, c *connection, method, path string, body io.Reader, headers http.Header) (*http.Response, error) {
	req, e := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if e != nil {
		return nil, e
	}
	for _, k := range []string{"Content-Type", "Range", "If-Range", "Accept"} {
		if v := headers.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	if c.Kind == "session" {
		req.Header.Set("Authorization", "Bearer "+c.Secret)
	} else {
		req.Header.Set("x-api-key", c.Secret)
	}
	return s.http.Do(req)
}
func (s *Server) handleConnection(w http.ResponseWriter, r *http.Request) {
	c, e := s.connection(r.Context(), userFrom(r.Context()))
	if e != nil {
		writeJSON(w, 200, map[string]any{"connected": false, "message": e.Error(), "server_configured": s.cfg.ImmichURL != "", "public_url": s.cfg.ImmichPublicURL, "core": s.core.Configured()})
		return
	}
	res, e := s.upstream(r.Context(), c, "GET", "/users/me", nil, nil)
	if e != nil {
		writeJSON(w, 200, map[string]any{"connected": false, "message": "Immich is unreachable", "server_configured": s.cfg.ImmichURL != ""})
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		writeJSON(w, 200, map[string]any{"connected": false, "message": "Immich rejected this connection. Check your credentials and user.read permission.", "server_configured": s.cfg.ImmichURL != ""})
		return
	}
	var user any
	if e = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&user); e != nil {
		writeErr(w, 502, "invalid Immich response")
		return
	}
	writeJSON(w, 200, map[string]any{"connected": true, "user": user, "via": c.Via, "public_url": c.Public, "server_configured": s.cfg.ImmichURL != "", "core": s.core.Configured()})
}
func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	var in struct {
		APIKey   string `json:"api_key"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if decode(r, &in) != nil {
		writeErr(w, 400, "invalid connection")
		return
	}
	base, e := apiBase(s.cfg.ImmichURL)
	if e != nil {
		writeErr(w, 400, e.Error())
		return
	}
	c := &connection{Base: base, Secret: strings.TrimSpace(in.APIKey), Kind: "api"}
	if c.Secret == "" && in.Email != "" && in.Password != "" {
		b, _ := json.Marshal(map[string]string{"email": in.Email, "password": in.Password})
		res, e := s.upstream(r.Context(), c, "POST", "/auth/login", bytes.NewReader(b), http.Header{"Content-Type": []string{"application/json"}})
		if e != nil {
			writeErr(w, 502, "Immich is unreachable")
			return
		}
		defer res.Body.Close()
		var v struct {
			AccessToken string `json:"accessToken"`
		}
		if res.StatusCode != 201 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&v) != nil || v.AccessToken == "" {
			writeErr(w, 401, "Immich sign-in failed; use an API key if password sign-in is disabled")
			return
		}
		c.Secret = v.AccessToken
		c.Kind = "session"
	}
	if c.Secret == "" {
		writeErr(w, 400, "enter an Immich API key or email and password")
		return
	}
	res, e := s.upstream(r.Context(), c, "GET", "/users/me", nil, nil)
	if e != nil {
		writeErr(w, 502, "Immich is unreachable")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		writeErr(w, 401, "Immich rejected these credentials; API keys need user.read permission")
		return
	}
	sealed, e := s.seal(c.Secret)
	if e != nil {
		s.fail(w, e, "encrypt connection")
		return
	}
	_, e = s.store.DB.ExecContext(r.Context(), `INSERT INTO connections(user_id,secret,kind,email,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,kind=excluded.kind,email=excluded.email,updated_at=excluded.updated_at`, actorID(r.Context()), sealed, c.Kind, in.Email, store.Now())
	if e != nil {
		s.fail(w, e, "save connection")
		return
	}
	writeJSON(w, 200, map[string]bool{"connected": true})
}
func (s *Server) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	_, e := s.store.DB.ExecContext(r.Context(), `DELETE FROM connections WHERE user_id=?`, actorID(r.Context()))
	if e != nil {
		s.fail(w, e, "disconnect")
		return
	}
	w.WriteHeader(204)
}

type proxyRule struct {
	methods string
	path    *regexp.Regexp
}

var immichRules = []proxyRule{
	{"GET", regexp.MustCompile(`^/(users/me|server/(version|features|config)|assets/statistics|albums/statistics|search/(cities|explore|suggestions)|map/markers|timeline/(buckets|bucket))$`)},
	{"POST", regexp.MustCompile(`^/search/(metadata|smart|random|large-assets)$`)},
	{"GET POST", regexp.MustCompile(`^/(albums|shared-links|memories)$`)},
	{"GET", regexp.MustCompile(`^/people$`)},
	{"POST PUT DELETE", regexp.MustCompile(`^/assets$`)},
	{"GET PUT", regexp.MustCompile(`^/assets/[a-fA-F0-9-]{36}$`)},
	{"GET", regexp.MustCompile(`^/assets/[a-fA-F0-9-]{36}/(thumbnail|original|video/playback)$`)},
	{"GET PUT DELETE", regexp.MustCompile(`^/assets/[a-fA-F0-9-]{36}/edits$`)},
	{"GET PATCH DELETE", regexp.MustCompile(`^/(albums|shared-links)/[a-fA-F0-9-]{36}$`)},
	{"PUT DELETE", regexp.MustCompile(`^/albums/[a-fA-F0-9-]{36}/assets$`)},
	{"GET PUT", regexp.MustCompile(`^/people/[a-fA-F0-9-]{36}$`)},
	{"GET", regexp.MustCompile(`^/people/[a-fA-F0-9-]{36}/(thumbnail|statistics)$`)},
	{"GET PUT DELETE", regexp.MustCompile(`^/memories/[a-fA-F0-9-]{36}$`)},
	{"POST", regexp.MustCompile(`^/trash/restore/assets$`)},
	{"POST", regexp.MustCompile(`^/download/(archive|info)$`)},
}

func allowedImmich(method, path string) bool {
	for _, rule := range immichRules {
		if strings.Contains(" "+rule.methods+" ", " "+method+" ") && rule.path.MatchString(path) {
			return true
		}
	}
	return false
}
func (s *Server) handleImmich(w http.ResponseWriter, r *http.Request) {
	path := "/" + chi.URLParam(r, "*")
	if !allowedImmich(r.Method, path) {
		writeErr(w, 404, "unsupported photo operation")
		return
	}
	c, e := s.connection(r.Context(), userFrom(r.Context()))
	if e != nil {
		writeJSON(w, 409, map[string]string{"error": e.Error(), "code": "connection_unavailable"})
		return
	}
	q := r.URL.Query()
	for _, key := range []string{"key", "slug", "token", "apiKey"} {
		q.Del(key)
	}
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	limit := int64(2 << 20)
	if r.Method == "POST" && strings.Split(path, "?")[0] == "/assets" {
		limit = 20 << 30
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	res, e := s.upstream(r.Context(), c, r.Method, path, r.Body, r.Header)
	if e != nil {
		writeErr(w, 502, "Immich request failed; check the server connection")
		return
	}
	defer res.Body.Close()
	relay(w, res)
}
func relay(w http.ResponseWriter, res *http.Response) {
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	for _, k := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition", "ETag", "Last-Modified"} {
		if v := res.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}
