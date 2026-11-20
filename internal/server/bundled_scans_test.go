package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// The catch-up signs in as the bundled administrator and asks for each missing scan without force.
func TestCatchUpScans(t *testing.T) {
	var mu sync.Mutex
	started := map[string]map[string]any{}
	im := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/auth/login":
			writeJSON(w, 201, map[string]string{"accessToken": "tok"})
		case r.Method == "PUT" && len(r.URL.Path) > len("/api/jobs/") && r.URL.Path[:len("/api/jobs/")] == "/api/jobs/":
			if r.Header.Get("Authorization") != "Bearer tok" {
				w.WriteHeader(401)
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			started[r.URL.Path[len("/api/jobs/"):]] = body
			mu.Unlock()
			writeJSON(w, 200, map[string]any{})
		default:
			w.WriteHeader(404)
		}
	}))
	defer im.Close()
	s := testServer(t, im.URL)
	ctx := context.Background()
	s.catchUpScans(ctx) // no administrator yet: nothing to do
	if len(started) != 0 {
		t.Fatalf("started without an administrator: %v", started)
	}
	if err := s.sealKV(ctx, kvBundledAdmin, "pw"); err != nil {
		t.Fatal(err)
	}
	s.catchUpScans(ctx)
	for _, q := range catchUpQueues {
		b, ok := started[q]
		if !ok {
			t.Fatalf("%s not started: %v", q, started)
		}
		if b["command"] != "start" || b["force"] != false {
			t.Fatalf("%s body = %v, want start without force", q, b)
		}
	}
}
