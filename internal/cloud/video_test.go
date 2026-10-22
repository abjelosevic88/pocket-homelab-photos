package cloud

import (
	"bytes"
	"context"
	"encoding/binary"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type videoTestProvider struct {
	Provider
	url   string
	bytes atomic.Int64
	gets  atomic.Int64
}

func (p *videoTestProvider) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	p.gets.Add(1)
	req, _ := http.NewRequestWithContext(ctx, "GET", p.url, nil)
	req.Header.Set("Range", rng)
	return http.DefaultClient.Do(req)
}

func TestVideoFrameFromLargeFileWithIndexAtEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2", "-c:v", "mpeg4", "-threads", "1", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Insert a sparse 900 MB free atom before moov. Samples stay at their original offsets.
	moov := 0
	for off := 0; off+8 <= len(data); {
		n := int(binary.BigEndian.Uint32(data[off:]))
		if n < 8 {
			t.Fatal("bad fixture atom")
		}
		if string(data[off+4:off+8]) == "moov" {
			moov = off
			break
		}
		off += n
	}
	if moov == 0 {
		t.Fatal("missing moov")
	}
	const gap = 900 << 20
	file, err := os.Create(filepath.Join(t.TempDir(), "large.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.Write(data[:moov])
	header := make([]byte, 8)
	binary.BigEndian.PutUint32(header, gap)
	copy(header[4:], "free")
	file.Write(header)
	file.WriteAt(data[moov:], int64(moov+gap))
	info, _ := file.Stat()
	p := &videoTestProvider{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") == "" {
			t.Error("original requested without a byte range")
		}
		http.ServeContent(&countVideoWriter{ResponseWriter: w, n: &p.bytes}, r, "clip.mp4", time.Time{}, io.NewSectionReader(file, 0, info.Size()))
	}))
	defer server.Close()
	p.url = server.URL
	result, err := RenderVideo(context.Background(), p, Entry{Size: info.Size(), Mime: "video/mp4"}, 400, 2000)
	if err != nil {
		t.Fatal(err)
	}
	image, err := jpeg.Decode(bytes.NewReader(result))
	if err != nil {
		t.Fatal(err)
	}
	if image.Bounds().Dx() != 400 || image.Bounds().Dy() != 225 {
		t.Fatal(image.Bounds())
	}
	red, green, blue, _ := image.At(200, 100).RGBA()
	if red < 40000 || green > 10000 || blue > 10000 {
		t.Fatal("wrong frame color")
	}
	if p.bytes.Load() > 8<<20 {
		t.Fatalf("downloaded %d bytes for one frame", p.bytes.Load())
	}
	t.Logf("Rendered %d MB file using %d bytes in %d range reads", info.Size()>>20, p.bytes.Load(), p.gets.Load())
}

type countVideoWriter struct {
	http.ResponseWriter
	n *atomic.Int64
}

func (w *countVideoWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.n.Add(int64(n))
	return n, err
}

func TestVideoReadBudgetAndCancellation(t *testing.T) {
	r := &videoReader{reader: bytes.NewReader([]byte("123456789")), remaining: 4}
	b := make([]byte, 4)
	if _, err := r.ReadAt(b, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadAt(b, 4); err == nil {
		t.Fatal("read budget not enforced")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := RenderVideo(ctx, &videoTestProvider{}, Entry{Size: 100}, 400, 0)
	if err != context.Canceled {
		t.Fatalf("cancel: %v", err)
	}
}

func TestVideoRejectsExternalPlaylist(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	var external atomic.Int64
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { external.Add(1); w.WriteHeader(500) }))
	defer trap.Close()
	data := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n" + trap.URL + "/private.ts\n#EXT-X-ENDLIST\n")
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(data))
	}))
	defer source.Close()
	_, err := RenderVideo(context.Background(), &videoTestProvider{url: source.URL}, Entry{Size: int64(len(data)), Mime: "video/mp4"}, 400, 0)
	if err == nil {
		t.Fatal("playlist accepted")
	}
	if external.Load() != 0 {
		t.Fatal("decoder fetched an external playlist URL")
	}
}
