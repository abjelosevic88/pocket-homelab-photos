package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

func TestCloudTimelineFiltersPrivacyAndDatePagination(t *testing.T) {
	s := testServer(t, "http://127.0.0.1:1")
	ana, bob := account(t, s, "timeline-ana@example.com"), account(t, s, "timeline-bob@example.com")
	var anaID, bobID int64
	s.store.DB.QueryRow("SELECT id FROM users WHERE email=?", "timeline-ana@example.com").Scan(&anaID)
	s.store.DB.QueryRow("SELECT id FROM users WHERE email=?", "timeline-bob@example.com").Scan(&bobID)
	ctx := context.Background()
	makeAccount := func(user int64) *store.CloudAccount {
		a := &store.CloudAccount{UserID: user, Kind: "webdav", Name: "Cloud", Config: "{}"}
		if err := s.store.CreateCloudAccount(ctx, a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	a, other, private := makeAccount(anaID), makeAccount(anaID), makeAccount(bobID)
	add := func(account int64, date string, video, imported, located bool) {
		i := &store.CloudItem{AccountID: account, RemoteID: fmt.Sprint(account, date, video, imported, located), Path: "Trips/holiday.mp4", Name: "holiday.mp4", TakenAt: date, Video: video, Indexed: true}
		if imported {
			i.ImportStatus = "imported"
		}
		if located {
			v := 1.0
			i.Lat = &v
			i.Lon = &v
		}
		if _, err := s.store.UpsertCloudItem(ctx, i, 1); err != nil {
			t.Fatal(err)
		}
		// Imports are normally applied after the scan.
		if imported {
			if err := s.store.SetCloudImport(ctx, i.ID, "imported", "asset"); err != nil {
				t.Fatal(err)
			}
		}
	}
	add(a.ID, "2026-03-01T00:00:00Z", false, false, false)
	add(a.ID, "2026-02-28T23:30:00-05:00", true, true, true)
	add(a.ID, "2025-12-31T20:00:00Z", true, false, false)
	add(a.ID, "", false, false, false)
	// More than one UI page in the same month.
	for n := 0; n < 125; n++ {
		add(a.ID, fmt.Sprintf("2025-01-02T01:%02d:%02dZ", n/60, n%60), false, false, false)
	}
	add(other.ID, "2024-01-01T00:00:00Z", true, false, false)
	add(private.ID, "2023-01-01T00:00:00Z", true, false, false)
	read := func(query string) []store.CloudBucket {
		t.Helper()
		w := request(s, "GET", fmt.Sprintf("/api/v1/clouds/timeline?account=%d%s", a.ID, query), nil, ana)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var b []store.CloudBucket
		if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	buckets := read("")
	if len(buckets) != 4 || buckets[0].TimeBucket != "2026-03" || buckets[1].TimeBucket != "2026-02" || buckets[3].Count != 125 {
		t.Fatal(buckets)
	}
	for _, query := range []string{"&type=video&filter=imported", "&filter=located", "&type=video&q=holiday&filter=imported"} {
		b := read(query)
		if len(b) != 1 || b[0].TimeBucket != "2026-02" || b[0].Count != 1 {
			t.Fatal(query, b)
		}
	}
	if b := read("&q=missing"); len(b) != 0 {
		t.Fatal(b)
	}
	for _, cookie := range []*http.Cookie{bob, nil} {
		w := request(s, "GET", fmt.Sprintf("/api/v1/clouds/timeline?account=%d", a.ID), nil, cookie)
		if w.Code != 404 && w.Code != 401 {
			t.Fatal("private dates exposed", w.Code)
		}
	}
	for _, date := range []string{"2026-13", "2026-02-01", "bad", "0000", "9999"} {
		w := request(s, "GET", "/api/v1/clouds/items?date="+date, nil, ana)
		if w.Code != 400 {
			t.Fatal("invalid date accepted", date, w.Code)
		}
	}
	var page struct {
		Items []store.CloudItem `json:"items"`
		Next  string            `json:"next_cursor"`
		Total int               `json:"total"`
	}
	url := fmt.Sprintf("/api/v1/clouds/items?account=%d&date=2026-02&limit=1", a.ID)
	w := request(s, "GET", url, nil, ana)
	json.Unmarshal(w.Body.Bytes(), &page)
	if w.Code != 200 || len(page.Items) != 1 || page.Items[0].TakenAt != "2026-02-28T23:30:00-05:00" || page.Next == "" || page.Total != 128 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(s, "GET", url+"&cursor="+page.Next, nil, ana)
	json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Items) != 1 || page.Items[0].TakenAt != "2025-12-31T20:00:00Z" {
		t.Fatal(w.Body.String())
	}
	w = request(s, "GET", fmt.Sprintf("/api/v1/clouds/items?account=%d&date=2025&limit=1", a.ID), nil, ana)
	json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Items) != 1 || page.Items[0].TakenAt != "2025-12-31T20:00:00Z" {
		t.Fatal(w.Body.String())
	}
}
