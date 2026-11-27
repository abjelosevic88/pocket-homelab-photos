package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
)

// fakeLibraries is an Immich with one library per API key: smart search
// answers with all of its photos, a day's search with those taken in the
// window (a page at a time), /memories with its "on this day" memories, and
// /assets/{id} only with a photo of that library.
type fakeLibraries struct {
	*httptest.Server
	mu       sync.Mutex
	assets   map[string][]map[string]any
	memories map[string][]map[string]any
	places   map[string]string // asset id → the city only the photo's own page knows
	calls    []fakeCall
	down     bool
}

type fakeCall struct {
	key, path, query string
	body             map[string]any
}

// asset is a photo as Immich lists it. taken is the moment (UTC), local the
// clock where it was taken; city "" = no place known.
func asset(n int, typ, file, taken, local, city, country string) map[string]any {
	a := map[string]any{"id": fmt.Sprintf("aaaaaaaa-0000-4000-8000-%012d", n), "type": typ, "originalFileName": file, "fileCreatedAt": taken, "localDateTime": local}
	if city != "" {
		a["exifInfo"] = map[string]any{"city": city, "country": country}
	}
	return a
}

func id(a map[string]any) string { return a["id"].(string) }

func newLibraries(t *testing.T) *fakeLibraries {
	t.Helper()
	f := &fakeLibraries{assets: map[string][]map[string]any{}, memories: map[string][]map[string]any{}, places: map[string]string{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		key := r.Header.Get("x-api-key")
		if r.URL.Path == "/api/users/me" {
			writeJSON(w, 200, map[string]string{"id": key})
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.calls = append(f.calls, fakeCall{key, r.URL.Path, r.URL.RawQuery, body})
		if f.down {
			writeErr(w, 500, "database is gone")
			return
		}
		size := 0
		if n, ok := body["size"].(float64); ok {
			size = int(n)
		}
		switch {
		case r.URL.Path == "/api/search/smart":
			items := f.assets[key]
			if size < len(items) {
				items = items[:size]
			}
			writeJSON(w, 200, map[string]any{"assets": map[string]any{"items": items, "nextCursor": nil}})
		case r.URL.Path == "/api/search/metadata":
			taken, _ := body["filter"].(map[string]any)["takenAt"].(map[string]any)
			from, _ := time.Parse(time.RFC3339, fmt.Sprint(taken["gte"]))
			to, _ := time.Parse(time.RFC3339, fmt.Sprint(taken["lt"]))
			in := []map[string]any{}
			for _, a := range f.assets[key] {
				if at, _ := time.Parse(time.RFC3339, a["fileCreatedAt"].(string)); !at.Before(from) && at.Before(to) {
					in = append(in, a)
				}
			}
			sort.SliceStable(in, func(a, b int) bool { return in[a]["fileCreatedAt"].(string) < in[b]["fileCreatedAt"].(string) })
			skip, _ := strconv.Atoi(fmt.Sprint(body["cursor"]))
			var next any
			if in = in[min(skip, len(in)):]; len(in) > size {
				in, next = in[:size], strconv.Itoa(skip+size)
			}
			writeJSON(w, 200, map[string]any{"assets": map[string]any{"items": in, "nextCursor": next}})
		case r.URL.Path == "/api/memories":
			list := f.memories[key]
			if list == nil {
				list = []map[string]any{}
			}
			writeJSON(w, 200, list)
		case strings.HasPrefix(r.URL.Path, "/api/assets/"):
			for _, list := range append([][]map[string]any{f.assets[key]}, memoryAssets(f.memories[key])...) {
				for _, a := range list {
					if "/api/assets/"+id(a) == r.URL.Path {
						writeJSON(w, 200, map[string]any{"id": id(a), "type": a["type"], "exifInfo": map[string]any{"city": f.places[id(a)]}})
						return
					}
				}
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func memoryAssets(memories []map[string]any) [][]map[string]any {
	out := [][]map[string]any{}
	for _, m := range memories {
		out = append(out, m["assets"].([]map[string]any))
	}
	return out
}

// asked are the calls Immich got on a path since the last look, forgotten once read.
func (f *fakeLibraries) asked(path string) []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out, rest := []fakeCall{}, []fakeCall{}
	for _, c := range f.calls {
		if strings.HasPrefix(c.path, path) {
			out = append(out, c)
		} else {
			rest = append(rest, c)
		}
	}
	f.calls = rest
	return out
}

// seed gives Alice a small library and Bob one photo of his own.
func (f *fakeLibraries) seed() (mostar, clip, ana, vienna map[string]any) {
	mostar = asset(1, "IMAGE", "IMG_1.JPG", "2026-10-25T12:44:13.000Z", "2026-10-25T13:44:13.000Z", "Mostar", "Bosnia and Herzegovina")
	mostar["exifInfo"].(map[string]any)["make"], mostar["exifInfo"].(map[string]any)["model"] = "Apple", "iPhone 17 Pro"
	mostar["exifInfo"].(map[string]any)["description"] = "Old bridge at dusk"
	mostar["people"] = []any{map[string]any{"name": "Ana"}, map[string]any{"name": ""}}
	clip = asset(2, "VIDEO", "VID_2.MOV", "2026-10-26T08:05:00.000Z", "2026-10-26T09:05:00.000Z", "", "")
	ana = asset(3, "IMAGE", "IMG_3.JPG", "2026-10-27T10:00:00.000Z", "2026-10-27T11:00:00.000Z", "", "")
	ana["people"] = []any{map[string]any{"name": "Ana"}, map[string]any{"name": "Marko"}}
	vienna = asset(9, "IMAGE", "DSC_9.JPG", "2026-10-25T12:00:00.000Z", "2026-10-25T13:00:00.000Z", "Vienna", "Austria")
	f.assets["key-alice"] = []map[string]any{mostar, clip, ana}
	f.assets["key-bob"] = []map[string]any{vienna}
	return
}

// capPeople signs in Alice and Bob, each connected to their own Immich
// library, and Carol, who has none.
func capPeople(t *testing.T, s *Server) (alice, bob, carol *http.Cookie) {
	t.Helper()
	alice, bob, carol = account(t, s, "alice@example.com"), account(t, s, "bob@example.com"), account(t, s, "carol@example.com")
	for key, who := range map[string]*http.Cookie{"key-alice": alice, "key-bob": bob} {
		if w := request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": key}, who); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	return
}

// answer makes a request (signed in with a cookie, or acting with a token)
// and reads the JSON that comes back.
func answer(t *testing.T, s *Server, who any, method, path string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	switch v := who.(type) {
	case *http.Cookie:
		r.AddCookie(v)
	case string:
		r.Header.Set("Authorization", "Bearer "+v)
	}
	w := httptest.NewRecorder()
	s.Router().ServeHTTP(w, r)
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return w.Code, m
}

func okAnswer(t *testing.T, s *Server, who any, path string) map[string]any {
	t.Helper()
	code, m := answer(t, s, who, "GET", path)
	if code != 200 {
		t.Fatalf("GET %s → %d %v", path, code, m)
	}
	return m
}

// rows are the items of a capability answer.
func rows(t *testing.T, m map[string]any) []map[string]any {
	t.Helper()
	l, ok := m["items"].([]any)
	if !ok {
		t.Fatalf("no items list in %v", m)
	}
	out := []map[string]any{}
	for _, v := range l {
		out = append(out, v.(map[string]any))
	}
	return out
}

func TestPocketSearch(t *testing.T) {
	f := newLibraries(t)
	mostar, clip, ana, vienna := f.seed()
	s := testServer(t, f.URL)
	s.cfg.BaseURL = "https://photos.test"
	alice, bob, carol := capPeople(t, s)

	got := rows(t, okAnswer(t, s, alice, "/api/v1/pocket/search?q=old+bridge"))
	if len(got) != 3 {
		t.Fatalf("alice: %v", got)
	}
	// the day and the place lead; the rest says when, what, who, where and with what
	if it := got[0]; it["id"] != id(mostar) || it["kind"] != "photo" || it["title"] != "25 Oct 2026 · Mostar" || it["url"] != "/?photo="+id(mostar) ||
		it["date"] != "2026-10-25T12:44:13Z" || it["snippet"] != "13:44 · Old bridge at dusk · Ana · Bosnia and Herzegovina · Apple iPhone 17 Pro" {
		t.Fatalf("a photo with everything known: %v", it)
	}
	// nothing known but the file: its name, after the day
	if it := got[1]; it["id"] != id(clip) || it["kind"] != "video" || it["title"] != "26 Oct 2026 · VID_2.MOV" || it["snippet"] != "09:05" || it["url"] != "/?photo="+id(clip) {
		t.Fatalf("a video: %v", it)
	}
	if it := got[2]; it["id"] != id(ana) || it["title"] != "27 Oct 2026 · Ana and Marko" || it["snippet"] != "11:00" {
		t.Fatalf("a photo known by its people: %v", it)
	}
	// Immich was asked as Alice, for her words, photos and videos alike
	asked := f.asked("/api/search/")
	if len(asked) != 1 || asked[0].key != "key-alice" || asked[0].path != "/api/search/smart" || asked[0].body["query"] != "old bridge" || asked[0].body["size"] != float64(8) {
		t.Fatalf("asked: %+v", asked)
	}
	if flt := asked[0].body["filter"].(map[string]any); flt["trashedAt"] == nil || flt["type"] != nil {
		t.Fatalf("filter: %v", flt)
	}
	if got := rows(t, okAnswer(t, s, alice, "/api/v1/pocket/search?q=bridge&limit=1")); len(got) != 1 || f.asked("/api/search/")[0].body["size"] != float64(1) {
		t.Fatalf("limit 1: %v", got)
	}
	if got := rows(t, okAnswer(t, s, alice, "/api/v1/pocket/search?q=")); len(got) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("no words: %v", got)
	}
	// Bob finds only his own photos, with his own key
	got = rows(t, okAnswer(t, s, bob, "/api/v1/pocket/search?q=old+bridge"))
	if asked = f.asked("/api/search/"); len(got) != 1 || got[0]["id"] != id(vienna) || got[0]["title"] != "25 Oct 2026 · Vienna" || got[0]["snippet"] != "13:00 · Austria" || len(asked) != 1 || asked[0].key != "key-bob" {
		t.Fatalf("bob: %v %+v", got, asked)
	}
	// no library yet: nothing found, nobody's Immich asked
	if got := rows(t, okAnswer(t, s, carol, "/api/v1/pocket/search?q=bridge")); len(got) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("carol: %v", got)
	}
	if code, _ := answer(t, s, nil, "GET", "/api/v1/pocket/search?q=bridge"); code != 401 {
		t.Fatal("no sign-in →", code)
	}
	// the search Pocket Core's tools use answers as before
	old := okAnswer(t, s, alice, "/api/v1/photos?q=bridge")
	if it := rows(t, old)[0]; it["title"] != "IMG_1.JPG" || it["item_url"] != "https://photos.test/?photo="+id(mostar) || it["place"] != "Mostar, Bosnia and Herzegovina" || it["kind"] != "image" {
		t.Fatalf("/photos changed: %v", it)
	}
	if b := f.asked("/api/search/")[0].body; b["filter"].(map[string]any)["type"] == nil || b["size"] != float64(30) {
		t.Fatalf("/photos asks differently: %v", b)
	}
	// an Immich that fails is an error, without its words
	f.down = true
	if code, m := answer(t, s, alice, "GET", "/api/v1/pocket/search?q=bridge"); code != 500 || m["error"] != "the app could not answer" {
		t.Fatal("Immich down →", code, m)
	}
}

func TestPocketDay(t *testing.T) {
	f := newLibraries(t)
	_, _, _, vienna := f.seed()
	// around 12 November in Sarajevo (an hour ahead of UTC)
	night := asset(11, "IMAGE", "IMG_11.JPG", "2026-11-11T23:30:00.000Z", "2026-11-12T00:30:00.000Z", "Sarajevo", "Bosnia and Herzegovina")
	night["exifInfo"].(map[string]any)["model"] = "Pixel 10"
	night["exifInfo"].(map[string]any)["description"] = "First snow"
	night["people"] = []any{map[string]any{"name": "Ana"}, map[string]any{"name": "Marko"}, map[string]any{"name": "Lena"}}
	noon := asset(12, "IMAGE", "IMG_12.JPG", "2026-11-12T10:15:00.000Z", "2026-11-12T11:15:00.000Z", "", "")
	film := asset(13, "VIDEO", "VID_13.MOV", "2026-11-12T18:00:00.000Z", "2026-11-12T19:00:00.000Z", "", "")
	late := asset(14, "IMAGE", "IMG_14.JPG", "2026-11-12T23:30:00.000Z", "2026-11-13T00:30:00.000Z", "", "")
	f.assets["key-alice"] = append(f.assets["key-alice"], night, noon, film, late)
	s := testServer(t, f.URL)
	alice, bob, carol := capPeople(t, s)

	day := okAnswer(t, s, alice, "/api/v1/pocket/day/2026-11-12?tz=Europe/Sarajevo")
	got := rows(t, day)
	if day["date"] != "2026-11-12" || day["summary"] != "2 photos, 1 video" || len(got) != 3 || fmt.Sprint(day["metrics"]) != "[map[label:Photos value:2] map[label:Videos value:1]]" {
		t.Fatalf("day: %v", day)
	}
	if it := got[0]; it["id"] != id(night) || it["time"] != "00:30" || it["title"] != "Sarajevo" || it["sub"] != "Ana, Marko and Lena · Pixel 10" || it["note"] != "First snow" || it["kind"] != "photo" ||
		it["url"] != "/?photo="+id(night) || it["image"] != "/api/v1/immich/assets/"+id(night)+"/thumbnail?size=thumbnail" {
		t.Fatalf("just after midnight: %v", it)
	}
	if it := got[1]; it["id"] != id(noon) || it["time"] != "11:15" || it["title"] != "IMG_12.JPG" || it["sub"] != nil {
		t.Fatalf("a photo known only by its file: %v", it)
	}
	if it := got[2]; it["id"] != id(film) || it["time"] != "19:00" || it["kind"] != "video" {
		t.Fatalf("the video: %v", it)
	}
	// Immich was asked as Alice for that day's two midnights, the oldest first
	asked := f.asked("/api/search/")
	if len(asked) != 1 || asked[0].key != "key-alice" || asked[0].path != "/api/search/metadata" {
		t.Fatalf("asked: %+v", asked)
	}
	flt := asked[0].body["filter"].(map[string]any)
	if fmt.Sprint(flt["takenAt"]) != "map[gte:2026-11-11T23:00:00.000Z lt:2026-11-12T23:00:00.000Z]" || fmt.Sprint(flt["visibility"]) != "map[eq:timeline]" || flt["trashedAt"] == nil ||
		fmt.Sprint(asked[0].body["orderBy"]) != "map[direction:asc field:fileCreatedAt]" || asked[0].body["withExif"] != true {
		t.Fatalf("the day's search: %v", asked[0].body)
	}
	// without a time zone the box's own counts (UTC here): another three, an hour apart
	s.cfg.Timezone = "UTC"
	if got = rows(t, okAnswer(t, s, alice, "/api/v1/pocket/day/2026-11-12")); len(got) != 3 || got[0]["time"] != "10:15" || got[1]["time"] != "18:00" || got[2]["time"] != "23:30" || got[2]["id"] != id(late) {
		t.Fatalf("the box's day: %v", got)
	}
	// one of a kind, a day with nothing, and somebody else's day
	if d := okAnswer(t, s, alice, "/api/v1/pocket/day/2026-10-26"); d["summary"] != "1 video" || fmt.Sprint(d["metrics"]) != "[map[label:Videos value:1]]" {
		t.Fatalf("one video: %v", d)
	}
	if d := okAnswer(t, s, alice, "/api/v1/pocket/day/2019-03-04"); d["summary"] != nil || d["metrics"] != nil || len(rows(t, d)) != 0 {
		t.Fatalf("an empty day: %v", d)
	}
	f.asked("/api/")
	d := okAnswer(t, s, bob, "/api/v1/pocket/day/2026-11-12?tz=Europe/Sarajevo")
	if asked = f.asked("/api/search/"); d["summary"] != nil || len(rows(t, d)) != 0 || len(asked) != 1 || asked[0].key != "key-bob" {
		t.Fatalf("bob sees alice's day: %v %+v", d, asked)
	}
	if d = okAnswer(t, s, bob, "/api/v1/pocket/day/2026-10-25"); d["summary"] != "1 photo" || rows(t, d)[0]["id"] != id(vienna) || rows(t, d)[0]["title"] != "Vienna" {
		t.Fatalf("bob's own day: %v", d)
	}
	f.asked("/api/")
	if d = okAnswer(t, s, carol, "/api/v1/pocket/day/2026-11-12"); d["summary"] != nil || len(rows(t, d)) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("carol: %v", d)
	}
	if code, _ := answer(t, s, alice, "GET", "/api/v1/pocket/day/yesterday"); code != 400 {
		t.Fatal("not a date →", code)
	}
	if code, _ := answer(t, s, nil, "GET", "/api/v1/pocket/day/2026-11-12"); code != 401 {
		t.Fatal("no sign-in →", code)
	}
}

// A busy day is read a page at a time and counted whole; a few photos spread
// over it are shown. A day past counting says so instead of a wrong number.
func TestPocketDayBusy(t *testing.T) {
	f := newLibraries(t)
	at := time.Date(2026, 7, 4, 6, 0, 0, 0, time.UTC)
	for i := 0; i < 600; i++ {
		typ := "IMAGE"
		if i%100 == 99 {
			typ = "VIDEO"
		}
		stamp := at.Add(time.Duration(i) * time.Minute).Format(immichTime)
		f.assets["key-alice"] = append(f.assets["key-alice"], asset(1000+i, typ, fmt.Sprintf("IMG_%d.JPG", i), stamp, stamp, "", ""))
	}
	for i := 0; i < 2300; i++ {
		stamp := time.Date(2026, 7, 6, 0, 0, i, 0, time.UTC).Format(immichTime)
		f.assets["key-alice"] = append(f.assets["key-alice"], asset(5000+i, "IMAGE", "COPY.JPG", stamp, stamp, "", ""))
	}
	s := testServer(t, f.URL)
	s.cfg.Timezone = "UTC"
	alice, _, _ := capPeople(t, s)

	day := okAnswer(t, s, alice, "/api/v1/pocket/day/2026-07-04")
	got := rows(t, day)
	if day["summary"] != "594 photos, 6 videos" || len(got) != 12 || got[0]["time"] != "06:00" || got[0]["title"] != "IMG_0.JPG" || got[11]["title"] != "IMG_599.JPG" || got[11]["time"] != "15:59" {
		t.Fatalf("a busy day: %v %v", day["summary"], got)
	}
	asked := f.asked("/api/search/")
	if len(asked) != 3 || asked[0].body["cursor"] != nil || asked[1].body["cursor"] != "250" || asked[2].body["cursor"] != "500" {
		t.Fatalf("pages: %+v", asked)
	}
	day = okAnswer(t, s, alice, "/api/v1/pocket/day/2026-07-06")
	if day["summary"] != "More than 2,000 photos and videos" || day["metrics"] != nil || len(rows(t, day)) != 12 || len(f.asked("/api/search/")) != 8 {
		t.Fatalf("a day past counting: %v", day["summary"])
	}
	// thousands are written the way people read them
	for n, want := range map[int]string{7: "7", 999: "999", 1000: "1,000", 12345: "12,345", 1234567: "1,234,567"} {
		if got := thousands(n); got != want {
			t.Errorf("%d = %q, want %q", n, got, want)
		}
	}
}

func TestPocketWidget(t *testing.T) {
	f := newLibraries(t)
	s := testServer(t, f.URL)
	alice, bob, carol := capPeople(t, s)
	today := time.Now().In(s.zone())
	year := today.Year()
	then := func(n, y int, typ string) map[string]any {
		stamp := time.Date(y, today.Month(), today.Day(), 9, 0, 0, 0, time.UTC).Format(immichTime)
		return map[string]any{"id": fmt.Sprintf("bbbbbbbb-0000-4000-8000-%012d", n), "type": typ, "originalFileName": "OLD.JPG", "fileCreatedAt": stamp, "localDateTime": stamp}
	}
	memory := func(y int, typ string, assets ...map[string]any) map[string]any {
		return map[string]any{"type": typ, "memoryAt": time.Date(y, today.Month(), today.Day(), 0, 0, 0, 0, time.UTC).Format(immichTime), "data": map[string]any{"year": y}, "assets": assets}
	}
	// nothing from earlier years: nothing to show
	if w := okAnswer(t, s, alice, "/api/v1/pocket/widget"); w["line"] != nil || w["url"] != nil || len(rows(t, w)) != 0 {
		t.Fatalf("no memories: %v", w)
	}
	last, deleted := then(1, year-1, "IMAGE"), then(4, year-1, "IMAGE")
	deleted["isTrashed"] = true
	rome := then(5, year-7, "IMAGE")
	rome["exifInfo"] = map[string]any{"city": "Rome", "country": "Italy"}
	f.places[id(last)] = "Split"
	f.memories["key-alice"] = []map[string]any{
		memory(year-7, "on_this_day", rome),
		memory(year-1, "on_this_day", last, then(2, year-1, "IMAGE"), then(3, year-1, "VIDEO"), deleted),
		memory(year-3, "birthday", then(6, year-3, "IMAGE")),
		memory(year, "on_this_day", then(7, year, "IMAGE")),
	}
	f.asked("/api/")
	// the empty answer is kept too: Alice still sees nothing for a while
	if w := okAnswer(t, s, alice, "/api/v1/pocket/widget"); len(rows(t, w)) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("kept: %v", w)
	}
	s.widgets.m = nil

	w := okAnswer(t, s, alice, "/api/v1/pocket/widget")
	got := rows(t, w)
	if w["line"] != fmt.Sprintf("On this day: %d, %d", year-7, year-1) || w["url"] != "/memories" || len(got) != 2 {
		t.Fatalf("widget: %v", w)
	}
	// the nearest year first; where it was comes from the photo's own page when the memory does not say
	if it := got[0]; it["id"] != id(last) || it["title"] != "1 year ago" || it["detail"] != fmt.Sprintf("%d · Split · 2 photos, 1 video", year-1) || it["url"] != "/?photo="+id(last) {
		t.Fatalf("last year: %v", it)
	}
	if it := got[1]; it["id"] != id(rome) || it["title"] != "7 years ago" || it["detail"] != fmt.Sprintf("%d · Rome · 1 photo", year-7) {
		t.Fatalf("seven years ago: %v", it)
	}
	asked := f.asked("/api/memories")
	if len(asked) != 1 || asked[0].key != "key-alice" || asked[0].query != "for="+today.Format("2006-01-02")+"&type=on_this_day" {
		t.Fatalf("asked: %+v", asked)
	}
	if asked = f.asked("/api/assets/"); len(asked) != 1 || asked[0].key != "key-alice" || asked[0].path != "/api/assets/"+id(last) {
		t.Fatalf("places asked: %+v", asked)
	}
	// kept for a while: Immich is not asked again
	if again := okAnswer(t, s, alice, "/api/v1/pocket/widget"); fmt.Sprint(again) != fmt.Sprint(w) || len(f.asked("/api/")) != 0 {
		t.Fatalf("not kept: %v", again)
	}
	// Bob has his own answer (nothing), asked with his own key, never Alice's
	bw := okAnswer(t, s, bob, "/api/v1/pocket/widget")
	if asked = f.asked("/api/"); bw["line"] != nil || len(rows(t, bw)) != 0 || len(asked) != 1 || asked[0].key != "key-bob" {
		t.Fatalf("bob: %v %+v", bw, asked)
	}
	if cw := okAnswer(t, s, carol, "/api/v1/pocket/widget"); cw["line"] != nil || len(rows(t, cw)) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("carol: %v", cw)
	}
	// Alice connects another library: what was kept from the old one is not shown
	f.memories["key-alice-2"] = []map[string]any{memory(year-2, "on_this_day", then(8, year-2, "VIDEO"))}
	for y := 3; y <= 9; y++ {
		f.memories["key-alice-2"] = append(f.memories["key-alice-2"], memory(year-y, "", then(10+y, year-y, "IMAGE")))
	}
	request(s, "PUT", "/api/v1/connection", map[string]string{"api_key": "key-alice-2"}, alice)
	w = okAnswer(t, s, alice, "/api/v1/pocket/widget")
	if got = rows(t, w); len(got) != widgetYears || got[0]["title"] != "2 years ago" || got[0]["detail"] != fmt.Sprintf("%d · 1 video", year-2) || got[5]["title"] != "7 years ago" ||
		!strings.HasPrefix(w["line"].(string), fmt.Sprintf("On this day: %d, %d, ", year-9, year-8)) || !strings.HasSuffix(w["line"].(string), fmt.Sprintf(", %d", year-2)) {
		t.Fatalf("the other library: %v", w)
	}
	// disconnected: nothing at once, kept or not
	request(s, "DELETE", "/api/v1/connection", nil, alice)
	f.asked("/api/")
	if w = okAnswer(t, s, alice, "/api/v1/pocket/widget"); w["line"] != nil || len(rows(t, w)) != 0 || len(f.asked("/api/")) != 0 {
		t.Fatalf("disconnected: %v", w)
	}
	if code, _ := answer(t, s, nil, "GET", "/api/v1/pocket/widget"); code != 401 {
		t.Fatal("no sign-in →", code)
	}
	f.down = true
	if code, m := answer(t, s, bob, "GET", "/api/v1/pocket/widget"); code != 200 || m["line"] != nil {
		t.Fatal("bob's kept answer →", code, m)
	}
	s.widgets.m = nil
	if code, m := answer(t, s, bob, "GET", "/api/v1/pocket/widget"); code != 500 || m["error"] != "the app could not answer" {
		t.Fatal("Immich down →", code, m)
	}
}

// fakeCapCore is a Pocket Core that vouches for link tokens
// pcx_<alice|bob|carol>_<search|day|widget|capture|read|write> from Pocket
// Hub, keeps each person's Immich key (Carol has none) and remembers the
// manifest Photos registers with.
type fakeCapCore struct {
	*httptest.Server
	mu       sync.Mutex
	manifest map[string]any
	creds    []string // who a credential was asked for
}

func newCapCore(t *testing.T, immichURL string) (*Server, *fakeCapCore) {
	t.Helper()
	fc := &fakeCapCore{}
	scopes := map[string]string{"search": core.ScopeSearch, "day": core.ScopeDay, "widget": core.ScopeWidget, "capture": core.ScopeCapture,
		"read": "photos:read", "write": "photos:write"}
	fc.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fc.mu.Lock()
		defer fc.mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/apps/register":
			_ = json.NewDecoder(r.Body).Decode(&fc.manifest)
			writeJSON(w, 200, map[string]any{})
		case "/api/v1/auth/introspect":
			var in struct{ Token string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			parts := strings.Split(in.Token, "_")
			if len(parts) != 3 || parts[0] != "pcx" || scopes[parts[2]] == "" {
				writeJSON(w, 200, map[string]any{"active": false})
				return
			}
			writeJSON(w, 200, map[string]any{"active": true, "kind": "delegated", "audience": "photos", "scope": scopes[parts[2]],
				"user": map[string]any{"id": 1, "sub": parts[1] + "@example.com", "email": parts[1] + "@example.com", "name": parts[1], "role": "member"},
				"app":  map[string]any{"id": 9, "slug": "hub", "name": "Pocket Hub"}})
		case "/api/v1/services/credential":
			var in struct{ User, Type string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			fc.creds = append(fc.creds, in.User+" "+in.Type)
			who := strings.TrimSuffix(in.User, "@example.com")
			if who == "carol" {
				writeJSON(w, 403, map[string]string{"reason": "no_account", "error": "no Immich account"})
				return
			}
			writeJSON(w, 200, map[string]string{"url": immichURL, "key": "key-" + who})
		default:
			_, _ = io.WriteString(w, `{}`)
		}
	}))
	t.Cleanup(fc.Close)
	s := testServer(t, "")
	s.core = core.New(fc.URL, core.Options{DB: s.store.DB, TokenFile: filepath.Join(t.TempDir(), "core.token")})
	return s, fc
}

