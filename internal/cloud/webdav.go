package cloud

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
)

// WebDAV walks a WebDAV tree with PROPFIND (depth 1, folder by folder — many servers refuse
// "infinity"). With Nextcloud set, it also asks Nextcloud for its previews (which cover HEIC) and
// links each file to the Files app.
type WebDAV struct {
	Base      string // collection URL the paths are relative to (…/remote.php/dav/files/<user>/ for Nextcloud)
	User      string
	Password  string
	Nextcloud string // Nextcloud origin (https://cloud.example.com) for previews and links; "" for plain WebDAV
	HTTP      *http.Client
}

// NextcloudDAV is the files collection of a Nextcloud user.
func NextcloudDAV(origin, user string) string {
	return strings.TrimRight(origin, "/") + "/remote.php/dav/files/" + url.PathEscape(user) + "/"
}

func (d *WebDAV) client() *http.Client {
	if d.HTTP != nil {
		return d.HTTP
	}
	return http.DefaultClient
}

func (d *WebDAV) do(ctx context.Context, method, target string, body io.Reader, h http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	for k, v := range h {
		req.Header[k] = v
	}
	req.SetBasicAuth(d.User, d.Password)
	return d.client().Do(req)
}

func (d *WebDAV) fileURL(p string) string {
	u, _ := url.Parse(d.Base)
	if strings.Trim(p, "/") == "" { // the root itself
		return u.String()
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	// Build the escaped form ourselves (RawPath) and keep Path its unescaped twin, so names with
	// spaces or non-ASCII letters are escaped exactly once.
	u.RawPath = strings.TrimRight(u.EscapedPath(), "/") + "/" + strings.Join(parts, "/")
	u.Path, _ = url.PathUnescape(u.RawPath)
	return u.String()
}

const propfind = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop>
<d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><oc:fileid/><nc:has-preview/></d:prop></d:propfind>`

type davMultistatus struct {
	Responses []struct {
		Href     string `xml:"href"`
		Propstat []struct {
			Status string `xml:"status"`
			Prop   struct {
				ResourceType struct {
					Collection *struct{} `xml:"collection"`
				} `xml:"resourcetype"`
				ContentType  string `xml:"getcontenttype"`
				Length       string `xml:"getcontentlength"`
				LastModified string `xml:"getlastmodified"`
				ETag         string `xml:"getetag"`
				FileID       string `xml:"fileid"`
				HasPreview   string `xml:"has-preview"`
			} `xml:"prop"`
		} `xml:"propstat"`
	} `xml:"response"`
}

// Probe checks the address and the login by listing the root.
func (d *WebDAV) Probe(ctx context.Context, root string) error {
	res, err := d.do(ctx, "PROPFIND", d.fileURL(root), strings.NewReader(propfind), http.Header{"Depth": {"0"}, "Content-Type": {"application/xml"}})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return fmt.Errorf("the folder %q does not exist on the server", root)
	}
	return check(res, "connect", 207)
}

func (d *WebDAV) Walk(ctx context.Context, root, _ string, fn func(Entry) error) (string, bool, error) {
	base, _ := url.Parse(d.Base)
	basePath := strings.TrimRight(base.Path, "/")
	queue := []string{strings.Trim(root, "/")}
	seen := map[string]bool{}
	for len(queue) > 0 {
		if err := ctx.Err(); err != nil {
			return "", false, err
		}
		dir := queue[0]
		queue = queue[1:]
		if seen[dir] || len(seen) > 200000 {
			continue
		}
		seen[dir] = true
		target := d.fileURL(dir)
		if !strings.HasSuffix(target, "/") {
			target += "/"
		}
		res, err := d.do(ctx, "PROPFIND", target, strings.NewReader(propfind), http.Header{"Depth": {"1"}, "Content-Type": {"application/xml"}})
		if err != nil {
			return "", false, err
		}
		if err := check(res, "list "+dir, 207); err != nil {
			return "", false, err
		}
		var ms davMultistatus
		err = xml.NewDecoder(io.LimitReader(res.Body, 256<<20)).Decode(&ms)
		res.Body.Close()
		if err != nil {
			return "", false, fmt.Errorf("list %s: %w", dir, err)
		}
		for _, r := range ms.Responses {
			hp, err := url.PathUnescape(strings.SplitN(r.Href, "?", 2)[0])
			if err != nil {
				continue
			}
			if u, err := url.Parse(hp); err == nil && u.IsAbs() {
				hp = u.Path
			}
			rel := strings.Trim(strings.TrimPrefix(hp, basePath), "/")
			if rel == strings.Trim(dir, "/") {
				continue
			}
			for _, ps := range r.Propstat {
				if !strings.Contains(ps.Status, " 200") {
					continue
				}
				p := ps.Prop
				if p.ResourceType.Collection != nil {
					if name := path.Base(rel); !strings.HasPrefix(name, ".") {
						queue = append(queue, rel)
					}
					continue
				}
				name := path.Base(rel)
				typ, _, ok := MediaType(name, p.ContentType)
				if !ok || strings.HasPrefix(name, ".") {
					continue
				}
				size, _ := strconv.ParseInt(p.Length, 10, 64)
				mod, _ := http.ParseTime(p.LastModified)
				e := Entry{ID: rel, Path: rel, Name: name, Mime: typ, Size: size, ETag: strings.Trim(p.ETag, `"`), Modified: mod.UTC()}
				if d.Nextcloud != "" && p.FileID != "" {
					e.ThumbRef = p.FileID
					e.WebURL = strings.TrimRight(d.Nextcloud, "/") + "/f/" + p.FileID
				}
				if err := fn(e); err != nil {
					return "", false, err
				}
			}
		}
	}
	return "", true, nil
}

func (d *WebDAV) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	h := http.Header{}
	if rng != "" {
		h.Set("Range", rng)
	}
	return d.do(ctx, "GET", d.fileURL(e.ID), nil, h)
}

func (d *WebDAV) Thumb(ctx context.Context, e Entry, size int) (*http.Response, error) {
	if d.Nextcloud == "" || e.ThumbRef == "" {
		return nil, ErrNoThumb
	}
	q := url.Values{"fileId": {e.ThumbRef}, "x": {strconv.Itoa(size)}, "y": {strconv.Itoa(size)}, "a": {"1"}, "forceIcon": {"0"}}
	res, err := d.do(ctx, "GET", strings.TrimRight(d.Nextcloud, "/")+"/index.php/core/preview?"+q.Encode(), nil, nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == 404 || res.StatusCode == 403 && !strings.HasPrefix(e.Mime, "image/") {
		res.Body.Close()
		return nil, ErrNoThumb
	}
	if err := check(res, "preview", 200); err != nil {
		return nil, err
	}
	return res, nil
}
