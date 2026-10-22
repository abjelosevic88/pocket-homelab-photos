package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"

	"github.com/abjelosevic88/pocket-homelab-photos/internal/cloud"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/cloud/cloudtest"
)

// fakeNextcloud is a WebDAV tree under /remote.php/dav/files/ana/ with two photos in Photos/ (one in a
// subfolder) and a text file outside it; GETs honour Range, and /index.php/core/preview renders.
func fakeNextcloud(t *testing.T, photo []byte, gets *atomic.Int64) *httptest.Server {
	mod := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC).Format(http.TimeFormat)
	file := func(href, id string) string {
		return fmt.Sprintf(`<d:response><d:href>%s</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontenttype>image/jpeg</d:getcontenttype><d:getcontentlength>%d</d:getcontentlength><d:getlastmodified>%s</d:getlastmodified><d:getetag>"e%s"</d:getetag><oc:fileid>%s</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`, href, len(photo), mod, id, id)
	}
	dir := func(href string) string {
		return fmt.Sprintf(`<d:response><d:href>%s</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`, href)
	}
	const base = "/remote.php/dav/files/ana/"
	tree := map[string][]string{
		base:                         {dir(base), dir(base + "Photos/"), `<d:response><d:href>` + base + `notes.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontenttype>text/plain</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`},
		base + "Photos/":             {dir(base + "Photos/"), file(base+"Photos/IMG_0001.jpg", "11"), dir(base + "Photos/Summer%202026/")},
		base + "Photos/Summer 2026/": {dir(base + "Photos/Summer%202026/"), file(base+"Photos/Summer%202026/IMG_0002.JPG", "12")},
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "ana" || p != "app-password" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == "PROPFIND":
			p, _ := url.PathUnescape(r.URL.EscapedPath())
			if !strings.HasSuffix(p, "/") {
				p += "/"
			}
			rs, ok := tree[p]
			if !ok {
				w.WriteHeader(404)
				return
			}
			if r.Header.Get("Depth") == "0" {
				rs = rs[:1]
			}
			w.WriteHeader(207)
			fmt.Fprintf(w, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">%s</d:multistatus>`, strings.Join(rs, ""))
		case r.Method == "GET" && r.URL.Path == "/index.php/core/preview":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write(photo)
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, base+"Photos/"):
			gets.Add(1)
			http.ServeContent(w, r, "photo.jpg", time.Time{}, bytes.NewReader(photo))
		default:
			w.WriteHeader(404)
		}
	}))
}

// fakeImmich answers the connection check, reverse geocoding and uploads.
func fakeImmich(t *testing.T, uploads *atomic.Int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/users/me":
			writeJSON(w, 200, map[string]string{"email": "ana@example.com"})
		case "/api/map/reverse-geocode":
			writeJSON(w, 200, []map[string]string{{"city": "Sarajevo", "state": "Federation of B&H", "country": "Bosnia and Herzegovina"}})
		case "/api/assets":
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Errorf("upload: %v", err)
			}
			f, _, err := r.FormFile("assetData")
			if err != nil {
				t.Errorf("upload: %v", err)
			} else {
				b, _ := io.ReadAll(f)
				if !bytes.HasPrefix(b, []byte{0xFF, 0xD8}) {
					t.Error("upload is not the original JPEG")
				}
			}
			status := "created"
			if uploads.Add(1) > 1 {
				status = "duplicate"
			}
			writeJSON(w, 201, map[string]string{"id": fmt.Sprintf("asset-%d", uploads.Load()), "status": status})
		default:
			w.WriteHeader(404)
		}
	}))
}