func TestPocketLinkTokens(t *testing.T) {
	f := newLibraries(t)
	mostar, _, _, vienna := f.seed()
	s, fc := newCapCore(t, f.URL)
	day := "/api/v1/pocket/day/2026-10-25"
	for _, c := range []struct {
		tok, method, path string
		want              int
	}{
		{"pcx_alice_search", "GET", "/api/v1/pocket/search?q=bridge", 200},
		{"pcx_alice_day", "GET", day, 200},
		{"pcx_alice_widget", "GET", "/api/v1/pocket/widget", 200},
		{"pcx_alice_widget", "GET", "/api/v1/auth/me", 200},
		// another capability's route
		{"pcx_alice_search", "GET", day, 403},
		{"pcx_alice_search", "GET", "/api/v1/pocket/widget", 403},
		{"pcx_alice_day", "GET", "/api/v1/pocket/search?q=bridge", 403},
		{"pcx_alice_day", "GET", "/api/v1/pocket/widget", 403},
		{"pcx_alice_widget", "GET", "/api/v1/pocket/search?q=bridge", 403},
		{"pcx_alice_widget", "GET", day, 403},
		// nothing can be added here by a quick line: there is no such route
		{"pcx_alice_capture", "POST", "/api/v1/pocket/capture", 404},
		{"pcx_alice_capture", "GET", "/api/v1/pocket/widget", 403},
		// the rest of the app, the pictures themselves included
		{"pcx_alice_search", "GET", "/api/v1/photos?q=bridge", 403},
		{"pcx_alice_search", "GET", "/api/v1/photos/" + id(mostar), 403},
		{"pcx_alice_search", "POST", "/api/v1/immich/search/smart", 403},
		{"pcx_alice_day", "GET", "/api/v1/immich/assets/" + id(mostar) + "/thumbnail", 403},
		{"pcx_alice_day", "GET", "/api/v1/immich/timeline/buckets", 403},
		{"pcx_alice_widget", "GET", "/api/v1/immich/memories", 403},
		{"pcx_alice_widget", "GET", "/api/v1/connection", 403},
		{"pcx_alice_widget", "POST", "/api/v1/immich/assets", 403},
		// the app's own scopes do not open the new routes
		{"pcx_alice_read", "GET", "/api/v1/pocket/search?q=bridge", 403},
		{"pcx_alice_read", "GET", day, 403},
		{"pcx_alice_read", "GET", "/api/v1/pocket/widget", 403},
		{"pcx_alice_write", "GET", "/api/v1/pocket/search?q=bridge", 403},
		{"pcx_alice_read", "GET", "/api/v1/photos?q=bridge", 200},
		{"pcx_nobody", "GET", "/api/v1/pocket/widget", 401},
	} {
		if code, m := answer(t, s, c.tok, c.method, c.path); code != c.want {
			t.Errorf("%s %s %s → %d, want %d (%v)", c.tok, c.method, c.path, code, c.want, m)
		}
	}
	// every call above reached Immich with Alice's key, taken from Core for her
	for _, c := range f.asked("/api/") {
		if c.key != "key-alice" {
			t.Fatalf("Immich asked with %q: %+v", c.key, c)
		}
	}
	for _, c := range fc.creds {
		if c != "alice@example.com immich" {
			t.Fatalf("Core asked for %q", c)
		}
	}
	// the token acts for its person only: Bob's finds Bob's photo in Bob's library
	got := rows(t, okAnswer(t, s, "pcx_bob_search", "/api/v1/pocket/search?q=bridge"))
	if asked := f.asked("/api/"); len(got) != 1 || got[0]["id"] != id(vienna) || len(asked) != 1 || asked[0].key != "key-bob" {
		t.Fatalf("bob through the link: %v %+v", got, asked)
	}
	if got = rows(t, okAnswer(t, s, "pcx_alice_search", "/api/v1/pocket/search?q=bridge")); len(got) != 3 || got[0]["id"] != id(mostar) {
		t.Fatalf("alice through the link: %v", got)
	}
	if d := okAnswer(t, s, "pcx_bob_day", day); d["summary"] != "1 photo" || rows(t, d)[0]["id"] != id(vienna) {
		t.Fatalf("bob's day through the link: %v", d)
	}
	if d := okAnswer(t, s, "pcx_alice_day", day); d["summary"] != "1 photo" || rows(t, d)[0]["id"] != id(mostar) {
		t.Fatalf("alice's day through the link: %v", d)
	}
	// Carol's Immich is not set in Core: an empty answer each time, and Immich is left alone
	f.asked("/api/")
	for _, c := range [][2]string{{"pcx_carol_search", "/api/v1/pocket/search?q=bridge"}, {"pcx_carol_day", day}, {"pcx_carol_widget", "/api/v1/pocket/widget"}} {
		if m := okAnswer(t, s, c[0], c[1]); len(rows(t, m)) != 0 || m["summary"] != nil || m["line"] != nil {
			t.Fatalf("%s: %v", c[0], m)
		}
	}
	if asked := f.asked("/api/"); len(asked) != 0 {
		t.Fatalf("Immich asked for Carol: %+v", asked)
	}
	// the routes people use tell her what to do, as before
	if code, m := answer(t, s, "pcx_carol_read", "GET", "/api/v1/photos?q=bridge"); code != 409 || m["code"] != "connection_unavailable" {
		t.Fatal("carol's /photos →", code, m)
	}
}

