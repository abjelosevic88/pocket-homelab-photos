package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

// A plain search over the person's library for Pocket Core's tools
// (pocket_photos_search / pocket_photos_get) and Pocket AI's "@photos #…"
// picker: newest first, or the best matches for a description, each photo
// with a link that opens it here and its thumbnail.

var assetIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type immichAsset struct {
	ID               string `json:"id"`
	Type             string `json:"type"`
	OriginalFileName string `json:"originalFileName"`
	OriginalMimeType string `json:"originalMimeType"`
	LocalDateTime    string `json:"localDateTime"`
	FileCreatedAt    string `json:"fileCreatedAt"`
	IsFavorite       bool   `json:"isFavorite"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	ExifInfo         *struct {
		City            string   `json:"city"`
		State           string   `json:"state"`
		Country         string   `json:"country"`
		Make            string   `json:"make"`
		Model           string   `json:"model"`
		Description     string   `json:"description"`
		ExifImageWidth  int      `json:"exifImageWidth"`
		ExifImageHeight int      `json:"exifImageHeight"`
		Latitude        *float64 `json:"latitude"`
		Longitude       *float64 `json:"longitude"`
	} `json:"exifInfo"`
	People []struct {
		Name string `json:"name"`
	} `json:"people"`
}

type photoOut struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Kind        string   `json:"kind"`
	TakenAt     string   `json:"taken_at,omitempty"`
	Place       string   `json:"place,omitempty"`
	Width       int      `json:"width,omitempty"`
	Height      int      `json:"height,omitempty"`
	Favorite    bool     `json:"favorite"`
	Mime        string   `json:"mime,omitempty"`
	Camera      string   `json:"camera,omitempty"`
	Description string   `json:"description,omitempty"`
	People      []string `json:"people,omitempty"`
	Latitude    *float64 `json:"latitude,omitempty"`
	Longitude   *float64 `json:"longitude,omitempty"`
	ItemURL     string   `json:"item_url,omitempty"`
	ThumbURL    string   `json:"thumb_url,omitempty"`
}

func (s *Server) photoOut(a immichAsset, full bool) photoOut {
	o := photoOut{ID: a.ID, Title: a.OriginalFileName, Kind: strings.ToLower(a.Type), TakenAt: a.LocalDateTime, Width: a.Width, Height: a.Height, Favorite: a.IsFavorite}
	if o.TakenAt == "" {
		o.TakenAt = a.FileCreatedAt
	}
	if o.Kind == "" {
		o.Kind = "image"
	}
	if x := a.ExifInfo; x != nil {
		if o.Width == 0 {
			o.Width, o.Height = x.ExifImageWidth, x.ExifImageHeight
		}
		o.Place = strings.Trim(x.City+", "+x.Country, ", ")
		if full {
			o.Camera = strings.TrimSpace(x.Make + " " + x.Model)
			o.Description = x.Description
			o.Latitude, o.Longitude = x.Latitude, x.Longitude
		}
	}
	if full {
		o.Mime = a.OriginalMimeType
		for _, p := range a.People {
			if p.Name != "" {
				o.People = append(o.People, p.Name)
			}
		}
	}
	if base := strings.TrimRight(s.cfg.BaseURL, "/"); base != "" && assetIDRe.MatchString(a.ID) {
		o.ItemURL = base + "/?photo=" + a.ID
		o.ThumbURL = base + "/api/v1/immich/assets/" + a.ID + "/thumbnail?size=thumbnail"
	}
	return o
}

// GET /photos?q=&limit=&favorites=&type=: the library newest first, or the best
// matches for a description ("beach at sunset") when q is set.
func (s *Server) handlePhotosList(w http.ResponseWriter, r *http.Request) {
	c, e := s.connection(r.Context(), userFrom(r.Context()))
	if e != nil {
		writeJSON(w, 409, map[string]string{"error": e.Error(), "code": "connection_unavailable"})
		return
	}
	q := r.URL.Query()
	size := 30
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 {
		size = min(n, 100)
	}
	filter := map[string]any{"trashedAt": map[string]any{"eq": nil}}
	switch strings.ToLower(q.Get("type")) {
	case "", "image", "photo", "photos":
		filter["type"] = map[string]any{"eq": "IMAGE"}
	case "video", "videos":
		filter["type"] = map[string]any{"eq": "VIDEO"}
	}
	if v := strings.ToLower(q.Get("favorites")); v == "1" || v == "true" || v == "yes" {
		filter["isFavorite"] = map[string]any{"eq": true}
	}
	body := map[string]any{"filter": filter, "size": size, "withExif": true}
	path := "/search/metadata"
	if text := strings.TrimSpace(q.Get("q")); text != "" {
		path = "/search/smart"
		body["query"] = text
	} else {
		filter["visibility"] = map[string]any{"eq": "timeline"}
		body["orderBy"] = map[string]string{"field": "fileCreatedAt", "direction": "desc"}
	}
	raw, _ := json.Marshal(body)
	res, e := s.upstream(r.Context(), c, http.MethodPost, path, bytes.NewReader(raw), http.Header{"Content-Type": {"application/json"}, "Accept": {"application/json"}})
	if e != nil {
		writeErr(w, 502, "Immich request failed; check the server connection")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		writeErr(w, 502, "Immich could not search your photos ("+res.Status+")")
		return
	}
	var out struct {
		Assets struct {
			Items []immichAsset `json:"items"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&out); err != nil {
		writeErr(w, 502, "Immich sent an answer that could not be read")
		return
	}
	items := make([]photoOut, 0, len(out.Assets.Items))
	for _, a := range out.Assets.Items {
		if len(items) < size {
			items = append(items, s.photoOut(a, false))
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// GET /photos/{id}: one photo's details (when and where it was taken, the
// camera, people in it).
func (s *Server) handlePhotoGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !assetIDRe.MatchString(id) {
		writeErr(w, 400, "not a photo id")
		return
	}
	c, e := s.connection(r.Context(), userFrom(r.Context()))
	if e != nil {
		writeJSON(w, 409, map[string]string{"error": e.Error(), "code": "connection_unavailable"})
		return
	}
	res, e := s.upstream(r.Context(), c, http.MethodGet, "/assets/"+id, nil, http.Header{"Accept": {"application/json"}})
	if e != nil {
		writeErr(w, 502, "Immich request failed; check the server connection")
		return
	}
	defer res.Body.Close()
	if res.StatusCode == 404 || res.StatusCode == 400 {
		writeErr(w, 404, "photo not found")
		return
	}
	if res.StatusCode != 200 {
		writeErr(w, 502, "Immich could not open the photo ("+res.Status+")")
		return
	}
	var a immichAsset
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&a); err != nil {
		writeErr(w, 502, "Immich sent an answer that could not be read")
		return
	}
	writeJSON(w, 200, map[string]any{"photo": s.photoOut(a, true)})
}
