package cloud

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/cloud/cloudtest"
	"image/jpeg"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func checkMeta(t *testing.T, m *Meta) {
	t.Helper()
	want := time.Date(2026, 9, 7, 14, 3, 22, 0, time.FixedZone("", 7200))
	if !m.Taken.Equal(want) {
		t.Errorf("taken %v, want %v", m.Taken, want)
	}
	if m.Camera() != "Apple iPhone 15 Pro" {
		t.Errorf("camera %q", m.Camera())
	}
	if m.Lat == nil || math.Abs(*m.Lat-44.5) > 1e-6 || math.Abs(*m.Lon-18.76) > 1e-6 {
		t.Errorf("gps %v %v", m.Lat, m.Lon)
	}
}

func TestReadMetaJPEG(t *testing.T) {
	b := cloudtest.JPEG(64, 48, 6)
	m, err := ReadMeta(bytes.NewReader(b), int64(len(b)), "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	checkMeta(t, m)
	if m.Width != 48 || m.Height != 64 { // orientation 6: shown upright, so portrait
		t.Errorf("size %dx%d", m.Width, m.Height)
	}
}

// box builds an ISO BMFF box.
func box4(typ string, payload ...[]byte) []byte {
	p := bytes.Join(payload, nil)
	b := make([]byte, 8)
	binary.BigEndian.PutUint32(b, uint32(8+len(p)))
	copy(b[4:], typ)
	return append(b, p...)
}

func u16(v uint16) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, v); return b }
func u32(v uint32) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, v); return b }

func TestReadMetaHEIC(t *testing.T) {
	tiff := cloudtest.ExifTIFF(1)
	exifItem := append(append(u32(6), "Exif\x00\x00"...), tiff...)
	infe := box4("infe", []byte{2, 0, 0, 0}, u16(2), u16(0), []byte("Exif"), []byte{0})
	infeHvc := box4("infe", []byte{2, 0, 0, 0}, u16(1), u16(0), []byte("hvc1"), []byte{0})
	iinf := box4("iinf", []byte{0, 0, 0, 0}, u16(2), infeHvc, infe)
	ispe := box4("ispe", []byte{0, 0, 0, 0}, u32(4032), u32(3024))
	ispeSmall := box4("ispe", []byte{0, 0, 0, 0}, u32(512), u32(512))
	iprp := box4("iprp", box4("ipco", ispeSmall, ispe))
	ftyp := box4("ftyp", []byte("heic"), u32(0), []byte("mif1heic"))
	// iloc v0, offset_size 4, length_size 4, base_offset_size 0; the Exif item is in mdat after meta.
	build := func(exifOff uint32) []byte {
		iloc := box4("iloc", []byte{0, 0, 0, 0, 0x44, 0x00}, u16(2),
			u16(1), u16(0), u16(1), u32(0), u32(10),
			u16(2), u16(0), u16(1), u32(exifOff), u32(uint32(len(exifItem))))
		meta := box4("meta", []byte{0, 0, 0, 0}, box4("hdlr", make([]byte, 24)), iinf, iloc, iprp)
		return append(ftyp, meta...)
	}
	head := build(0)
	file := build(uint32(len(head) + 8))
	file = append(file, box4("mdat", exifItem)...)
	m, err := ReadMeta(bytes.NewReader(file), int64(len(file)), "image/heic")
	if err != nil {
		t.Fatal(err)
	}
	checkMeta(t, m)
	if m.Width != 4032 || m.Height != 3024 {
		t.Errorf("size %dx%d", m.Width, m.Height)
	}
}

// sparse is a big file that is zeros except for a few regions — a 300 MB video without allocating it.
type sparse struct {
	size  int64
	parts map[int64][]byte
}

func (s *sparse) ReadAt(b []byte, off int64) (int, error) {
	if off >= s.size {
		return 0, io.EOF
	}
	n := len(b)
	if off+int64(n) > s.size {
		n = int(s.size - off)
	}
	for i := range b[:n] {
		b[i] = 0
	}
	for at, p := range s.parts {
		for i := 0; i < len(p); i++ {
			if pos := at + int64(i) - off; pos >= 0 && pos < int64(n) {
				b[pos] = p[i]
			}
		}
	}
	if n < len(b) {
		return n, io.EOF
	}
	return n, nil
}

// fakeProvider serves a sparse file through Range requests, counting them.
type fakeProvider struct{ f *sparse }

