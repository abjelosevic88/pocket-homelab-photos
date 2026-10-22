// Package cloud lists the photos and videos in other clouds (Nextcloud, WebDAV, S3, Google Drive,
// OneDrive, Dropbox), reads their date, camera and GPS position with as few bytes as possible, and
// streams thumbnails and originals. Nothing here ever writes to a cloud.
package cloud

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

// Entry is one photo or video a provider listed.
type Entry struct {
	ID       string // stable id within the account (path for WebDAV/S3)
	Path     string // human path, for display and search
	Name     string
	Mime     string
	Size     int64
	ETag     string
	Modified time.Time
	WebURL   string // open it in the cloud's own web app
	ThumbRef string // provider hint for thumbnails (Drive link, Nextcloud file id)
	Meta     *Meta  // when the provider already knows the photo's metadata
	Deleted  bool   // incremental listings report removals
}

// Meta is what Photos keeps about a photo besides the file itself.
type Meta struct {
	Taken       time.Time
	Lat, Lon    *float64
	Make, Model string
	Width       int
	Height      int
	Orientation int
	DurationMs  int64
}

// Camera joins make and model the way people say it ("Apple iPhone 15 Pro", not "Apple Apple iPhone…").
func (m *Meta) Camera() string {
	mk, md := strings.TrimSpace(m.Make), strings.TrimSpace(m.Model)
	if mk != "" && strings.HasPrefix(strings.ToLower(md), strings.ToLower(mk)) {
		return md
	}
	return strings.TrimSpace(mk + " " + md)
}

// Provider is one connected cloud account.
type Provider interface {
	// Walk lists every photo and video below root. cursor is the provider's change token from the
	// last walk ("" = full listing); the returned cursor is stored for the next one. full reports
	// whether this was a full listing (then whatever was not seen is gone).
	Walk(ctx context.Context, root, cursor string, fn func(Entry) error) (next string, full bool, err error)
	// Get fetches the file, optionally a byte range ("bytes=0-65535").
	Get(ctx context.Context, e Entry, rangeHeader string) (*http.Response, error)
	// Thumb fetches the cloud's own rendering of the photo at about size pixels; ErrNoThumb if it has none.
	Thumb(ctx context.Context, e Entry, size int) (*http.Response, error)
}

var (
	ErrNoThumb   = errors.New("this cloud makes no thumbnail for this file")
	ErrReconnect = errors.New("the cloud no longer accepts this sign-in — connect the account again")
)

// AuthError marks an answer that means the stored sign-in no longer works.
type AuthError struct{ Msg string }

func (e *AuthError) Error() string { return e.Msg }
func (e *AuthError) Unwrap() error { return ErrReconnect }

var imageExt = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
	".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
	".dng": "image/x-adobe-dng", ".cr2": "image/x-canon-cr2", ".cr3": "image/x-canon-cr3", ".nef": "image/x-nikon-nef",
	".arw": "image/x-sony-arw", ".raf": "image/x-fuji-raf", ".orf": "image/x-olympus-orf", ".rw2": "image/x-panasonic-rw2",
}
var videoExt = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".mkv": "video/x-matroska",
	".webm": "video/webm", ".avi": "video/x-msvideo", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
}

// MediaType decides whether a file is a photo or video worth indexing, from its name and the mime type
// the cloud reports. ok is false for everything else.
func MediaType(name, mime string) (typ string, video, ok bool) {
	ext := strings.ToLower(path.Ext(name))
	if t, k := imageExt[ext]; k {
		return t, false, true
	}
	if t, k := videoExt[ext]; k {
		return t, true, true
	}
	mime = strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch {
	case strings.HasPrefix(mime, "image/") && !strings.Contains(mime, "svg") && !strings.Contains(mime, "icon") && !strings.Contains(mime, "vnd."):
		return mime, false, true
	case strings.HasPrefix(mime, "video/"):
		return mime, true, true
	}
	return "", false, false
}

// WebSafe reports whether every browser shows the format as it is.
func WebSafe(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v":
		return true
	}
	return false
}