func TestPocketLinkScopes(t *testing.T) {
	req := func(m, p string) *http.Request { return httptest.NewRequest(m, p, nil) }
	for _, c := range []struct {
		scope string
		r     *http.Request
		want  bool
	}{
		{core.ScopeSearch, req("GET", "/api/v1/pocket/search?q=x"), true},
		{core.ScopeDay, req("GET", "/api/v1/pocket/day/2026-01-02"), true},
		{core.ScopeWidget, req("GET", "/api/v1/pocket/widget"), true},
		{core.ScopeWidget, req("GET", "/api/v1/auth/me"), true},
		{core.ScopeSearch, req("POST", "/api/v1/pocket/search"), false},
		{core.ScopeDay, req("GET", "/api/v1/pocket/day/today"), false},
		{core.ScopeDay, req("GET", "/api/v1/immich/timeline/bucket"), false},
		{core.ScopeWidget, req("GET", "/api/v1/immich/memories"), false},
		{core.ScopeSearch, req("GET", "/api/v1/photos"), false},
		{core.ScopeCapture, req("POST", "/api/v1/pocket/capture"), false},
		{core.ScopeCapture, req("POST", "/api/v1/immich/assets"), false},
		{"photos:read", req("GET", "/api/v1/pocket/search?q=x"), false},
		{"photos:read", req("GET", "/api/v1/pocket/widget"), false},
		{"photos:write", req("GET", "/api/v1/pocket/day/2026-01-02"), false},
	} {
		if got := linkAllows([]string{c.scope}, c.r); got != c.want {
			t.Errorf("%s %s %s = %v, want %v", c.scope, c.r.Method, c.r.URL.Path, got, c.want)
		}
	}
}

