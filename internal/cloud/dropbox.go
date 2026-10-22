package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Dropbox lists a folder tree with list_folder (recursive) and keeps its cursor, so later walks only
// see changes. Dropbox has no metadata for photos any more, so EXIF is read from the files with range
// requests; its thumbnails cover HEIC and RAW.
type Dropbox struct{ A *Authed }

type dbxEntry struct {
	Tag            string `json:".tag"`
	ID             string `json:"id"`
	Name           string `json:"name"`
	PathDisplay    string `json:"path_display"`
	PathLower      string `json:"path_lower"`
	Size           int64  `json:"size"`
	ServerModified string `json:"server_modified"`
	ClientModified string `json:"client_modified"`
	ContentHash    string `json:"content_hash"`
	Rev            string `json:"rev"`
}

func (d *Dropbox) Login(ctx context.Context) (string, error) {
	var acc struct {
		Email string `json:"email"`
	}
	err := d.A.JSON(ctx, "POST", Endpoints.DropboxAPI+"/users/get_current_account", nil, &acc)
	return acc.Email, err
}

func dbxRoot(root string) string {
	r := strings.Trim(root, "/")
	if r == "" {
		return ""
	}
	return "/" + r
}

func (d *Dropbox) Probe(ctx context.Context, root string) error {
	if dbxRoot(root) == "" {
		_, err := d.Login(ctx)
		return err
	}
	var out dbxEntry
	if err := d.A.JSON(ctx, "POST", Endpoints.DropboxAPI+"/files/get_metadata", map[string]any{"path": dbxRoot(root)}, &out); err != nil {
		if strings.Contains(err.Error(), "not_found") {
			return fmt.Errorf("there is no folder %q in your Dropbox", root)
		}
		return err
	}
	return nil
}

func (d *Dropbox) Walk(ctx context.Context, root, cursor string, fn func(Entry) error) (string, bool, error) {
	full := cursor == ""
	var page struct {
		Entries []dbxEntry `json:"entries"`
		Cursor  string     `json:"cursor"`
		HasMore bool       `json:"has_more"`
	}
	var err error
	if full {
		err = d.A.JSON(ctx, "POST", Endpoints.DropboxAPI+"/files/list_folder", map[string]any{"path": dbxRoot(root), "recursive": true, "limit": 2000}, &page)
	} else {
		err = d.A.JSON(ctx, "POST", Endpoints.DropboxAPI+"/files/list_folder/continue", map[string]any{"cursor": cursor}, &page)
		if err != nil && strings.Contains(err.Error(), "reset") {
			return d.Walk(ctx, root, "", fn)
		}
	}
	for pages := 0; err == nil && pages < 100000; pages++ {
		for _, e := range page.Entries {
			switch e.Tag {
			case "deleted":
				if err := fn(Entry{ID: "path:" + e.PathLower, Deleted: true}); err != nil {
					return "", false, err
				}
			case "file":
				typ, _, ok := MediaType(e.Name, "")
				if !ok {
					continue
				}
				mod, _ := time.Parse(time.RFC3339, firstNonEmpty(e.ClientModified, e.ServerModified))
				p := strings.TrimPrefix(e.PathDisplay, "/")
				// Deletions only carry the path, so items are keyed by it; the stable id rides along for downloads.
				if err := fn(Entry{ID: "path:" + e.PathLower, Path: p, Name: e.Name, Mime: typ, Size: e.Size, ETag: firstNonEmpty(e.ContentHash, e.Rev),
					Modified: mod.UTC(), ThumbRef: e.ID, WebURL: "https://www.dropbox.com/preview" + escapePath(e.PathDisplay)}); err != nil {
					return "", false, err
				}
			}
		}
		if !page.HasMore {
			return page.Cursor, full, nil
		}
		c := page.Cursor
		page.Entries = nil
		err = d.A.JSON(ctx, "POST", Endpoints.DropboxAPI+"/files/list_folder/continue", map[string]any{"cursor": c}, &page)
	}
	return "", false, err
}

func (d *Dropbox) ref(e Entry) string {
	if e.ThumbRef != "" {
		return e.ThumbRef // "id:…"
	}
	return strings.TrimPrefix(e.ID, "path:")
}

// apiArg encodes the Dropbox-API-Arg header, which must be ASCII.
func apiArg(v any) string {
	b, _ := json.Marshal(v)
	var s strings.Builder
	for _, r := range string(b) {
		if r > 127 {
			fmt.Fprintf(&s, `\u%04x`, r)
		} else {
			s.WriteRune(r)
		}
	}
	return s.String()
}

func (d *Dropbox) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", Endpoints.DropboxContent+"/files/download", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Dropbox-API-Arg", apiArg(map[string]string{"path": d.ref(e)}))
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	return d.A.Do(req)
}

func (d *Dropbox) Thumb(ctx context.Context, e Entry, size int) (*http.Response, error) {
	sz := "w480h320"
	switch {
	case size > 1024:
		sz = "w2048h1536"
	case size > 640:
		sz = "w1024h768"
	case size > 480:
		sz = "w640h480"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", Endpoints.DropboxContent+"/files/get_thumbnail_v2", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Dropbox-API-Arg", apiArg(map[string]any{"resource": map[string]string{".tag": "path", "path": d.ref(e)}, "format": "jpeg", "size": sz, "mode": "fitone_bestfit"}))
	res, err := d.A.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == 409 {
		res.Body.Close()
		return nil, ErrNoThumb
	}
	if err := check(res, "thumbnail", 200); err != nil {
		return nil, err
	}
	return res, nil
}