func waitIdle(t *testing.T, s *Server, cookie *http.Cookie) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		w := request(s, "GET", "/api/v1/clouds", nil, cookie)
		var list []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &list)
		busy := false
		for _, a := range list {
			busy = busy || a["status"] == "scanning"
		}
		if !busy && len(list) > 0 {
			return list
		}
		if time.Now().After(deadline) {
			t.Fatalf("scan did not finish: %s", w.Body.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestNextcloudAccountIndexesPhotosInPlaceAndStaysPrivate(t *testing.T) {
	photo := cloudtest.JPEG(800, 600, 1)
	var gets, uploads atomic.Int64
	nc := fakeNextcloud(t, photo, &gets)
	defer nc.Close()
	im := fakeImmich(t, &uploads)
	defer im.Close()
	s := testServer(t, im.URL)
	ana := account(t, s, "ana@example.com")
	bob := account(t, s, "bob@example.com")
	if w := request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "ana-key"}, ana); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}

	// a wrong password is refused before anything is stored
	if w := request(s, "POST", "/api/v1/clouds", map[string]any{"kind": "nextcloud", "root": "Photos", "fields": map[string]string{"url": nc.URL, "username": "ana", "password": "wrong"}}, ana); w.Code != 400 {
		t.Fatal("wrong password accepted", w.Code, w.Body.String())
	}
	w := request(s, "POST", "/api/v1/clouds", map[string]any{"kind": "nextcloud", "name": "Home cloud", "root": "/Photos/", "fields": map[string]string{"url": nc.URL, "username": "ana", "password": "app-password"}}, ana)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var created struct{ ID int64 }
	json.Unmarshal(w.Body.Bytes(), &created)
	var sealed string
	s.store.DB.QueryRow(`SELECT secret FROM cloud_accounts`).Scan(&sealed)
	if strings.Contains(sealed, "app-password") || !strings.HasPrefix(sealed, "v1:") {
		t.Fatal("cloud password not sealed")
	}
	if strings.Contains(w.Body.String(), "app-password") || strings.Contains(w.Body.String(), "v1:") {
		t.Fatal("the account answer leaks the secret")
	}

	list := waitIdle(t, s, ana)
	counts := list[0]["counts"].(map[string]any)
	if counts["items"].(float64) != 2 || counts["located"].(float64) != 2 {
		t.Fatalf("counts %v (want both photos, both located; notes.txt and files outside Photos/ ignored): %v", counts, list[0])
	}
	w = request(s, "GET", fmt.Sprintf("/api/v1/clouds/items?account=%d", created.ID), nil, ana)
	var page struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &page)
	if page.Total != 2 {
		t.Fatal(w.Body.String())
	}
	it := page.Items[0]
	if it["taken_at"] != "2026-09-07T14:03:22+02:00" || it["camera"] != "Apple iPhone 15 Pro" || it["city"] != "Sarajevo" || it["has_thumb"] != true {
		t.Fatalf("item %v", it)
	}
	if !strings.HasPrefix(fmt.Sprint(it["web_url"]), nc.URL+"/f/1") {
		t.Fatalf("web_url %v", it["web_url"])
	}
	if paths := []string{page.Items[0]["path"].(string), page.Items[1]["path"].(string)}; !strings.Contains(strings.Join(paths, " "), "Photos/Summer 2026/IMG_0002.JPG") {
		t.Fatalf("paths %v", paths)
	}
	// Indexing read a couple of 64 KiB blocks per photo, not whole files.
	if n := gets.Load(); n > 4 {
		t.Errorf("%d downloads to index 2 photos", n)
	}
	id := int64(it["id"].(float64))

	// thumbnail (Nextcloud preview, normalised and cached), preview, original
	w = request(s, "GET", fmt.Sprintf("/api/v1/clouds/items/%d/thumb", id), nil, ana)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatal("thumb", w.Code, w.Body.String())
	}
	if img, err := jpeg.Decode(bytes.NewReader(w.Body.Bytes())); err != nil || img.Bounds().Dx() != 400 {
		t.Fatalf("thumb size %v %v", err, img)
	}
	if w = request(s, "GET", fmt.Sprintf("/api/v1/clouds/items/%d/preview", id), nil, ana); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), photo) {
		t.Fatal("preview of a web-safe JPEG is the original", w.Code)
	}
	if w = request(s, "GET", fmt.Sprintf("/api/v1/clouds/items/%d/original", id), nil, ana); w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("original", w.Code)
	}

	// map points
	w = request(s, "GET", "/api/v1/clouds/map", nil, ana)
	var pts []map[string]any
	json.Unmarshal(w.Body.Bytes(), &pts)
	if len(pts) != 2 || pts[0]["lat"].(float64) != 44.5 || pts[0]["city"] != "Sarajevo" {
		t.Fatal(w.Body.String())
	}

	// import: the original goes to Immich; a second time Immich reports the duplicate
	w = request(s, "POST", fmt.Sprintf("/api/v1/clouds/items/%d/import", id), nil, ana)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"imported"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(s, "POST", fmt.Sprintf("/api/v1/clouds/items/%d/import", id), nil, ana); !strings.Contains(w.Body.String(), `"duplicate"`) {
		t.Fatal(w.Body.String())
	}
	if w = request(s, "GET", "/api/v1/clouds/items?filter=new", nil, ana); !strings.Contains(w.Body.String(), `"total":1`) {
		t.Fatal("filter new", w.Body.String())
	}

	// Bob sees none of it: lists are empty, ids are not found, nothing can be changed or imported.
	if w = request(s, "GET", "/api/v1/clouds", nil, bob); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal("Bob sees Ana's clouds", w.Body.String())
	}
	if w = request(s, "GET", "/api/v1/clouds/items", nil, bob); !strings.Contains(w.Body.String(), `"total":0`) {
		t.Fatal(w.Body.String())
	}
	if w = request(s, "GET", "/api/v1/clouds/map", nil, bob); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body.String())
	}
	for _, c := range []struct{ m, p string }{
		{"GET", fmt.Sprintf("/api/v1/clouds/items?account=%d", created.ID)},
		{"GET", fmt.Sprintf("/api/v1/clouds/items/%d", id)},
		{"GET", fmt.Sprintf("/api/v1/clouds/items/%d/thumb", id)},
		{"GET", fmt.Sprintf("/api/v1/clouds/items/%d/original", id)},
		{"POST", fmt.Sprintf("/api/v1/clouds/items/%d/import", id)},
		{"PUT", fmt.Sprintf("/api/v1/clouds/%d", created.ID)},
		{"POST", fmt.Sprintf("/api/v1/clouds/%d/scan", created.ID)},
		{"DELETE", fmt.Sprintf("/api/v1/clouds/%d", created.ID)},
	} {
		var body any
		if c.m == "PUT" {
			body = map[string]string{"name": "mine now"}
		}
		if w = request(s, c.m, c.p, body, bob); w.Code != 404 {
			t.Errorf("Bob %s %s: %d", c.m, c.p, w.Code)
		}
	}
	if w = request(s, "GET", "/api/v1/clouds", nil, ana); !strings.Contains(w.Body.String(), `"Home cloud"`) {
		t.Fatal("Bob changed Ana's account", w.Body.String())
	}

	// removing the account forgets the index; the cloud is untouched
	if w = request(s, "DELETE", fmt.Sprintf("/api/v1/clouds/%d", created.ID), nil, ana); w.Code != 200 {
		t.Fatal(w.Code)
	}
	var n int
	s.store.DB.QueryRow(`SELECT COUNT(*) FROM cloud_items`).Scan(&n)
	if n != 0 {
		t.Fatal("items left behind", n)
	}
}

