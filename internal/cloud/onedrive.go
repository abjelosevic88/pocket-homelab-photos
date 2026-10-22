package cloud

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OneDrive enumerates a drive with Graph's delta feed: the first walk lists everything, later walks
// only what changed (deletions included). Graph's photo and location facets carry the date, camera
// and position, so nothing is downloaded to index; Graph renders thumbnails for HEIC and videos.
type OneDrive struct{ A *Authed }

type graphItem struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Size                 int64     `json:"size"`
	ETag                 string    `json:"eTag"`
	CTag                 string    `json:"cTag"`
	WebURL               string    `json:"webUrl"`
	LastModifiedDateTime string    `json:"lastModifiedDateTime"`
	Deleted              *struct{} `json:"deleted"`
	Folder               *struct{} `json:"folder"`
	File                 *struct {
		MimeType string `json:"mimeType"`
	} `json:"file"`
	ParentReference *struct {
		Path string `json:"path"`
	} `json:"parentReference"`
	Photo *struct {
		TakenDateTime string `json:"takenDateTime"`
		CameraMake    string `json:"cameraMake"`
		CameraModel   string `json:"cameraModel"`
	} `json:"photo"`
	Location *struct {
		Latitude  *float64 `json:"latitude"`
		Longitude *float64 `json:"longitude"`
	} `json:"location"`
	Image *struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"image"`
	Video *struct {
		Duration int64 `json:"duration"`
		Width    int   `json:"width"`
		Height   int   `json:"height"`
	} `json:"video"`
}

func (o *OneDrive) Login(ctx context.Context) (string, error) {
	var me struct {
		Mail string `json:"mail"`
		UPN  string `json:"userPrincipalName"`
	}
	err := o.A.JSON(ctx, "GET", Endpoints.Graph+"/me?$select=mail,userPrincipalName", nil, &me)
	return firstNonEmpty(me.Mail, me.UPN), err
}

func (o *OneDrive) Probe(ctx context.Context, root string) error {
	target := Endpoints.Graph + "/me/drive/root"
	if r := strings.Trim(root, "/"); r != "" {
		target += ":/" + escapePath(r)
	}
	var it graphItem
	if err := o.A.JSON(ctx, "GET", target+"?$select=id,folder", nil, &it); err != nil {
		if strings.Contains(err.Error(), "404") {
			return fmt.Errorf("there is no folder %q in your OneDrive", root)
		}
		return err
	}
	return nil
}

func (o *OneDrive) Walk(ctx context.Context, root, cursor string, fn func(Entry) error) (string, bool, error) {
	full := cursor == ""
	next := cursor
	if full {
		next = Endpoints.Graph + "/me/drive/root/delta?$select=id,name,size,eTag,cTag,webUrl,lastModifiedDateTime,deleted,folder,file,parentReference,photo,location,image,video"
	}
	for pages := 0; next != "" && pages < 100000; pages++ {
		var page struct {
			Value     []graphItem `json:"value"`
			NextLink  string      `json:"@odata.nextLink"`
			DeltaLink string      `json:"@odata.deltaLink"`
		}
		if err := o.A.JSON(ctx, "GET", next, nil, &page); err != nil {
			if strings.Contains(err.Error(), "410") || strings.Contains(err.Error(), "resyncRequired") {
				return o.Walk(ctx, root, "", fn) // the change token expired: list everything again
			}
			return "", false, err
		}
		for _, it := range page.Value {
			p := itemPath(it)
			if it.Deleted != nil {
				if err := fn(Entry{ID: it.ID, Deleted: true}); err != nil {
					return "", false, err
				}
				continue
			}
			if it.Folder != nil || it.File == nil || !UnderRoot(p, root) {
				if it.File != nil && !full { // moved out of the folder
					if err := fn(Entry{ID: it.ID, Deleted: true}); err != nil {
						return "", false, err
					}
				}
				continue
			}
			typ, video, ok := MediaType(it.Name, it.File.MimeType)
			if !ok {
				continue
			}
			mod, _ := time.Parse(time.RFC3339, it.LastModifiedDateTime)
			e := Entry{ID: it.ID, Path: p, Name: it.Name, Mime: typ, Size: it.Size, ETag: firstNonEmpty(it.CTag, it.ETag), Modified: mod.UTC(), WebURL: it.WebURL}
			if it.Photo != nil || it.Video != nil || video {
				m := &Meta{}
				if ph := it.Photo; ph != nil {
					m.Make, m.Model = ph.CameraMake, ph.CameraModel
					if t, err := time.Parse(time.RFC3339, ph.TakenDateTime); err == nil {
						m.Taken = t
					}
				}
				if l := it.Location; l != nil && l.Latitude != nil && l.Longitude != nil && !(*l.Latitude == 0 && *l.Longitude == 0) {
					m.Lat, m.Lon = l.Latitude, l.Longitude
				}
				if im := it.Image; im != nil {
					m.Width, m.Height = im.Width, im.Height
				}
				if v := it.Video; v != nil {
					m.Width, m.Height, m.DurationMs = v.Width, v.Height, v.Duration
				}
				e.Meta = m
			}
			if err := fn(e); err != nil {
				return "", false, err
			}
		}
		if page.NextLink != "" {
			next = page.NextLink
			continue
		}
		return page.DeltaLink, full, nil
	}
	return "", full, nil
}

// itemPath turns "/drive/root:/Pictures/2024" + name into "Pictures/2024/name".
func itemPath(it graphItem) string {
	dir := ""
	if it.ParentReference != nil {
		if _, after, ok := strings.Cut(it.ParentReference.Path, "root:"); ok {
			dir = strings.Trim(after, "/")
			if d, err := url.PathUnescape(dir); err == nil {
				dir = d
			}
		}
	}
	if dir == "" {
		return it.Name
	}
	return dir + "/" + it.Name
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

func (o *OneDrive) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", Endpoints.Graph+"/me/drive/items/"+url.PathEscape(e.ID)+"/content", nil)
	if err != nil {
		return nil, err
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	return o.A.Do(req) // Graph redirects to a pre-signed download URL; the client follows it without the token
}

func (o *OneDrive) Thumb(ctx context.Context, e Entry, size int) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/me/drive/items/%s/thumbnails/0/c%dx%d/content", Endpoints.Graph, url.PathEscape(e.ID), size, size), nil)
	if err != nil {
		return nil, err
	}
	res, err := o.A.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == 404 || res.StatusCode == 400 {
		res.Body.Close()
		return nil, ErrNoThumb
	}
	if err := check(res, "thumbnail", 200); err != nil {
		return nil, err
	}
	return res, nil
}