func TestManifestCapabilities(t *testing.T) {
	s, fc := newCapCore(t, "")
	if _, err := s.core.Register(context.Background(), "key", s.manifest()); err != nil {
		t.Fatal(err)
	}
	m := fc.manifest
	if m["slug"] != "photos" || m["category"] != "Media" {
		t.Fatalf("manifest: %v", m)
	}
	search, _ := m["search"].(map[string]any)
	if search == nil || fmt.Sprint(search["bangs"]) != "[photos photo]" || fmt.Sprint(search["kinds"]) != "[photo video]" || search["what"] == "" {
		t.Fatalf("search: %v", m["search"])
	}
	if day, _ := m["day"].(map[string]any); day == nil || day["label"] != "Photos" || day["one"] != "photo" || day["many"] != "photos" || day["unit"] != "count" || day["what"] == "" {
		t.Fatalf("day: %v", m["day"])
	}
	if widget, _ := m["widget"].(map[string]any); widget == nil || widget["title"] != "On this day" || widget["what"] == "" {
		t.Fatalf("widget: %v", m["widget"])
	}
	if m["capture"] != nil {
		t.Fatalf("nothing is kept here by a quick line: %v", m["capture"])
	}
	offers := map[string]bool{}
	for _, o := range m["offers"].([]any) {
		offers[o.(map[string]any)["scope"].(string)] = true
	}
	for scope, want := range map[string]bool{core.ScopeSearch: true, core.ScopeDay: true, core.ScopeWidget: true, core.ScopeCapture: false, "photos:read": true, "photos:write": true} {
		if offers[scope] != want {
			t.Errorf("offer %s = %v, want %v", scope, offers[scope], want)
		}
	}
}
