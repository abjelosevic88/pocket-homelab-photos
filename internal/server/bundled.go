package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

// ---- The Immich that comes with Pocket Photos (IMMICH_BUNDLED) ----
//
// The sample docker-compose.yml can start Immich next to Pocket Photos (the
// "immich" profile, on in the sample .env and in Pocket Core's installer),
// with no port of its own. On a fresh Immich, Pocket Photos makes the
// administrator (pocket-photos@pocket.invalid, a random password sealed with
// secret.key); everyone who uses Pocket Photos then gets their own Immich
// account the first time (their email, a random password kept sealed here so
// they can also sign in to Immich's own app), and an API key Pocket Photos
// uses for them, saved as their connection. An Immich that already has an
// administrator is left alone: people connect their own account as with any
// other. That is how IMMICH_BUNDLED=auto (the sample's) tells the two apart,
// so the same compose file runs with the bundled Immich or pointed at yours.

const (
	bundledAdminEmail = "pocket-photos@pocket.invalid"
	kvBundledAdmin    = "bundled:admin" // sealed password of the administrator
	kvBundledReady    = "bundled:ready" // the administrator exists: this app runs the server's accounts
	kvBundledUser     = "bundled:user:" // + person id → Immich email NUL sealed password
)

type bundledState struct {
	on    atomic.Bool
	mu    sync.Mutex
	ready bool
	state string
	users sync.Mutex
}

func (s *Server) bundledOn() bool {
	return s.cfg.ImmichBundled == "true" || s.bundled.on.Load()
}

func (s *Server) setBundled(ready bool, state string) {
	s.bundled.mu.Lock()
	s.bundled.ready, s.bundled.state = ready, state
	s.bundled.mu.Unlock()
}

func (s *Server) bundledReady() (bool, string) {
	s.bundled.mu.Lock()
	defer s.bundled.mu.Unlock()
	return s.bundled.ready, s.bundled.state
}

var (
	errBundledByHand = errors.New("this Immich already had an administrator when Pocket Photos started: connect your Immich account instead")
	errNotBundled    = errors.New("not bundled")
)

