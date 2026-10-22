package cloud

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GoogleDrive lists the photos and videos in a person's Drive. Drive already knows each photo's date,
// camera and position (imageMediaMetadata), so nothing is downloaded to index it, and Drive renders
// thumbnails for every format it previews, HEIC included.
type GoogleDrive struct{ A *Authed }

const driveFields = "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,webViewLink,thumbnailLink," +
	"imageMediaMetadata(width,height,time,rotation,cameraMake,cameraModel,location),videoMediaMetadata(width,height,durationMillis))"

type driveFile struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	MimeType      string   `json:"mimeType"`
	Size          string   `json:"size"`
	MD5           string   `json:"md5Checksum"`
	ModifiedTime  string   `json:"modifiedTime"`
	CreatedTime   string   `json:"createdTime"`
	Parents       []string `json:"parents"`
	WebViewLink   string   `json:"webViewLink"`
	ThumbnailLink string   `json:"thumbnailLink"`
	Image         *struct {
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Time        string `json:"time"`
		Rotation    int    `json:"rotation"`
		CameraMake  string `json:"cameraMake"`
		CameraModel string `json:"cameraModel"`
		Location    *struct {
			Latitude  float64 `json:"latitude"`
			Longitude float64 `json:"longitude"`
		} `json:"location"`
	} `json:"imageMediaMetadata"`
	Video *struct {
		Width          int    `json:"width"`
		Height         int    `json:"height"`
		DurationMillis string `json:"durationMillis"`
	} `json:"videoMediaMetadata"`
}

func (g *GoogleDrive) Login(ctx context.Context) (string, error) {
	var u struct {
		Email string `json:"email"`
	}
	err := g.A.JSON(ctx, "GET", Endpoints.GoogleUser, nil, &u)
	return u.Email, err
}

// folderID resolves a "Photos/2024" style path below My Drive.
func (g *GoogleDrive) folderID(ctx context.Context, root string) (string, error) {
	id := "root"
	for _, name := range strings.Split(strings.Trim(root, "/"), "/") {
		if name == "" {
			continue
		}
		q := fmt.Sprintf("'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", id, strings.ReplaceAll(name, "'", `\'`))
		var out struct {
			Files []driveFile `json:"files"`
		}
		if err := g.A.JSON(ctx, "GET", Endpoints.GoogleAPI+"/drive/v3/files?"+url.Values{"q": {q}, "fields": {"files(id)"}, "pageSize": {"10"}}.Encode(), nil, &out); err != nil {
			return "", err
		}
		if len(out.Files) == 0 {
			return "", fmt.Errorf("there is no folder %q in your Drive", root)
		}
		id = out.Files[0].ID
	}
	return id, nil
}

func (g *GoogleDrive) Probe(ctx context.Context, root string) error {
	_, err := g.folderID(ctx, root)
	return err
}

func (g *GoogleDrive) Walk(ctx context.Context, root, _ string, fn func(Entry) error) (string, bool, error) {
	media := "(mimeType contains 'image/' or mimeType contains 'video/') and trashed = false"
	if strings.Trim(root, "/") == "" {
		// The whole Drive in one query, no folder walking.
		return "", true, g.list(ctx, media, "", fn)
	}
	top, err := g.folderID(ctx, root)
	if err != nil {
		return "", false, err
	}
	queue := []struct{ id, path string }{{top, strings.Trim(root, "/")}}
	for n := 0; len(queue) > 0 && n < 100000; n++ {
		f := queue[0]
		queue = queue[1:]
		if err := g.list(ctx, fmt.Sprintf("'%s' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or %s)", f.id, media[:len(media)-len(" and trashed = false")]), f.path, func(e Entry) error {
			if e.Mime == "folder" {
				queue = append(queue, struct{ id, path string }{e.ID, e.Path})
				return nil
			}
			return fn(e)
		}); err != nil {
			return "", false, err
		}
	}
	return "", true, nil
}