func (p *fakeProvider) Walk(context.Context, string, string, func(Entry) error) (string, bool, error) {
	return "", true, nil
}
func (p *fakeProvider) Thumb(context.Context, Entry, int) (*http.Response, error) {
	return nil, ErrNoThumb
}
func (p *fakeProvider) Get(_ context.Context, _ Entry, rng string) (*http.Response, error) {
	var a, b int64
	fmt.Sscanf(strings.TrimPrefix(rng, "bytes="), "%d-%d", &a, &b)
	if b >= p.f.size {
		b = p.f.size - 1
	}
	buf := make([]byte, b-a+1)
	p.f.ReadAt(buf, a)
	return &http.Response{StatusCode: 206, Body: io.NopCloser(bytes.NewReader(buf)), Header: http.Header{"Content-Length": {strconv.Itoa(len(buf))}}}, nil
}

func TestReadMetaQuickTimeMoovAtEnd(t *testing.T) {
	created := uint32(time.Date(2026, 7, 11, 18, 0, 0, 0, time.UTC).Unix() + 2082844800)
	mvhd := box4("mvhd", []byte{0, 0, 0, 0}, u32(created), u32(created), u32(600), u32(600*24), make([]byte, 80))
	tkhd := box4("tkhd", []byte{0, 0, 0, 0}, make([]byte, 72), u32(1920<<16), u32(1080<<16))
	xyz := box4("\xa9xyz", u16(18), u16(0x15c7), []byte("+43.2930+017.0200/"))
	keys := box4("keys", []byte{0, 0, 0, 0}, u32(1), u32(8+36), []byte("mdta"), []byte("com.apple.quicktime.location.ISO6709"))
	val := box4("data", u32(1), u32(0), []byte("+43.2931+017.0201+000.000/"))
	ilst := box4("ilst", append(u32(uint32(8+len(val))), append(u32(1), val...)...))
	moov := box4("moov", mvhd, box4("trak", tkhd), box4("udta", xyz), box4("meta", box4("hdlr", make([]byte, 24)), keys, ilst))
	ftyp := box4("ftyp", []byte("qt  "), u32(0), []byte("qt  "))
	const mdatSize = 300 << 20
	mdatHdr := append(u32(mdatSize), []byte("mdat")...)
	f := &sparse{size: int64(len(ftyp)) + mdatSize + int64(len(moov)), parts: map[int64][]byte{0: append(ftyp, mdatHdr...), int64(len(ftyp)) + mdatSize: moov}}
	rr := NewRangeReader(context.Background(), &fakeProvider{f}, Entry{Name: "clip.mov", Size: f.size})
	m, err := ReadMeta(rr, f.size, "video/quicktime")
	if err != nil {
		t.Fatal(err)
	}
	if !m.Taken.Equal(time.Date(2026, 7, 11, 18, 0, 0, 0, time.UTC)) || m.DurationMs != 24000 || m.Width != 1920 || m.Height != 1080 {
		t.Errorf("meta %+v", m)
	}
	if m.Lat == nil || math.Abs(*m.Lat-43.2931) > 1e-6 || math.Abs(*m.Lon-17.0201) > 1e-6 {
		t.Errorf("gps %v %v", m.Lat, m.Lon)
	}
	if rr.Fetches > 4 {
		t.Errorf("%d range requests for a 300 MB video; the moov should take a handful", rr.Fetches)
	}
}

func TestRenderTurnsSidewaysPhotosUpright(t *testing.T) {
	b := cloudtest.JPEG(80, 40, 6) // stored landscape, shown portrait (rotate 90° clockwise)
	out, err := Render(bytes.NewReader(b), 20, 0, 85)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if s := img.Bounds().Size(); s.X != 10 || s.Y != 20 {
		t.Fatalf("size %v, want 10x20", s)
	}
}

// AWS's published example: GET /test.txt with Range from examplebucket (Signature V4 docs).
func TestS3SignatureMatchesAWSExample(t *testing.T) {
	s := &S3{Region: "us-east-1", AccessKey: "AKIAIOSFODNN7EXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		now: func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) }, payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
	req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	s.sign(req)
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestMediaTypeAndRoot(t *testing.T) {
	for name, want := range map[string]bool{"IMG_0001.HEIC": true, "clip.MOV": true, "scan.pdf": false, "logo.svg": false, "x.dng": true} {
		if _, _, ok := MediaType(name, ""); ok != want {
			t.Errorf("%s: %v", name, ok)
		}
	}
	if !UnderRoot("Photos/2024/a.jpg", "/Photos/") || UnderRoot("Photoshop/a.jpg", "Photos") || !UnderRoot("a.jpg", "") {
		t.Error("UnderRoot")
	}
}
