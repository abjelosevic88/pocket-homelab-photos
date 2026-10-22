package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/config"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

func testServer(t *testing.T, upstream string) *Server {
	t.Helper()
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, e := store.Open(filepath.Join(dir, "test.db"), log)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { st.Close() })
	cfg := &config.Config{DataDir: dir, ImmichURL: upstream, AuthMode: "local", SessionTTL: time.Hour}
	s := New(cfg, st, log, nil)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if e = s.Bootstrap(ctx); e != nil {
		t.Fatal(e)
	}
	return s
}
func account(t *testing.T, s *Server, email string) *http.Cookie {
	t.Helper()
	u := &store.User{Email: email, Name: email, Role: "member"}
	if e := s.store.CreateUser(context.Background(), u); e != nil {
		t.Fatal(e)
	}
	token, e := s.store.CreateSession(context.Background(), u.ID, time.Hour)
	if e != nil {
		t.Fatal(e)
	}
	return &http.Cookie{Name: sessionCookie, Value: token}
}
func request(s *Server, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, r)
	return w
}
func TestPrivateLibraryRequiresAuthentication(t *testing.T) {
	s := testServer(t, "")
	for _, path := range []string{"/api/v1/connection", "/api/v1/immich/assets/statistics", "/api/v1/sources/files/spaces", "/api/v1/sources/documents/documents"} {
		if w := request(s, "GET", path, nil, nil); w.Code != 401 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
}
func TestConnectionsAreEncryptedAndIsolated(t *testing.T) {
	var keys []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("x-api-key"))
		if r.URL.Path != "/api/users/me" {
			t.Errorf("path %s", r.URL.Path)
		}
		writeJSON(w, 200, map[string]string{"email": "immich@example.com"})
	}))
	defer up.Close()
	s := testServer(t, up.URL)
	alice := account(t, s, "alice@example.com")
	bob := account(t, s, "bob@example.com")
	w := request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "private-alice-key"}, alice)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var saved string
	if e := s.store.DB.QueryRow(`SELECT secret FROM connections`).Scan(&saved); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(saved, "private-alice-key") || !strings.HasPrefix(saved, "v1:") {
		t.Fatal("secret not encrypted")
	}
	w = request(s, "GET", "/api/v1/connection", nil, bob)
	if strings.Contains(w.Body.String(), `"connected":true`) {
		t.Fatal("Bob received Alice's connection")
	}
	w = request(s, "GET", "/api/v1/connection", nil, alice)
	if !strings.Contains(w.Body.String(), `"connected":true`) || strings.Contains(w.Body.String(), "private-alice-key") {
		t.Fatal(w.Body.String())
	}
	if len(keys) != 2 || keys[0] != "private-alice-key" || keys[1] != "private-alice-key" {
		t.Fatal(keys)
	}
	request(s, "DELETE", "/api/v1/connection", nil, bob)
	if w = request(s, "GET", "/api/v1/connection", nil, alice); !strings.Contains(w.Body.String(), `"connected":true`) {
		t.Fatal("Bob removed Alice's connection")
	}
}
func TestProxyPreservesRangeButStripsBrowserCredentials(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789abc"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/users/me" {
			writeJSON(w, 200, map[string]string{"id": "a"})
			return
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("browser credentials forwarded")
		}
		if r.Header.Get("X-API-Key") != "immich-key" || r.Header.Get("Range") != "bytes=2-5" {
			t.Error("missing upstream headers")
		}
		if r.URL.Query().Get("key") != "" {
			t.Error("shared key bypass forwarded")
		}
		w.Header().Set("Content-Range", "bytes 2-5/10")
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		_, _ = w.Write([]byte("2345"))
	}))
	defer up.Close()
	s := testServer(t, up.URL)
	cookie := account(t, s, "a@example.com")
	request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "immich-key"}, cookie)
	r := httptest.NewRequest("GET", "/api/v1/immich/assets/"+id+"/video/playback?key=attacker", nil)
	r.AddCookie(cookie)
	r.Header.Set("Range", "bytes=2-5")
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "2345" || w.Header().Get("Content-Range") == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("media may be publicly cached")
	}
}
func TestProxyRejectsAdministrativeEndpointsAndTraversal(t *testing.T) {
	s := testServer(t, "")
	cookie := account(t, s, "a@example.com")
	for _, p := range []string{"/admin/users", "/api-keys", "/auth/login", "/server/config", "/assets/../../admin/users", "/trash/empty"} {
		w := request(s, "POST", "/api/v1/immich"+p, map[string]string{}, cookie)
		if w.Code != 404 {
			t.Fatalf("%s: %d", p, w.Code)
		}
	}
	for _, p := range []string{"/fs/delete", "/fs/upload", "/mounts", "/fs/../settings"} {
		if allowedSource("files", p) {
			t.Fatal(p)
		}
	}
}
func TestCSRFRejectsCrossOriginMutations(t *testing.T) {
	s := testServer(t, "")
	for _, h := range []http.Header{{"Origin": []string{"https://evil.example"}}, {"Sec-Fetch-Site": []string{"cross-site"}}} {
		r := httptest.NewRequest("POST", "http://photos.example/api/v1/auth/setup", strings.NewReader(`{"email":"a@b.com","password":"long-password"}`))
		r.Header = h
		w := httptest.NewRecorder()
		s.Router().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
}
func TestSetupCannotBeRepeated(t *testing.T) {
	s := testServer(t, "")
	payload := map[string]string{"email": "a@example.com", "password": "long-password"}
	if w := request(s, "POST", "/api/v1/auth/setup", payload, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "POST", "/api/v1/auth/setup", payload, nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestSecretTamperingAndWrongKeyFail(t *testing.T) {
	s := testServer(t, "")
	a, e := s.seal("secret")
	if e != nil {
		t.Fatal(e)
	}
	b, _ := s.seal("secret")
	if a == b {
		t.Fatal("nonce reused")
	}
	if v, e := s.open(a); e != nil || v != "secret" {
		t.Fatal(e)
	}
	if _, e := s.open(a[:len(a)-5] + "AAAAA"); e == nil {
		t.Fatal("tampering accepted")
	}
	s2 := testServer(t, "")
	if _, e := s2.open(a); e == nil {
		t.Fatal("wrong key accepted")
	}
}
func TestRedirectDoesNotLeakKey(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer target.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer up.Close()
	s := testServer(t, up.URL)
	cookie := account(t, s, "a@example.com")
	w := request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "private"}, cookie)
	if w.Code != 401 || leaked.Load() {
		t.Fatal(w.Code, leaked.Load())
	}
}
func TestLoginSessionIsRevokedOnLogout(t *testing.T) {
	s := testServer(t, "")
	c := account(t, s, "a@example.com")
	if w := request(s, "GET", "/api/v1/auth/me", nil, c); w.Code != 200 {
		t.Fatal(w.Code)
	}
	request(s, "POST", "/api/v1/auth/logout", nil, c)
	if w := request(s, "GET", "/api/v1/auth/me", nil, c); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
func TestUpdateMeRenamesAndChangesPassword(t *testing.T) {
	s := testServer(t, "")
	c := account(t, s, "a@example.com")
	if w := request(s, "PUT", "/api/v1/auth/me", map[string]string{"name": "Ana"}, c); w.Code != 200 || !strings.Contains(w.Body.String(), `"Ana"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "PUT", "/api/v1/auth/me", map[string]string{"new_password": "short"}, c); w.Code != 400 {
		t.Fatal("short password accepted", w.Code)
	}
	if w := request(s, "PUT", "/api/v1/auth/me", map[string]string{"new_password": "long enough"}, c); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "PUT", "/api/v1/auth/me", map[string]string{"current_password": "wrong one", "new_password": "another one"}, c); w.Code != 400 {
		t.Fatal("wrong current password accepted", w.Code)
	}
	if w := request(s, "PUT", "/api/v1/auth/me", map[string]string{"name": "x"}, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
func TestSourceImportUsesDelegatedReadAndKeepsSourceUnchanged(t *testing.T) {
	for _, app := range []string{"files", "documents"} {
		t.Run(app, func(t *testing.T) {
			var downloaded, uploaded bool
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer delegated-read-token" {
					t.Error("source not read-only delegated")
				}
				downloaded = true
				w.Header().Set("Content-Type", "image/jpeg")
				w.Header().Set("Content-Disposition", `attachment; filename="original.jpg"`)
				_, _ = w.Write([]byte("test-original-jpeg"))
			}))
			defer source.Close()
			coreServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var b map[string]any
				_ = json.NewDecoder(r.Body).Decode(&b)
				if b["user"] != "a@example.com" || b["app"] != app {
					t.Errorf("incorrect delegation identity: %v", b)
				}
				scopes, ok := b["scopes"].([]any)
				if !ok || len(scopes) != 1 || scopes[0] != app+":read" {
					t.Errorf("incorrect scopes: %v", b["scopes"])
				}
				if !strings.Contains(r.URL.Path, "token") {
					t.Log(r.URL.Path)
				}
				writeJSON(w, 200, map[string]any{"access_token": "delegated-read-token", "url": source.URL, "expires_in": 60, "scope": app + ":read"})
			}))
			defer coreServer.Close()
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/users/me" {
					writeJSON(w, 200, map[string]string{"id": "a"})
					return
				}
				if e := r.ParseMultipartForm(1 << 20); e != nil {
					t.Error(e)
				}
				f, h, e := r.FormFile("assetData")
				if e != nil {
					t.Error(e)
					return
				}
				defer f.Close()
				data, _ := io.ReadAll(f)
				if string(data) != "test-original-jpeg" || h.Filename != "original.jpg" {
					t.Error("original changed")
				}
				if r.FormValue("fileCreatedAt") == "" {
					t.Error("missing date")
				}
				uploaded = true
				writeJSON(w, 201, map[string]string{"id": "asset-id", "status": "created"})
			}))
			defer up.Close()
			s := testServer(t, up.URL)
			s.core = core.New(coreServer.URL, core.Options{TokenFile: filepath.Join(t.TempDir(), "core.token")})
			c := account(t, s, "a@example.com")
			request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "immich-key"}, c)
			w := request(s, "POST", "/api/v1/sources/"+app+"/import", map[string]any{"space": "home", "path": "/original.jpg", "id": 1}, c)
			if w.Code != 201 || !downloaded || !uploaded {
				t.Fatal(w.Code, w.Body.String(), downloaded, uploaded)
			}
		})
	}
}

// Neither the settings status nor media/API requests may reuse a credential
// after Core revokes it, even if the SDK already has a warm credential cache.
func TestCoreImmichRevocation(t *testing.T) {
	for _, reason := range []string{"off_admin", "off_person", "unavailable"} {
		t.Run(reason, func(t *testing.T) {
			var blocked atomic.Bool
			var upstreamCalls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls.Add(1)
				writeJSON(w, 200, map[string]string{"id": "test-user"})
			}))
			defer up.Close()
			coreServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/services/credential" {
					t.Errorf("unexpected Core request: %s", r.URL.Path)
				}
				if blocked.Load() {
					if reason == "unavailable" {
						writeErr(w, 503, "Core unavailable")
					} else {
						writeJSON(w, 403, map[string]string{"reason": reason, "error": "Immich access disabled"})
					}
					return
				}
				writeJSON(w, 200, map[string]string{"url": up.URL, "key": "test-key"})
			}))
			defer coreServer.Close()
			s := testServer(t, "")
			s.core = core.New(coreServer.URL, core.Options{})
			cookie := account(t, s, "a@example.com")
			if _, err := s.core.ServiceFor(context.Background(), "a@example.com", "immich"); err != nil {
				t.Fatal(err)
			}
			if w := request(s, "GET", "/api/v1/connection", nil, cookie); !strings.Contains(w.Body.String(), `"connected":true`) {
				t.Fatal(w.Body.String())
			}
			blocked.Store(true)
			before := upstreamCalls.Load()
			for _, path := range []string{"/api/v1/immich/assets/statistics", "/api/v1/immich/assets/12345678-1234-4234-8234-123456789abc/thumbnail"} {
				w := request(s, "GET", path, nil, cookie)
				if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"connection_unavailable"`) {
					t.Fatal(path, w.Code, w.Body.String())
				}
			}
			w := request(s, "GET", "/api/v1/connection", nil, cookie)
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"connected":false`) || strings.Contains(w.Body.String(), "test-key") {
				t.Fatal(w.Code, w.Body.String())
			}
			if upstreamCalls.Load() != before {
				t.Fatal("Immich was contacted after Core denied access")
			}
			blocked.Store(false)
			if w := request(s, "GET", "/api/v1/connection", nil, cookie); !strings.Contains(w.Body.String(), `"connected":true`) {
				t.Fatal("connection did not recover", w.Body.String())
			}
		})
	}
}