func TestDropboxSignInIndexesAndRefreshesTheToken(t *testing.T) {
	photo := cloudtest.JPEG(640, 480, 1)
	var refreshes atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth2/token":
			r.ParseForm()
			if r.Form.Get("client_id") != "app-key" || r.Form.Get("client_secret") != "app-secret" {
				t.Error("token request without the app credentials")
			}
			switch r.Form.Get("grant_type") {
			case "authorization_code":
				if r.Form.Get("code") != "the-code" {
					t.Error("code", r.Form.Get("code"))
				}
				writeJSON(w, 200, map[string]any{"access_token": "stale", "refresh_token": "refresh-1", "expires_in": 14400})
			case "refresh_token":
				refreshes.Add(1)
				writeJSON(w, 200, map[string]any{"access_token": "fresh", "expires_in": 14400})
			}
			return
		}
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(401) // the first token is "expired" on the server side
			return
		}
		switch r.URL.Path {
		case "/2/users/get_current_account":
			writeJSON(w, 200, map[string]string{"email": "ana@dropbox.example"})
		case "/2/files/list_folder":
			writeJSON(w, 200, map[string]any{"cursor": "c1", "has_more": false, "entries": []map[string]any{
				{".tag": "folder", "name": "Camera Uploads", "path_lower": "/camera uploads", "path_display": "/Camera Uploads"},
				{".tag": "file", "id": "id:abc", "name": "2026-09-07 14.03.22.jpg", "path_lower": "/camera uploads/2026-09-07 14.03.22.jpg",
					"path_display": "/Camera Uploads/2026-09-07 14.03.22.jpg", "size": len(photo), "server_modified": "2026-09-08T10:00:00Z", "content_hash": "h1"},
				{".tag": "file", "id": "id:pdf", "name": "invoice.pdf", "path_lower": "/invoice.pdf", "path_display": "/invoice.pdf", "size": 10},
			}})
		case "/2/files/download":
			if !strings.Contains(r.Header.Get("Dropbox-API-Arg"), "id:abc") {
				t.Error("download arg", r.Header.Get("Dropbox-API-Arg"))
			}
			http.ServeContent(w, r, "p.jpg", time.Time{}, bytes.NewReader(photo))
		default:
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	old := cloud.Endpoints
	defer func() { cloud.Endpoints = old }()
	cloud.Endpoints.DropboxAuth, cloud.Endpoints.DropboxToken = api.URL+"/oauth2/authorize", api.URL+"/oauth2/token"
	cloud.Endpoints.DropboxAPI, cloud.Endpoints.DropboxContent = api.URL+"/2", api.URL+"/2"

	s := testServer(t, "")
	s.cfg.BaseURL = "https://photos.example.com"
	ana := account(t, s, "ana@example.com")

	// not configured yet: the providers list says so and explains the redirect URI
	w := request(s, "GET", "/api/v1/clouds/providers", nil, ana)
	if !strings.Contains(w.Body.String(), "https://photos.example.com/api/v1/clouds/oauth/dropbox/callback") {
		t.Fatal(w.Body.String())
	}
	s.cfg.DropboxAppKey, s.cfg.DropboxAppSecret = "app-key", "app-secret"

	w = request(s, "GET", "/api/v1/clouds/oauth/dropbox/start?json=1", nil, ana)
	var start struct{ URL string }
	json.Unmarshal(w.Body.Bytes(), &start)
	u, _ := url.Parse(start.URL)
	if u.Query().Get("client_id") != "app-key" || u.Query().Get("token_access_type") != "offline" || !strings.Contains(u.Query().Get("scope"), "files.content.read") {
		t.Fatal(start.URL)
	}
	state := u.Query().Get("state")
	var stateCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == cloudOAuthCookie {
			stateCookie = c
		}
	}
	// a forged state is refused
	r := httptest.NewRequest("GET", "/api/v1/clouds/oauth/dropbox/callback?code=the-code&state=forged", nil)
	r.AddCookie(ana)
	r.AddCookie(stateCookie)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, r)
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "error=") {
		t.Fatal("forged state accepted", loc)
	}
	r = httptest.NewRequest("GET", "/api/v1/clouds/oauth/dropbox/callback?code=the-code&state="+state, nil)
	r.AddCookie(ana)
	r.AddCookie(stateCookie)
	rec = httptest.NewRecorder()
	s.Router().ServeHTTP(rec, r)
	if loc := rec.Header().Get("Location"); rec.Code != 302 || !strings.Contains(loc, "/settings?") || strings.Contains(loc, "error=") || !strings.Contains(loc, "cloud=") {
		t.Fatal(rec.Code, loc)
	}
	list := waitIdle(t, s, ana)
	if list[0]["login"] != "ana@dropbox.example" || list[0]["status"] != "idle" || list[0]["counts"].(map[string]any)["located"].(float64) != 1 {
		t.Fatalf("%v", list[0])
	}
	if refreshes.Load() == 0 {
		t.Fatal("the expired token was not refreshed")
	}
	var sealed string
	s.store.DB.QueryRow(`SELECT secret FROM cloud_accounts`).Scan(&sealed)
	plain, _ := s.open(sealed)
	if !strings.Contains(plain, `"fresh"`) || !strings.Contains(plain, "refresh-1") || strings.Contains(sealed, "refresh-1") {
		t.Fatal("refreshed token not stored sealed")
	}
}