// immichCall sends one JSON request to Immich (auth: "Bearer …", "key …" or "").
func (s *Server) immichCall(ctx context.Context, method, path, auth string, body, out any) (int, error) {
	base, err := apiBase(s.cfg.ImmichURL)
	if err != nil {
		return 0, err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, base+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	switch {
	case strings.HasPrefix(auth, "Bearer "):
		req.Header.Set("Authorization", auth)
	case strings.HasPrefix(auth, "key "):
		req.Header.Set("x-api-key", strings.TrimPrefix(auth, "key "))
	}
	res, err := s.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("Immich is not reachable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var e struct {
			Message any `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&e)
		return res.StatusCode, fmt.Errorf("Immich answered HTTP %d: %v", res.StatusCode, e.Message)
	}
	if out != nil {
		return res.StatusCode, json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode, nil
}

// immichLogin signs in with a password and returns "Bearer <token>".
func (s *Server) immichLogin(ctx context.Context, email, password string) (string, int, error) {
	var v struct {
		AccessToken string `json:"accessToken"`
	}
	code, err := s.immichCall(ctx, "POST", "/auth/login", "", map[string]string{"email": email, "password": password}, &v)
	if err != nil {
		return "", code, err
	}
	if v.AccessToken == "" {
		return "", code, errors.New("Immich gave no session")
	}
	return "Bearer " + v.AccessToken, code, nil
}

func (s *Server) bundledLoop(ctx context.Context) {
	if s.store.KV(ctx, kvBundledReady) != "" {
		s.bundled.on.Store(true)
	}
	s.setBundled(false, "the Immich that comes with Pocket Photos is starting")
	wait := 3 * time.Second
	for {
		err := s.setupBundled(ctx)
		switch {
		case err == nil:
			s.setBundled(true, "")
			return
		case errors.Is(err, errNotBundled):
			s.setBundled(false, "")
			s.log.Info("immich already has an administrator; people connect their own accounts", "url", s.cfg.ImmichURL)
			return
		case errors.Is(err, errBundledByHand):
			s.setBundled(false, err.Error())
			s.log.Warn("bundled immich", "err", err)
			return
		}
		s.setBundled(false, "the Immich that comes with Pocket Photos is not ready: "+err.Error())
		if wait >= 30*time.Second && s.bundledOn() {
			s.log.Warn("bundled immich not ready", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if wait < time.Minute {
			wait *= 2
		}
	}
}

func (s *Server) setupBundled(ctx context.Context) error {
	pw := s.openKV(ctx, kvBundledAdmin)
	if pw != "" {
		_, code, err := s.immichLogin(ctx, bundledAdminEmail, pw)
		if err == nil {
			return s.bundledIsOurs(ctx)
		}
		if code != http.StatusUnauthorized {
			return err // not reachable or still starting
		}
		// never made (the first try did not reach it): make it now with the same password
	} else {
		// kept before asking, so an answer lost on the way still signs in next time
		pw = store.RandomToken(24)
		if err := s.sealKV(ctx, kvBundledAdmin, pw); err != nil {
			return err
		}
	}
	code, err := s.immichCall(ctx, "POST", "/auth/admin-sign-up", "", map[string]string{"email": bundledAdminEmail, "password": pw, "name": "Pocket Photos"}, nil)
	if code == http.StatusBadRequest {
		_ = s.store.SetKV(ctx, kvBundledAdmin, "")
		if s.store.KV(ctx, kvBundledReady) != "" {
			return fmt.Errorf("signing in as %s: Immich does not accept the password Pocket Photos set", bundledAdminEmail)
		}
		if s.cfg.ImmichBundled == "auto" {
			return errNotBundled
		}
		return errBundledByHand
	}
	if err != nil {
		return err
	}
	s.log.Info("bundled immich set up", "admin", bundledAdminEmail)
	return s.bundledIsOurs(ctx)
}

func (s *Server) bundledIsOurs(ctx context.Context) error {
	s.bundled.on.Store(true)
	return s.store.SetKV(ctx, kvBundledReady, "1")
}

func (s *Server) openKV(ctx context.Context, k string) string {
	v := s.store.KV(ctx, k)
	if v == "" {
		return ""
	}
	plain, err := s.open(v)
	if err != nil {
		return ""
	}
	return plain
}

func (s *Server) sealKV(ctx context.Context, k, v string) error {
	sealed, err := s.seal(v)
	if err != nil {
		return err
	}
	return s.store.SetKV(ctx, k, sealed)
}

// bundledLogin is the person's own Immich login on the bundled server ("" when none yet).
func (s *Server) bundledLogin(ctx context.Context, uid int64) (email, password string) {
	v := s.store.KV(ctx, kvBundledUser+strconv.FormatInt(uid, 10))
	email, sealed, _ := strings.Cut(v, "\x00")
	if email == "" {
		return "", ""
	}
	pw, err := s.open(sealed)
	if err != nil {
		return "", ""
	}
	return email, pw
}

// bundledConnect gives the person an account on the bundled Immich (made the
// first time) and saves an API key for it as their connection.
func (s *Server) bundledConnect(ctx context.Context, u *store.User) error {
	if ok, state := s.bundledReady(); !ok {
		return errors.New(firstNonEmpty(state, "the Immich that comes with Pocket Photos is starting"))
	}
	s.bundled.users.Lock()
	defer s.bundled.users.Unlock()
	var exists int
	_ = s.store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM connections WHERE user_id=?`, u.ID).Scan(&exists)
	if exists > 0 {
		return nil
	}
	email, pw := s.bundledLogin(ctx, u.ID)
	if email == "" {
		admin, _, err := s.immichLogin(ctx, bundledAdminEmail, s.openKV(ctx, kvBundledAdmin))
		if err != nil {
			return err
		}
		email, pw = strings.ToLower(strings.TrimSpace(u.Email)), store.RandomToken(24)
		code, err := s.immichCall(ctx, "POST", "/admin/users", admin, map[string]any{"email": email, "name": firstNonEmpty(strings.TrimSpace(u.Name), email), "password": pw, "shouldChangePassword": false}, nil)
		if code == http.StatusBadRequest {
			return errors.New("Immich already has an account with your email: connect it with an API key under Settings")
		}
		if err != nil {
			return err
		}
		sealed, err := s.seal(pw)
		if err != nil {
			return err
		}
		if err := s.store.SetKV(ctx, kvBundledUser+strconv.FormatInt(u.ID, 10), email+"\x00"+sealed); err != nil {
			return err
		}
		s.log.Info("bundled immich account made", "user", u.Email)
	}
	session, _, err := s.immichLogin(ctx, email, pw)
	if err != nil {
		return err
	}
	var key struct {
		Secret string `json:"secret"`
	}
	if _, err := s.immichCall(ctx, "POST", "/api-keys", session, map[string]any{"name": "Pocket Photos", "permissions": []string{"all"}}, &key); err != nil {
		return err
	}
	_, _ = s.immichCall(ctx, "POST", "/auth/logout", session, nil, nil)
	if key.Secret == "" {
		return errors.New("Immich made no API key")
	}
	sealed, err := s.seal(key.Secret)
	if err != nil {
		return err
	}
	_, err = s.store.DB.ExecContext(ctx, `INSERT INTO connections(user_id,secret,kind,email,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,kind=excluded.kind,email=excluded.email,updated_at=excluded.updated_at`, u.ID, sealed, "api", email, store.Now())
	return err
}
