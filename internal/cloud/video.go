package cloud

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

// RenderVideo extracts one frame without downloading or retaining the whole video.
// FFmpeg reads a private loopback URL; only the provider ever receives cloud credentials.
// A bounded range reader supports MP4 files whose index is at the end of a large file.
func RenderVideo(ctx context.Context, p Provider, e Entry, size int, durationMs int64) ([]byte, error) {
	if e.Size <= 0 {
		return nil, ErrNoThumb
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	token := "/" + rand.Text()
	reader := &videoReader{reader: NewRangeReader(ctx, p, e), remaining: 64 << 20}
	server := &http.Server{ReadHeaderTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != token || (r.Method != "GET" && r.Method != "HEAD") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r.WithContext(ctx), "video", time.Time{}, io.NewSectionReader(reader, 0, e.Size))
	})}
	defer server.Close()
	go server.Serve(listener)
	seek := float64(0)
	if durationMs > 0 {
		seek = min(1, float64(durationMs)/10000)
	}
	// No playlists, external data references, cloud URLs, credentials or local files
	// are accepted as FFmpeg inputs. Decode one frame with bounded work and output.
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
		"-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1",
		"-protocol_whitelist", "http,tcp", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,asf,flv",
		"-probesize", "2097152", "-analyzeduration", "5000000", "-ss", strconv.FormatFloat(seek, 'f', 3, 64),
		"-i", "http://"+listener.Addr().String()+token,
		"-map", "0:v:0", "-an", "-sn", "-frames:v", "1", "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", size, size),
		"-threads", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1")
	var output boundedVideoOutput
	cmd.Stdout = &output
	// Don't surface decoder diagnostics containing media metadata or URL details.
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("video preview could not be decoded")
	}
	if output.Len() == 0 {
		return nil, errors.New("video contains no decodable frame")
	}
	return Render(bytes.NewReader(output.Bytes()), size, 1, 80)
}

type videoReader struct {
	mu        sync.Mutex
	reader    io.ReaderAt
	remaining int64
}

func (r *videoReader) ReadAt(p []byte, off int64) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if int64(len(p)) > r.remaining {
		return 0, errors.New("video preview read limit exceeded")
	}
	n, err := r.reader.ReadAt(p, off)
	r.remaining -= int64(n)
	return n, err
}

type boundedVideoOutput struct{ bytes.Buffer }

func (b *boundedVideoOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 8<<20 {
		return 0, errors.New("video preview output too large")
	}
	return b.Buffer.Write(p)
}
