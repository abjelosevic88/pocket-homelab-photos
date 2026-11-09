package server

import (
	"net/http/httptest"
	"testing"
)

func TestLinkScopes(t *testing.T) {
	id := "/api/v1/immich/assets/0b1c2d3e-0000-4000-8000-000000000001"
	cases := []struct {
		method, path string
		scopes       []string
		want         bool
	}{
		{"GET", "/api/v1/auth/me", nil, true},
		{"POST", "/api/v1/immich/search/metadata", []string{"photos:read"}, true},
		{"GET", id + "/thumbnail", []string{"photos:read"}, true},
		{"GET", id + "/original", []string{"photos:read"}, true},
		{"GET", id + "/original", []string{"photos:write"}, false},
		{"POST", "/api/v1/immich/assets", []string{"photos:write"}, true},
		{"POST", "/api/v1/immich/assets", []string{"photos:read"}, false},
		{"PUT", id, []string{"photos:read", "photos:write"}, false},
		{"DELETE", "/api/v1/immich/assets", []string{"photos:read", "photos:write"}, false},
		{"GET", "/api/v1/connection", []string{"photos:read"}, false},
		{"GET", "/api/v1/tokens", []string{"photos:read", "photos:write"}, false},
	}
	for _, c := range cases {
		if got := linkAllows(c.scopes, httptest.NewRequest(c.method, c.path, nil)); got != c.want {
			t.Errorf("%s %s %v = %v, want %v", c.method, c.path, c.scopes, got, c.want)
		}
	}
}
