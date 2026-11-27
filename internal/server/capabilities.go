package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
)

// Photos for the apps that bring the box together (capabilities in links.go):
// the library the person sees here, in the one shape Pocket Search, Pocket
// Day and Pocket Hub ask every app for. The photos live in Immich, so each
// route asks the person's own Immich, with their own way in (s.connection,
// exactly as GET /photos and the /immich routes do) and under the same
// limits; nobody's key is ever used for somebody else. A person with no
// library yet gets an empty answer, not an error; an Immich that does not
// answer is an error. Addresses are paths in the app; the one who asks makes
// them whole.

const (
	dayShown    = 12               // photos of a day shown as rows, spread over the day
	dayPage     = 250              // photos asked from Immich at a time
	dayCounted  = 2000             // a day is read and counted up to here; past it the line says "more than"
	widgetYears = 6                // earlier years shown in the widget
	widgetKept  = 10 * time.Minute // how long a person's "On this day" is reused
	immichTime  = "2006-01-02T15:04:05.000Z"
)

// noLibrary reports whether the person simply has no library to look in now:
// no Immich connected here, or their Immich switched off or not set in Pocket Core.
func noLibrary(err error) bool {
	var le *core.LinkError
	return errors.Is(err, errNotConnected) || errors.Is(err, errNoImmichKey) || errors.As(err, &le)
}

// zone is the box's time zone (TZ), for a caller that did not say the person's.
func (s *Server) zone() *time.Location {
	if s.cfg.Timezone != "" {
		if loc, err := time.LoadLocation(s.cfg.Timezone); err == nil {
			return loc
		}
	}
	return time.Local
}

func photoURL(id string) string   { return "/?photo=" + id }
func photoThumb(id string) string { return "/api/v1/immich/assets/" + id + "/thumbnail?size=thumbnail" }

func photoKind(a immichAsset) string {
	if strings.EqualFold(a.Type, "VIDEO") {
		return "video"
	}
	return "photo"
}

// kindWord names a photo nothing else is known about.
func kindWord(a immichAsset) string {
	if photoKind(a) == "video" {
		return "Video"
	}
	return "Photo"
}

// takenAt is the moment a photo was taken; ok is false when Immich did not say.
func takenAt(a immichAsset) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, a.FileCreatedAt)
	return t, err == nil
}

// wallClock is the date and time on the clock where the photo was taken (the
// day Immich files it under), whatever the time zone was.
func wallClock(a immichAsset) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339, a.LocalDateTime); err == nil {
		return t.UTC(), true
	}
	t, ok := takenAt(a)
	return t.UTC(), ok
}

// photoPlace is the town a photo was taken in (else the region or country)
// and the country to say after it.
func photoPlace(a immichAsset) (place, country string) {
	x := a.ExifInfo
	if x == nil {
		return "", ""
	}
	place = firstNonEmpty(strings.TrimSpace(x.City), strings.TrimSpace(x.State), strings.TrimSpace(x.Country))
	if country = strings.TrimSpace(x.Country); country == place {
		country = ""
	}
	return place, country
}

// photoPeople are the named people in a photo: "Ana", "Ana and Marko", "Ana, Marko and 2 more".
func photoPeople(a immichAsset) string {
	names := []string{}
	for _, p := range a.People {
		if n := strings.TrimSpace(p.Name); n != "" {
			names = append(names, n)
		}
	}
	switch {
	case len(names) == 0:
		return ""
	case len(names) <= 2:
		return strings.Join(names, " and ")
	case len(names) == 3:
		return names[0] + ", " + names[1] + " and " + names[2]
	}
	return names[0] + ", " + names[1] + fmt.Sprintf(" and %d more", len(names)-2)
}

func photoCamera(a immichAsset) string {
	if a.ExifInfo == nil {
		return ""
	}
	return strings.TrimSpace(a.ExifInfo.Make + " " + a.ExifInfo.Model)
}

func photoDescription(a immichAsset) string {
	if a.ExifInfo == nil {
		return ""
	}
	return strings.TrimSpace(a.ExifInfo.Description)
}