// With Pocket Core linking a person's Nextcloud, the account shows up in Photos by itself (like
// Pocket Files and Documents do), scans, and stays gone once the person removes it.
func TestCoreLinkedNextcloudAppearsByItself(t *testing.T) {
	photo := cloudtest.JPEG(800, 600, 1)
	var gets atomic.Int64
	nc := fakeNextcloud(t, photo, &gets)
	defer nc.Close()
	var asked atomic.Int64
	coreSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/services/credential" {
			w.WriteHeader(404)
			return
		}
		asked.Add(1)
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b["type"] != "nextcloud" || b["user"] != "ana@example.com" {
			w.WriteHeader(403)
			writeJSON(w, 403, map[string]string{"error": "no Nextcloud for this person", "reason": "no_account"})
			return
		}
		writeJSON(w, 200, map[string]any{"type": "nextcloud", "url": nc.URL, "fields": map[string]string{"USERNAME": "ana", "APP_PASSWORD": "app-password"}})
	}))
	defer coreSrv.Close()
	s := testServer(t, "")
	s.core = core.New(coreSrv.URL, core.Options{TokenFile: filepath.Join(t.TempDir(), "core.token")})
	ana := account(t, s, "ana@example.com")
	bob := account(t, s, "bob@example.com")

	list := waitIdle(t, s, ana)
	if len(list) != 1 || list[0]["kind"] != "nextcloud" || list[0]["via"] != "core" || list[0]["login"] != "ana" || list[0]["root"] != "" {
		t.Fatalf("%v", list)
	}
	if c := list[0]["counts"].(map[string]any); c["items"].(float64) != 2 {
		t.Fatalf("whole Nextcloud indexed: %v", c)
	}
	// Bob has no Nextcloud in Core: nothing appears for him.
	if w := request(s, "GET", "/api/v1/clouds", nil, bob); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body.String())
	}
	// Removed is remembered: listing again does not bring it back.
	id := int64(list[0]["id"].(float64))
	if w := request(s, "DELETE", fmt.Sprintf("/api/v1/clouds/%d", id), nil, ana); w.Code != 200 {
		t.Fatal(w.Code)
	}
	s.adoptMu.Lock()
	s.adoptTried = nil // as if ten minutes passed
	s.adoptMu.Unlock()
	if w := request(s, "GET", "/api/v1/clouds", nil, ana); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal("removed Nextcloud came back", w.Body.String())
	}
	// …until the person adds it again.
	if w := request(s, "POST", "/api/v1/clouds", map[string]any{"kind": "nextcloud", "via": "core"}, ana); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestIndexingSkipsIconsAndAppFolders(t *testing.T) {
	for _, c := range []struct {
		path string
		size int64
		want bool
	}{
		{"Photos/2026/IMG_0001.HEIC", 2 << 20, true},
		{"Photos/clip.mov", 10 << 10, true}, // videos are kept whatever their size
		{"Games/sprites/coin.png", 4 << 10, false},
		{"Programming/app/node_modules/pkg/logo.jpg", 300 << 10, false},
		{"Photos/@eaDir/IMG_0001.jpg/SYNOPHOTO_THUMB_XL.jpg", 200 << 10, false},
		{"Scans/receipt.jpg", 0, true}, // size unknown: kept
	} {
		e := cloud.Entry{Path: c.path, Name: c.path[strings.LastIndex(c.path, "/")+1:], Size: c.size}
		if got := worthIndexing(e); got != c.want {
			t.Errorf("%s (%d bytes): %v, want %v", c.path, c.size, got, c.want)
		}
	}
}