func (g *GoogleDrive) list(ctx context.Context, q, dir string, fn func(Entry) error) error {
	page := ""
	for {
		v := url.Values{"q": {q}, "fields": {driveFields}, "pageSize": {"1000"}, "spaces": {"drive"}, "orderBy": {"modifiedTime desc"}}
		if page != "" {
			v.Set("pageToken", page)
		}
		var out struct {
			NextPageToken string      `json:"nextPageToken"`
			Files         []driveFile `json:"files"`
		}
		if err := g.A.JSON(ctx, "GET", Endpoints.GoogleAPI+"/drive/v3/files?"+v.Encode(), nil, &out); err != nil {
			return err
		}
		for _, f := range out.Files {
			p := f.Name
			if dir != "" {
				p = dir + "/" + f.Name
			}
			if f.MimeType == "application/vnd.google-apps.folder" {
				if err := fn(Entry{ID: f.ID, Path: p, Mime: "folder"}); err != nil {
					return err
				}
				continue
			}
			typ, video, ok := MediaType(f.Name, f.MimeType)
			if !ok {
				continue
			}
			size, _ := strconv.ParseInt(f.Size, 10, 64)
			mod, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			e := Entry{ID: f.ID, Path: p, Name: f.Name, Mime: typ, Size: size, ETag: firstNonEmpty(f.MD5, f.ModifiedTime), Modified: mod.UTC(),
				WebURL: f.WebViewLink, ThumbRef: f.ThumbnailLink}
			m := &Meta{}
			if im := f.Image; im != nil {
				m.Width, m.Height = im.Width, im.Height
				if im.Rotation == 1 || im.Rotation == 3 {
					m.Width, m.Height = m.Height, m.Width
				}
				m.Make, m.Model = im.CameraMake, im.CameraModel
				if t, ok := exifTime(im.Time, ""); ok {
					m.Taken = t
				}
				if l := im.Location; l != nil && !(l.Latitude == 0 && l.Longitude == 0) {
					la, lo := l.Latitude, l.Longitude
					m.Lat, m.Lon = &la, &lo
				}
			}
			if vd := f.Video; vd != nil || video {
				if vd != nil {
					m.Width, m.Height = vd.Width, vd.Height
					m.DurationMs, _ = strconv.ParseInt(vd.DurationMillis, 10, 64)
				}
			}
			// Drive leaves the time out for some photos; those still get their EXIF read from the file.
			if !m.Taken.IsZero() || m.Lat != nil || video {
				e.Meta = m
			}
			if err := fn(e); err != nil {
				return err
			}
		}
		if out.NextPageToken == "" {
			return nil
		}
		page = out.NextPageToken
	}
}

func (g *GoogleDrive) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", Endpoints.GoogleAPI+"/drive/v3/files/"+url.PathEscape(e.ID)+"?alt=media", nil)
	if err != nil {
		return nil, err
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	return g.A.Do(req)
}

var driveThumbSize = regexp.MustCompile(`=s\d+(-[a-z]+)?$`)

func (g *GoogleDrive) Thumb(ctx context.Context, e Entry, size int) (*http.Response, error) {
	link := e.ThumbRef
	for attempt := 0; attempt < 2; attempt++ {
		if link == "" || attempt > 0 {
			// thumbnail links expire after a few hours: ask Drive for a fresh one
			var f driveFile
			if err := g.A.JSON(ctx, "GET", Endpoints.GoogleAPI+"/drive/v3/files/"+url.PathEscape(e.ID)+"?fields=thumbnailLink", nil, &f); err != nil {
				return nil, err
			}
			if f.ThumbnailLink == "" {
				return nil, ErrNoThumb
			}
			link = f.ThumbnailLink
		}
		target := driveThumbSize.ReplaceAllString(link, fmt.Sprintf("=s%d", size))
		req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
		if err != nil {
			return nil, err
		}
		res, err := g.A.Do(req)
		if err != nil {
			return nil, err
		}
		if res.StatusCode == 200 {
			return res, nil
		}
		res.Body.Close()
		if res.StatusCode == 404 {
			return nil, ErrNoThumb
		}
	}
	return nil, ErrNoThumb
}