// Decodable reports whether Photos can make its own thumbnail from the file.
func Decodable(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

// UnderRoot reports whether p is root itself or inside it.
func UnderRoot(p, root string) bool {
	root = strings.Trim(root, "/")
	if root == "" {
		return true
	}
	p = strings.Trim(p, "/")
	return p == root || strings.HasPrefix(p, root+"/")
}

// check turns an HTTP answer into an error unless it is one of the wanted statuses.
func check(res *http.Response, what string, ok ...int) error {
	for _, c := range ok {
		if res.StatusCode == c {
			return nil
		}
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	res.Body.Close()
	msg := strings.TrimSpace(string(b))
	if len(msg) > 300 {
		msg = msg[:300]
	}
	if res.StatusCode == 401 || res.StatusCode == 403 && strings.Contains(strings.ToLower(msg), "token") {
		return &AuthError{fmt.Sprintf("%s: the cloud refused the sign-in (%d) — connect the account again", what, res.StatusCode)}
	}
	if msg != "" {
		return fmt.Errorf("%s: %s: %s", what, res.Status, msg)
	}
	return fmt.Errorf("%s: %s", what, res.Status)
}

// ---- reading parts of a remote file ----

// RangeReader reads a remote file through range requests in 64 KiB blocks, so metadata parsers can
// jump around a multi-gigabyte video while only a few blocks cross the network.
type RangeReader struct {
	ctx     context.Context
	p       Provider
	e       Entry
	size    int64
	mu      sync.Mutex
	blocks  map[int64][]byte
	order   []int64
	whole   []byte // when the server ignored Range and sent everything (small files only)
	Fetches int
}

const blockSize = 64 << 10
const maxBlocks = 64

func NewRangeReader(ctx context.Context, p Provider, e Entry) *RangeReader {
	return &RangeReader{ctx: ctx, p: p, e: e, size: e.Size, blocks: map[int64][]byte{}}
}

func (r *RangeReader) Size() int64 { return r.size }

func (r *RangeReader) ReadAt(b []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	n := 0
	for n < len(b) {
		if r.size > 0 && off >= r.size {
			return n, io.EOF
		}
		blk, err := r.block(off / blockSize)
		if err != nil {
			return n, err
		}
		in := int(off % blockSize)
		if in >= len(blk) {
			return n, io.EOF
		}
		c := copy(b[n:], blk[in:])
		n += c
		off += int64(c)
	}
	return n, nil
}

func (r *RangeReader) block(i int64) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.whole != nil {
		start := i * blockSize
		if start >= int64(len(r.whole)) {
			return nil, io.EOF
		}
		return r.whole[start:min(int64(len(r.whole)), start+blockSize)], nil
	}
	if b, ok := r.blocks[i]; ok {
		return b, nil
	}
	start := i * blockSize
	res, err := r.p.Get(r.ctx, r.e, fmt.Sprintf("bytes=%d-%d", start, start+blockSize-1))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	r.Fetches++
	switch res.StatusCode {
	case http.StatusPartialContent:
		b, err := io.ReadAll(io.LimitReader(res.Body, blockSize))
		if err != nil {
			return nil, err
		}
		r.blocks[i] = b
		r.order = append(r.order, i)
		if len(r.order) > maxBlocks {
			delete(r.blocks, r.order[0])
			r.order = r.order[1:]
		}
		return b, nil
	case http.StatusOK:
		// No range support: keep the file only if it is small enough to be worth it.
		if res.ContentLength > 64<<20 || r.size > 64<<20 {
			return nil, errors.New("the server does not support range requests and the file is too large to read whole")
		}
		b, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
		if err != nil {
			return nil, err
		}
		r.whole = b
		if r.size == 0 {
			r.size = int64(len(b))
		}
		if start >= int64(len(b)) {
			return nil, io.EOF
		}
		return b[start:min(int64(len(b)), start+blockSize)], nil
	case http.StatusRequestedRangeNotSatisfiable:
		return nil, io.EOF
	}
	return nil, check(res, "read "+r.e.Name)
}
