package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/config"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/crypto/bcrypt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "0.1.0"

type Server struct {
	cfg         *config.Config
	store       *store.Store
	log         *slog.Logger
	webFS       fs.FS
	http        *http.Client
	core        *core.Client
	oidc        *oidcProvider
	oidcMu      sync.Mutex
	provisionMu sync.Mutex
	started     time.Time
	requests    atomic.Int64

	bg              context.Context // lives as long as the server; background scans run under it
	scans           cloudScans
	thumbSlots      chan struct{}
	cloudClient     *http.Client
	cloudClientOnce sync.Once
}

func New(cfg *config.Config, st *store.Store, log *slog.Logger, web fs.FS) *Server {
	return &Server{cfg: cfg, store: st, log: log, webFS: web, started: time.Now(), bg: context.Background(), thumbSlots: make(chan struct{}, 4), http: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 45 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 100, MaxIdleConnsPerHost: 16}, Timeout: 30 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}, core: core.New(cfg.CoreURL, core.Options{DB: st.DB, TokenFile: cfg.DataDir + "/core.token", UserAgent: "PocketPhotos/" + Version})}
}
func (s *Server) Bootstrap(ctx context.Context) error {
	if err := s.loadSecretKey(); err != nil {
		return err
	}
	if err := s.core.Start(ctx); err != nil {
		return err
	}
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n == 0 && s.cfg.AdminEmail != "" && s.cfg.AdminPassword != "" {
		if len(s.cfg.AdminPassword) < 8 {
			return errors.New("ADMIN_PASSWORD must have at least 8 characters")
		}
		h, e := bcrypt.GenerateFromPassword([]byte(s.cfg.AdminPassword), bcrypt.DefaultCost)
		if e != nil {
			return e
		}
		if e = s.store.CreateUser(ctx, &store.User{Email: s.cfg.AdminEmail, Name: s.cfg.AdminName, Role: "admin", PasswordHash: string(h)}); e != nil {
			return e
		}
	}
	if s.core.Configured() {
		go s.coreLoop(ctx)
	}
	s.bg = ctx
	go s.cloudLoop(ctx)
	_ = s.store.PurgeSessions(ctx)
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = s.store.PurgeSessions(ctx)
			}
		}
	}()
	return nil
}
func (s *Server) coreLoop(ctx context.Context) {
	for {
		m := core.Manifest{Slug: "photos", Name: "Pocket Photos", Description: "Your photo library across Immich, Pocket Files and Pocket Documents", Icon: "/favicon.svg", Version: Version, URL: s.cfg.CoreAppURL, PublicURL: s.cfg.BaseURL, HealthPath: "/healthz", EnvPrefix: "PHOTOS", Services: []core.ServiceUse{{Type: "immich", Reason: "Your photo library, albums, search and memories"}, {Type: "nextcloud", Reason: "Index the photos in your Nextcloud, see them on the map and import the ones you pick"}}, Uses: []core.Use{{App: "files", Scopes: []string{"files:read"}, Reason: "Browse photos in your files and copy selected originals into your photo library"}, {App: "documents", Scopes: []string{"documents:read"}, Reason: "Find image documents and copy selected originals into your photo library"}}}
		if s.cfg.BaseURL != "" {
			m.OIDC = &core.OIDCRequest{RedirectURIs: []string{s.cfg.BaseURL + "/api/v1/auth/oidc/callback"}}
		}
		wait := 30 * time.Minute
		if _, err := s.core.Register(ctx, s.cfg.CoreRegistrationKey, m); err != nil {
			s.log.Warn("Core registration", "error", err)
			wait = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	if s.cfg.TrustProxy {
		r.Use(middleware.RealIP)
	}
	r.Use(s.security)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "version": Version})
	})
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if e := s.store.DB.PingContext(r.Context()); e != nil {
			writeErr(w, 503, "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	if s.cfg.MetricsEnabled {
		r.Get("/metrics", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			fmt.Fprintf(w, "# TYPE pocket_photos_http_requests_total counter\npocket_photos_http_requests_total %d\n# TYPE pocket_photos_uptime_seconds gauge\npocket_photos_uptime_seconds %.0f\n", s.requests.Load(), time.Since(s.started).Seconds())
		})
	}
	r.Get("/pocket-ask.js", s.core.AskWidget("photos"))
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/auth/status", s.handleAuthStatus)
		r.Post("/client-error", s.handleClientError)
		r.Post("/auth/login", s.handleLogin)
		r.Post("/auth/setup", s.handleSetup)
		r.Get("/auth/oidc/start", s.handleOIDCStart)
		r.Get("/auth/oidc/callback", s.handleOIDCCallback)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Get("/auth/me", s.handleMe)
			r.Put("/auth/me", s.handleUpdateMe)
			r.Post("/auth/logout", s.handleLogout)
			r.Get("/connection", s.handleConnection)
			r.Put("/connection", s.handleConnect)
			r.Delete("/connection", s.handleDisconnect)
			r.Get("/sources/{app}/*", s.handleSource)
			r.Post("/sources/{app}/import", s.handleImport)
			r.Get("/clouds/providers", s.handleCloudProviders)
			r.Get("/clouds", s.handleListClouds)
			r.Post("/clouds", s.handleCreateCloud)
			r.Get("/clouds/oauth/{kind}/start", s.handleCloudOAuthStart)
			r.Get("/clouds/oauth/{kind}/callback", s.handleCloudOAuthCallback)
			r.Get("/clouds/items", s.handleCloudItems)
			r.Get("/clouds/map", s.handleCloudMap)
			r.Get("/clouds/items/{id}", s.handleCloudItem)
			r.Get("/clouds/items/{id}/thumb", s.handleCloudThumb)
			r.Get("/clouds/items/{id}/preview", s.handleCloudPreview)
			r.Get("/clouds/items/{id}/original", s.handleCloudOriginal)
			r.Post("/clouds/items/{id}/import", s.handleCloudImport)
			r.Put("/clouds/{id}", s.handleUpdateCloud)
			r.Delete("/clouds/{id}", s.handleDeleteCloud)
			r.Post("/clouds/{id}/scan", s.handleScanCloud)
			r.Handle("/immich/*", http.HandlerFunc(s.handleImmich))
			r.Get("/users", s.handleListUsers)
			r.Post("/users", s.handleCreateUser)
			r.Put("/users/{id}", s.handleUpdateUser)
			r.Delete("/users/{id}", s.handleDeleteUser)
			r.Get("/tokens", s.handleListTokens)
			r.Post("/tokens", s.handleCreateToken)
			r.Delete("/tokens/{id}", s.handleDeleteToken)
		})
	})
	r.NotFound(s.handleSPA)
	return r
}
func (s *Server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				writeErr(w, 403, "cross-site request rejected")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, e := url.Parse(origin)
				base, _ := url.Parse(s.cfg.BaseURL)
				if e != nil || (u.Host != r.Host && (base == nil || base.Host == "" || u.Host != base.Host)) {
					writeErr(w, 403, "origin rejected")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
func (s *Server) fail(w http.ResponseWriter, err error, what string) {
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "not found")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeErr(w, 409, "already exists")
		return
	}
	s.log.Error(what, "error", err)
	writeErr(w, 500, what+" failed")
}
func decode(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}
func idParam(r *http.Request, n string) int64 {
	v, _ := strconv.ParseInt(chi.URLParam(r, n), 10, 64)
	return v
}
func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, 404, "not found")
		return
	}
	if s.webFS == nil {
		http.Error(w, "Build the web UI first", 503)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if f, e := s.webFS.Open(p); e == nil {
		f.Close()
	} else {
		r.URL.Path = "/"
	}
	http.FileServerFS(s.webFS).ServeHTTP(w, r)
}

// handleClientError writes a crash of the web app into the server's log.
func (s *Server) handleClientError(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Message, Stack, Component, URL, Where, Agent string
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	who := ""
	if u, err := s.resolveUser(r); err == nil && u != nil {
		who = u.Email
	}
	s.log.Warn("web app crashed", "user", who, "where", in.Where, "url", in.URL, "message", in.Message, "stack", in.Stack, "component", in.Component, "agent", in.Agent)
	w.WriteHeader(http.StatusNoContent)
}
