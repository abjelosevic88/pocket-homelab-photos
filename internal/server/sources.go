package server

import (
	"context"
	"fmt"
	"github.com/go-chi/chi/v5"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var documentSourcePath = regexp.MustCompile(`^/documents(?:/[0-9]+(?:/download|/thumb)?)?$`)

func allowedSource(app, path string) bool {
	if app == "files" {
		return path == "/spaces" || path == "/fs/list" || path == "/fs/search" || path == "/fs/raw" || path == "/fs/thumb"
	}
	return app == "documents" && documentSourcePath.MatchString(path)
}
func (s *Server) sourceRequest(r *http.Request, app, path string) (*http.Response, error) {
	if !allowedSource(app, strings.Split(path, "?")[0]) {
		return nil, fmt.Errorf("unsupported source")
	}
	link, e := s.core.ActAs(r.Context(), userFrom(r.Context()).Email, app, app+":read")
	if e != nil {
		return nil, e
	}
	req, e := http.NewRequestWithContext(r.Context(), "GET", strings.TrimRight(link.URL, "/")+"/api/v1"+path, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+link.AccessToken)
	return s.http.Do(req)
}
func (s *Server) handleSource(w http.ResponseWriter, r *http.Request) {
	app := chi.URLParam(r, "app")
	path := "/" + chi.URLParam(r, "*")
	if !allowedSource(app, path) {
		writeErr(w, 404, "unsupported source")
		return
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.Query().Encode()
	}
	res, e := s.sourceRequest(r, app, path)
	if e != nil {
		writeErr(w, 409, e.Error())
		return
	}
	defer res.Body.Close()
	relay(w, res)
}
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Space    string `json:"space"`
		Path     string `json:"path"`
		ID       int64  `json:"id"`
		Name     string `json:"name"`
		Modified string `json:"modified"`
	}
	if decode(r, &in) != nil {
		writeErr(w, 400, "invalid import")
		return
	}
	app := chi.URLParam(r, "app")
	path := ""
	switch app {
	case "files":
		if in.Path == "" {
			writeErr(w, 400, "choose a file")
			return
		}
		path = "/fs/raw?" + url.Values{"space": {in.Space}, "path": {in.Path}}.Encode()
		in.Name = filepath.Base(in.Path)
	case "documents":
		if in.ID <= 0 {
			writeErr(w, 400, "choose a document")
			return
		}
		path = fmt.Sprintf("/documents/%d/download?original=1", in.ID)
	default:
		writeErr(w, 404, "unknown source")
		return
	}
	c, e := s.connection(r.Context(), userFrom(r.Context()))
	if e != nil {
		writeErr(w, 409, e.Error())
		return
	}
	res, e := s.sourceRequest(r, app, path)
	if e != nil {
		writeErr(w, 409, e.Error())
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		writeErr(w, res.StatusCode, "source file is unavailable")
		return
	}
	if _, params, e := mime.ParseMediaType(res.Header.Get("Content-Disposition")); e == nil && params["filename"] != "" {
		in.Name = filepath.Base(params["filename"])
	}
	contentType := res.Header.Get("Content-Type")
	ext := strings.ToLower(filepath.Ext(in.Name))
	if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") && !strings.Contains("|.heic|.heif|.dng|.cr2|.nef|.arw|.raf|", "|"+ext+"|") {
		writeErr(w, 415, "only image and video originals can be imported")
		return
	}
	if res.ContentLength > 20<<30 {
		writeErr(w, 413, "file exceeds 20 GB")
		return
	}
	when := time.Now().UTC()
	if t, e := time.Parse(time.RFC3339, in.Modified); e == nil {
		when = t
	}
	uploaded, e := s.uploadToImmich(r.Context(), c, in.Name, res.Body, when, when)
	if e != nil {
		writeErr(w, 502, "import failed; the source file was left unchanged")
		return
	}
	defer uploaded.Body.Close()
	relay(w, uploaded)
}

// uploadToImmich streams an original into the person's Immich as a new asset. created is the
// fallback date for files without one of their own; Immich reads EXIF and spots duplicates.
func (s *Server) uploadToImmich(ctx context.Context, c *connection, name string, body io.Reader, created, modified time.Time) (*http.Response, error) {
	if created.IsZero() {
		created = time.Now().UTC()
	}
	if modified.IsZero() {
		modified = created
	}
	reader, writer := io.Pipe()
	multi := multipart.NewWriter(writer)
	go func() {
		part, e := multi.CreateFormFile("assetData", name)
		if e == nil {
			var n int64
			n, e = io.Copy(part, io.LimitReader(body, (20<<30)+1))
			if e == nil && n > 20<<30 {
				e = fmt.Errorf("source exceeds 20 GiB")
			}
		}
		if e == nil {
			e = multi.WriteField("fileCreatedAt", created.UTC().Format(time.RFC3339))
		}
		if e == nil {
			e = multi.WriteField("fileModifiedAt", modified.UTC().Format(time.RFC3339))
		}
		if e == nil {
			e = multi.Close()
		}
		_ = writer.CloseWithError(e)
	}()
	res, err := s.upstream(ctx, c, "POST", "/assets", reader, http.Header{"Content-Type": {multi.FormDataContentType()}})
	if err != nil {
		reader.Close()
	}
	return res, err
}