func joinNonEmpty(sep string, parts ...string) string {
	out := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// thousands writes a count the way people read it: 1,234.
func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// countWords says how many photos and videos: "34 photos, 2 videos", "1 video", "" for none.
func countWords(photos, videos int) string {
	one := func(n int, word string) string {
		switch n {
		case 0:
			return ""
		case 1:
			return "1 " + word
		}
		return thousands(n) + " " + word + "s"
	}
	return joinNonEmpty(", ", one(photos, "photo"), one(videos, "video"))
}

// countKinds counts the photos and the videos among assets.
func countKinds(assets []immichAsset) (photos, videos int) {
	for _, a := range assets {
		if photoKind(a) == "video" {
			videos++
		} else {
			photos++
		}
	}
	return photos, videos
}

// pocketSearch finds photos and videos by a description, with the search
// behind GET /photos?q= (Immich's smart search), best match first.
func (s *Server) pocketSearch(r *http.Request, q string, limit int) ([]core.SearchItem, error) {
	ctx := r.Context()
	c, err := s.connection(ctx, userFrom(ctx))
	if err != nil {
		if noLibrary(err) {
			return nil, nil
		}
		return nil, err
	}
	assets, _, err := s.searchAssets(ctx, c, "/search/smart", map[string]any{
		"query": q, "size": limit, "withExif": true, "filter": map[string]any{"trashedAt": map[string]any{"eq": nil}}})
	if err != nil {
		return nil, err
	}
	out := []core.SearchItem{}
	for _, a := range assets {
		if !assetIDRe.MatchString(a.ID) || len(out) == limit {
			continue
		}
		place, country := photoPlace(a)
		people := photoPeople(a)
		day, clock := "", ""
		if t, ok := wallClock(a); ok {
			day, clock = t.Format("2 Jan 2006"), t.Format("15:04")
		}
		// the day and where (else who, else the file's name): "12 Nov 2026 · Sarajevo"
		title := joinNonEmpty(" · ", day, firstNonEmpty(place, people, a.OriginalFileName))
		if place == "" {
			people = ""
		}
		it := core.SearchItem{ID: a.ID, Title: firstNonEmpty(title, kindWord(a)), Kind: photoKind(a), URL: photoURL(a.ID),
			Snippet: joinNonEmpty(" · ", clock, photoDescription(a), people, country, photoCamera(a))}
		if t, ok := takenAt(a); ok {
			it.Date = t.UTC().Format(time.RFC3339)
		} else if t, ok := wallClock(a); ok {
			it.Date = t.Format("2006-01-02")
		}
		out = append(out, it)
	}
	return out, nil
}

// pocketDay is the photos and videos taken on a day of the person's calendar
// (tz; the box's own when the caller said none): how many, and a few of them
// spread over the day, each with its thumbnail. They are what "All photos"
// shows here: nothing archived, hidden or deleted.
func (s *Server) pocketDay(r *http.Request, date string, tz *time.Location) (*core.Day, error) {
	ctx := r.Context()
	c, err := s.connection(ctx, userFrom(ctx))
	if err != nil {
		if noLibrary(err) {
			return nil, nil
		}
		return nil, err
	}
	if tz == nil {
		tz = s.zone()
	}
	start, err := time.ParseInLocation("2006-01-02", date, tz)
	if err != nil {
		return nil, err
	}
	end := start.AddDate(0, 0, 1)
	filter := map[string]any{"trashedAt": map[string]any{"eq": nil}, "visibility": map[string]any{"eq": "timeline"},
		"takenAt": map[string]any{"gte": start.UTC().Format(immichTime), "lt": end.UTC().Format(immichTime)}}
	var assets []immichAsset
	more, cursor := false, ""
	for pages := 1; ; pages++ {
		body := map[string]any{"filter": filter, "size": dayPage, "withExif": true, "withPeople": true,
			"orderBy": map[string]string{"field": "fileCreatedAt", "direction": "asc"}}
		if cursor != "" {
			body["cursor"] = cursor
		}
		page, next, err := s.searchAssets(ctx, c, "/search/metadata", body)
		if err != nil {
			return nil, err
		}
		for _, a := range page {
			// only what was taken between the day's two midnights, whatever Immich sent
			if t, ok := takenAt(a); assetIDRe.MatchString(a.ID) && (!ok || (!t.Before(start) && t.Before(end))) {
				assets = append(assets, a)
			}
		}
		if next == "" || len(page) == 0 {
			break
		}
		if pages == dayCounted/dayPage {
			more = true
			break
		}
		cursor = next
	}
	if len(assets) == 0 {
		return nil, nil
	}
	day := &core.Day{Date: date}
	if photos, videos := countKinds(assets); more {
		day.Summary = "More than " + thousands(len(assets)) + " photos and videos"
	} else {
		day.Summary = countWords(photos, videos)
		if photos > 0 {
			day.Metrics = append(day.Metrics, core.Metric{Label: "Photos", Value: thousands(photos)})
		}
		if videos > 0 {
			day.Metrics = append(day.Metrics, core.Metric{Label: "Videos", Value: thousands(videos)})
		}
	}
	for _, i := range spread(len(assets), dayShown) {
		a := assets[i]
		place, _ := photoPlace(a)
		people := photoPeople(a)
		it := core.DayItem{ID: a.ID, Title: firstNonEmpty(place, people, a.OriginalFileName, kindWord(a)), Kind: photoKind(a),
			URL: photoURL(a.ID), Image: photoThumb(a.ID), Note: photoDescription(a)}
		if place == "" {
			people = ""
		}
		it.Sub = joinNonEmpty(" · ", people, photoCamera(a))
		if t, ok := takenAt(a); ok {
			it.Time = t.In(tz).Format("15:04")
		}
		day.Items = append(day.Items, it)
	}
	return day, nil
}

// spread picks at most max of n things in order, evenly, the first and the last among them.
func spread(n, max int) []int {
	out := make([]int, 0, max)
	if n <= max {
		for i := 0; i < n; i++ {
			out = append(out, i)
		}
		return out
	}
	for i := 0; i < max; i++ {
		out = append(out, i*(n-1)/(max-1))
	}
	return out
}

// widgetCache keeps each person's "On this day" for a few minutes: it is the
// same all day, and a home screen asks for it every time it opens.
type widgetCache struct {
	sync.Mutex
	m map[int64]widgetKeep
}

type widgetKeep struct {
	day, library string // the date it is for, and whose Immich it came from
	data         *core.WidgetData
	at           time.Time
}

type immichMemory struct {
	Type     string `json:"type"`
	MemoryAt string `json:"memoryAt"`
	Data     struct {
		Year int `json:"year"`
	} `json:"data"`
	Assets []immichAsset `json:"assets"`
}

// pocketWidget is "On this day": the earlier years with photos from today's
// date, as the Memories page shows them. The person's way into Immich is
// checked on every call (a library switched off in Pocket Core shows nothing
// at once); only Immich's answer is kept for a while.
func (s *Server) pocketWidget(r *http.Request) (*core.WidgetData, error) {
	ctx := r.Context()
	u := userFrom(ctx)
	c, err := s.connection(ctx, u)
	if err != nil {
		if noLibrary(err) {
			return nil, nil
		}
		return nil, err
	}
	today := time.Now().In(s.zone())
	sum := sha256.Sum256([]byte(c.Base + "\x00" + c.Secret))
	day, library := today.Format("2006-01-02"), hex.EncodeToString(sum[:])
	s.widgets.Lock()
	k, ok := s.widgets.m[u.ID]
	s.widgets.Unlock()
	if ok && k.day == day && k.library == library && time.Since(k.at) < widgetKept {
		return k.data, nil
	}
	data, err := s.onThisDay(ctx, c, today)
	if err != nil {
		return nil, err
	}
	s.widgets.Lock()
	if s.widgets.m == nil {
		s.widgets.m = map[int64]widgetKeep{}
	}
	s.widgets.m[u.ID] = widgetKeep{day, library, data, time.Now()}
	s.widgets.Unlock()
	return data, nil
}

// onThisDay asks Immich for today's "on this day" memories: one row per
// earlier year, the nearest first (nil when there is none).
func (s *Server) onThisDay(ctx context.Context, c *connection, today time.Time) (*core.WidgetData, error) {
	res, err := s.upstream(ctx, c, http.MethodGet, "/memories?for="+today.Format("2006-01-02")+"&type=on_this_day", nil, http.Header{"Accept": {"application/json"}})
	if err != nil {
		return nil, errors.New("Immich request failed; check the server connection")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("Immich could not list your memories (" + res.Status + ")")
	}
	var memories []immichMemory
	if err := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&memories); err != nil {
		return nil, errors.New("Immich sent an answer that could not be read")
	}
	byYear := map[int][]immichAsset{}
	for _, m := range memories {
		year := m.Data.Year
		if t, err := time.Parse(time.RFC3339, m.MemoryAt); err == nil && year == 0 {
			year = t.Year()
		}
		if (m.Type != "" && m.Type != "on_this_day") || year <= 0 || year >= today.Year() {
			continue
		}
		for _, a := range m.Assets {
			if assetIDRe.MatchString(a.ID) && !a.IsTrashed {
				byYear[year] = append(byYear[year], a)
			}
		}
	}
	if len(byYear) == 0 {
		return nil, nil
	}
	years := make([]int, 0, len(byYear))
	for y := range byYear {
		years = append(years, y)
	}
	sort.Ints(years)
	said := make([]string, len(years))
	for i, y := range years {
		said[i] = strconv.Itoa(y)
	}
	out := &core.WidgetData{Line: "On this day: " + strings.Join(said, ", "), URL: "/memories"}
	for i := len(years) - 1; i >= 0 && len(out.Items) < widgetYears; i-- {
		y, list := years[i], byYear[years[i]]
		first := list[0]
		place, _ := photoPlace(first)
		if first.ExifInfo == nil {
			// a memory comes without where its photos were taken: ask for the first one's
			if full, err := s.asset(ctx, c, first.ID); err == nil {
				place, _ = photoPlace(*full)
			}
		}
		ago := "1 year ago"
		if n := today.Year() - y; n > 1 {
			ago = strconv.Itoa(n) + " years ago"
		}
		out.Items = append(out.Items, core.WidgetItem{ID: first.ID, Title: ago, Detail: joinNonEmpty(" · ", strconv.Itoa(y), place, countWords(countKinds(list))), URL: photoURL(first.ID)})
	}
	return out, nil
}
