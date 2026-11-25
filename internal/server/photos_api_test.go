package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPhotosSearchAndGet(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789abc"
	var bodies []map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/users/me":
			writeJSON(w, 200, map[string]string{"id": "a"})
		case "/api/search/metadata", "/api/search/smart":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["path"] = r.URL.Path
			bodies = append(bodies, b)
			writeJSON(w, 200, map[string]any{"assets": map[string]any{"items": []any{
				map[string]any{"id": id, "type": "IMAGE", "originalFileName": "IMG_1.JPG", "localDateTime": "2026-10-25T13:44:13.000Z", "exifInfo": map[string]any{"city": "Mostar", "country": "Bosnia and Herzegovina"}},
			}}})
		case "/api/assets/" + id:
			writeJSON(w, 200, map[string]any{"id": id, "type": "IMAGE", "originalFileName": "IMG_1.JPG", "exifInfo": map[string]any{"make": "Apple", "model": "iPhone 17 Pro"}, "people": []any{map[string]any{"name": "Ana"}, map[string]any{"name": ""}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()
	s := testServer(t, up.URL)
	s.cfg.BaseURL = "https://photos.test/"
	cookie := account(t, s, "a@example.com")
	request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "immich-key"}, cookie)

	w := request(s, "GET", "/api/v1/photos?limit=5", nil, cookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"item_url":"https://photos.test/?photo=`+id) || !strings.Contains(w.Body.String(), `"place":"Mostar, Bosnia and Herzegovina"`) || !strings.Contains(w.Body.String(), `"title":"IMG_1.JPG"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(s, "GET", "/api/v1/photos?q=beach&favorites=1", nil, cookie); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if len(bodies) != 2 || bodies[0]["path"] != "/api/search/metadata" || bodies[0]["size"] != float64(5) || bodies[1]["path"] != "/api/search/smart" || bodies[1]["query"] != "beach" {
		t.Fatalf("searches = %v", bodies)
	}
	if f := bodies[1]["filter"].(map[string]any); f["isFavorite"] == nil {
		t.Fatalf("favorites filter missing: %v", f)
	}
	w = request(s, "GET", "/api/v1/photos/"+id, nil, cookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"camera":"Apple iPhone 17 Pro"`) || !strings.Contains(w.Body.String(), `"people":["Ana"]`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(s, "GET", "/api/v1/photos/nope", nil, cookie); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w = request(s, "GET", "/api/v1/photos", nil, nil); w.Code != 401 {
		t.Fatal("no sign-in →", w.Code)
	}
}
