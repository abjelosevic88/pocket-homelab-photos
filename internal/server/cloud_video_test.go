package server

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/abjelosevic88/pocket-homelab-photos/internal/cloud/cloudtest"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

func TestCloudVideoThumbnailFallbackCacheAndPrivacy(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2", "-c:v", "mpeg4", "-threads", "1", path).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	video, _ := os.ReadFile(path)
	var gets, videoGets, uploads atomic.Int64
	var iconPreview atomic.Bool
	nc := fakeNextcloud(t, cloudtest.JPEG(800, 600, 1), &gets)
	defer nc.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/index.php/core/preview" && r.URL.Query().Get("fileId") == "99" {
			if iconPreview.Load() {
				w.Header().Set("Content-Type", "image/svg+xml")
				w.Write([]byte("<svg></svg>"))
				return
			}
			w.WriteHeader(404)
			return
		}
		if r.URL.Path == "/remote.php/dav/files/ana/Photos/clip.mp4" {
			u, p, ok := r.BasicAuth()
			if !ok || u != "ana" || p != "app-password" {
				t.Error("missing provider credentials")
				w.WriteHeader(401)
				return
			}
			videoGets.Add(1)
			http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(video))
			return
		}
		nc.Config.Handler.ServeHTTP(w, r)
	}))
	defer proxy.Close()
	im := fakeImmich(t, &uploads)
	defer im.Close()
	s := testServer(t, im.URL)
	ana := account(t, s, "ana@example.com")
	bob := account(t, s, "bob@example.com")
	w := request(s, "POST", "/api/v1/clouds", map[string]any{"kind": "nextcloud", "root": "Photos", "fields": map[string]string{"url": proxy.URL, "username": "ana", "password": "app-password"}}, ana)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var account struct{ ID int64 }
	json.Unmarshal(w.Body.Bytes(), &account)
	waitIdle(t, s, ana)
	it := &store.CloudItem{AccountID: account.ID, RemoteID: "Photos/clip.mp4", Path: "Photos/clip.mp4", Name: "clip.mp4", Mime: "video/mp4", Video: true, Size: int64(len(video)), ETag: "video-v1", ThumbRef: "99", DurationMs: 2000, Indexed: true}
	if _, err := s.store.UpsertCloudItem(context.Background(), it, 1); err != nil {
		t.Fatal(err)
	}
	sum := sha1.Sum([]byte(it.ETag + "|" + strconv.FormatInt(it.Size, 10)))
	base := filepath.Join(s.thumbDir(account.ID), fmt.Sprintf("%d-%s", it.ID, hex.EncodeToString(sum[:6])))
	os.MkdirAll(filepath.Dir(base), 0755)
	os.WriteFile(base+".none", nil, 0644)
	url := fmt.Sprintf("/api/v1/clouds/items/%d/thumb", it.ID)
	if w := request(s, "GET", url, nil, bob); w.Code != 404 {
		t.Fatal("another user can see the video", w.Code)
	}
	if videoGets.Load() != 0 {
		t.Fatal("unauthorized request accessed video")
	}
	w = request(s, "GET", url, nil, ana)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := jpeg.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
	count := videoGets.Load()
	if count == 0 {
		t.Fatal("fallback never read the original")
	}
	again := request(s, "GET", url, nil, ana)
	if again.Code != 200 || !bytes.Equal(w.Body.Bytes(), again.Body.Bytes()) || videoGets.Load() != count {
		t.Fatal("thumbnail cache not reused")
	}
	// A fresh negative cache entry is brief, and an expired one allows recovery.
	os.Remove(base + ".jpg")
	os.WriteFile(base+".none-v2", nil, 0644)
	if w := request(s, "GET", url, nil, ana); w.Code != 404 || videoGets.Load() != count {
		t.Fatal("fresh miss cache ignored")
	}
	iconPreview.Store(true)
	past := time.Now().Add(-11 * time.Minute)
	os.Chtimes(base+".none-v2", past, past)
	if w := request(s, "GET", url, nil, ana); w.Code != 200 || videoGets.Load() == count {
		t.Fatal("expired miss cache did not recover")
	}
	// Generic WebDAV videos also advertise the locally generated preview.
	if !hasThumb(&store.CloudAccount{Kind: "webdav"}, it) {
		t.Fatal("video fallback not advertised")
	}
}
