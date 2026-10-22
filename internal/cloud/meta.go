package cloud

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ReadMeta reads a photo's or video's date, camera, size and GPS position from the file itself.
// It needs only a few small reads: EXIF sits at the start of a JPEG, in an item of a HEIC/AVIF, at the
// TIFF header of raw files; a video's moov box is found by hopping over box headers.
func ReadMeta(r io.ReaderAt, size int64, mime string) (*Meta, error) {
	head := make([]byte, 16)
	n, err := r.ReadAt(head, 0)
	if n < 12 {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	switch {
	case head[0] == 0xFF && head[1] == 0xD8:
		return readJPEG(r)
	case string(head[0:4]) == "II*\x00" || string(head[0:4]) == "MM\x00*":
		return readTIFF(r, 0)
	case string(head[4:8]) == "ftyp":
		brand := string(head[8:12])
		if strings.HasPrefix(brand, "hei") || strings.HasPrefix(brand, "mif") || strings.HasPrefix(brand, "avi") || brand == "msf1" || strings.HasPrefix(brand, "crx") {
			if m, err := readHEIF(r, size); err == nil {
				return m, nil
			} else if !strings.HasPrefix(mime, "video/") {
				return nil, err
			}
		}
		return readQuickTime(r, size)
	case string(head[4:8]) == "moov" || string(head[4:8]) == "mdat" || string(head[4:8]) == "wide" || string(head[4:8]) == "free":
		return readQuickTime(r, size)
	case string(head[0:8]) == "\x89PNG\r\n\x1a\n":
		return readPNG(r)
	}
	return nil, errors.New("no readable metadata in this format")
}

// ---- JPEG ----

func readJPEG(r io.ReaderAt) (*Meta, error) {
	var m *Meta
	w, h := 0, 0
	off := int64(2)
	for i := 0; i < 64; i++ {
		var hdr [4]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			break
		}
		if hdr[0] != 0xFF {
			break
		}
		marker := hdr[1]
		if marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			off += 2
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // start of scan: no more metadata
			break
		}
		seg := int64(binary.BigEndian.Uint16(hdr[2:]))
		if seg < 2 {
			break
		}
		switch {
		case marker == 0xE1 && m == nil:
			var sig [6]byte
			if _, err := r.ReadAt(sig[:], off+4); err == nil && string(sig[:]) == "Exif\x00\x00" {
				m, _ = readTIFF(r, off+10)
			}
		case marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC:
			var sof [5]byte
			if _, err := r.ReadAt(sof[:], off+4); err == nil {
				h, w = int(binary.BigEndian.Uint16(sof[1:3])), int(binary.BigEndian.Uint16(sof[3:5]))
			}
		}
		off += 2 + seg
	}
	if m == nil {
		m = &Meta{}
	}
	if w > 0 && h > 0 {
		m.Width, m.Height = w, h
	}
	if m.Orientation >= 5 && m.Orientation <= 8 && m.Width > 0 { // stored sideways, shown upright
		m.Width, m.Height = m.Height, m.Width
	}
	return m, nil
}

// ---- PNG (eXIf chunk) ----

func readPNG(r io.ReaderAt) (*Meta, error) {
	m := &Meta{}
	off := int64(8)
	for i := 0; i < 256; i++ {
		var hdr [8]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			break
		}
		l := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		switch typ {
		case "IHDR":
			var d [8]byte
			if _, err := r.ReadAt(d[:], off+8); err == nil {
				m.Width, m.Height = int(binary.BigEndian.Uint32(d[:4])), int(binary.BigEndian.Uint32(d[4:]))
			}
		case "eXIf":
			if x, err := readTIFF(r, off+8); err == nil {
				x.Width, x.Height = m.Width, m.Height
				return x, nil
			}
		case "IDAT", "IEND":
			return m, nil
		}
		off += 12 + l
	}
	return m, nil
}

// ---- TIFF / EXIF ----

type tiff struct {
	r    io.ReaderAt
	base int64
	bo   binary.ByteOrder
}

type ifdEntry struct {
	tag, typ uint16
	count    uint32
	raw      [4]byte
}

func readTIFF(r io.ReaderAt, base int64) (*Meta, error) {
	var hdr [8]byte
	if _, err := r.ReadAt(hdr[:], base); err != nil {
		return nil, err
	}
	t := &tiff{r: r, base: base}
	switch string(hdr[:2]) {
	case "II":
		t.bo = binary.LittleEndian
	case "MM":
		t.bo = binary.BigEndian
	default:
		return nil, errors.New("not a TIFF header")
	}
	m := &Meta{}
	ifd0, err := t.ifd(int64(t.bo.Uint32(hdr[4:])))
	if err != nil {
		return nil, err
	}
	var exifPtr, gpsPtr uint32
	var dateTime string
	for _, e := range ifd0 {
		switch e.tag {
		case 0x010F:
			m.Make = t.str(e)
		case 0x0110:
			m.Model = t.str(e)
		case 0x0112:
			m.Orientation = int(t.uint(e))
		case 0x0132:
			dateTime = t.str(e)
		case 0x8769:
			exifPtr = t.uint(e)
		case 0x8825:
			gpsPtr = t.uint(e)
		case 0x0100:
			m.Width = int(t.uint(e))
		case 0x0101:
			m.Height = int(t.uint(e))
		}
	}
	var original, digitized, offset string
	if exifPtr > 0 {
		if ex, err := t.ifd(int64(exifPtr)); err == nil {
			for _, e := range ex {
				switch e.tag {
				case 0x9003:
					original = t.str(e)
				case 0x9004:
					digitized = t.str(e)
				case 0x9011:
					offset = t.str(e)
				case 0xA002:
					m.Width = int(t.uint(e))
				case 0xA003:
					m.Height = int(t.uint(e))
				}
			}
		}
	}
	for _, s := range []string{original, digitized, dateTime} {
		if tm, ok := exifTime(s, offset); ok {
			m.Taken = tm
			break
		}
	}
	if gpsPtr > 0 {
		if g, err := t.ifd(int64(gpsPtr)); err == nil {
			var latRef, lonRef string
			var lat, lon []float64
			for _, e := range g {
				switch e.tag {
				case 1:
					latRef = t.str(e)
				case 2:
					lat = t.rationals(e)
				case 3:
					lonRef = t.str(e)
				case 4:
					lon = t.rationals(e)
				}
			}
			if la, ok := dms(lat, latRef, "S"); ok {
				if lo, ok := dms(lon, lonRef, "W"); ok && !(la == 0 && lo == 0) && math.Abs(la) <= 90 && math.Abs(lo) <= 180 {
					m.Lat, m.Lon = &la, &lo
				}
			}
		}
	}
	return m, nil
}

func (t *tiff) ifd(off int64) ([]ifdEntry, error) {
	var cnt [2]byte
	if _, err := t.r.ReadAt(cnt[:], t.base+off); err != nil {
		return nil, err
	}
	n := int(t.bo.Uint16(cnt[:]))
	if n == 0 || n > 512 {
		return nil, errors.New("implausible IFD")
	}
	buf := make([]byte, n*12)
	if _, err := t.r.ReadAt(buf, t.base+off+2); err != nil {
		return nil, err
	}
	out := make([]ifdEntry, n)
	for i := range out {
		b := buf[i*12:]
		out[i] = ifdEntry{tag: t.bo.Uint16(b[0:]), typ: t.bo.Uint16(b[2:]), count: t.bo.Uint32(b[4:])}
		copy(out[i].raw[:], b[8:12])
	}
	return out, nil
}

var typeSize = map[uint16]int{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}

func (t *tiff) data(e ifdEntry) []byte {
	sz := typeSize[e.typ] * int(e.count)
	if sz <= 0 || sz > 4096 {
		return nil
	}
	if sz <= 4 {
		return e.raw[:sz]
	}
	b := make([]byte, sz)
	if _, err := t.r.ReadAt(b, t.base+int64(t.bo.Uint32(e.raw[:]))); err != nil {
		return nil
	}
	return b
}

func (t *tiff) str(e ifdEntry) string {
	b := t.data(e)
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimSpace(string(b))
}

func (t *tiff) uint(e ifdEntry) uint32 {
	switch e.typ {
	case 3:
		return uint32(t.bo.Uint16(e.raw[:]))
	case 4, 9:
		return t.bo.Uint32(e.raw[:])
	case 1, 7:
		return uint32(e.raw[0])
	}
	return 0
}

func (t *tiff) rationals(e ifdEntry) []float64 {
	if e.typ != 5 && e.typ != 10 {
		return nil
	}
	b := t.data(e)
	out := []float64{}
	for i := 0; i+8 <= len(b); i += 8 {
		num, den := t.bo.Uint32(b[i:]), t.bo.Uint32(b[i+4:])
		if den == 0 {
			out = append(out, 0)
			continue
		}
		out = append(out, float64(num)/float64(den))
	}
	return out
}

func dms(v []float64, ref, neg string) (float64, bool) {
	if len(v) == 0 {
		return 0, false
	}
	d := v[0]
	if len(v) > 1 {
		d += v[1] / 60
	}
	if len(v) > 2 {
		d += v[2] / 3600
	}
	if strings.EqualFold(strings.TrimSpace(ref), neg) {
		d = -d
	}
	return d, true
}

// exifTime reads "2026:09:07 14:03:22" with the optional "+02:00" offset tag. Without an offset the
// wall-clock time is kept as if UTC, which is how Immich shows such photos too.
func exifTime(s, offset string) (time.Time, bool) {
	s = strings.TrimSpace(strings.TrimRight(s, "\x00"))
	if len(s) < 19 || strings.HasPrefix(s, "0000") {
		return time.Time{}, false
	}
	loc := time.UTC
	if o := strings.TrimSpace(offset); len(o) == 6 && (o[0] == '+' || o[0] == '-') {
		hh, _ := strconv.Atoi(o[1:3])
		mm, _ := strconv.Atoi(o[4:6])
		sec := hh*3600 + mm*60
		if o[0] == '-' {
			sec = -sec
		}
		loc = time.FixedZone(o, sec)
	}
	for _, f := range []string{"2006:01:02 15:04:05", "2006-01-02 15:04:05", "2006:01:02T15:04:05"} {
		if t, err := time.ParseInLocation(f, s[:19], loc); err == nil && t.Year() > 1900 {
			return t, true
		}
	}
	return time.Time{}, false
}

// ---- ISO base media: boxes ----

type box struct {
	typ        string
	start, end int64 // payload range
}

func readBox(r io.ReaderAt, off, limit int64) (box, error) {
	var h [16]byte
	if _, err := r.ReadAt(h[:8], off); err != nil {
		return box{}, err
	}
	size := int64(binary.BigEndian.Uint32(h[:4]))
	typ := string(h[4:8])
	hdr := int64(8)
	switch size {
	case 1:
		if _, err := r.ReadAt(h[8:16], off+8); err != nil {
			return box{}, err
		}
		size = int64(binary.BigEndian.Uint64(h[8:16]))
		hdr = 16
	case 0:
		size = limit - off
	}
	if size < hdr || (limit > 0 && off+size > limit+8) {
		return box{}, errors.New("bad box")
	}
	end := off + size
	if limit > 0 && end > limit {
		end = limit
	}
	return box{typ: typ, start: off + hdr, end: end}, nil
}

// children lists the boxes inside [start, end).
func children(r io.ReaderAt, start, end int64) []box {
	out := []box{}
	for off := start; off+8 <= end && len(out) < 512; {
		b, err := readBox(r, off, end)
		if err != nil {
			break
		}
		out = append(out, b)
		off = b.end
	}
	return out
}

func find(bs []box, typ string) (box, bool) {
	for _, b := range bs {
		if b.typ == typ {
			return b, true
		}
	}
	return box{}, false
}

func readN(r io.ReaderAt, off int64, n int) []byte {
	b := make([]byte, n)
	if _, err := r.ReadAt(b, off); err != nil {
		return nil
	}
	return b
}

// ---- HEIF / AVIF: the Exif item ----

func readHEIF(r io.ReaderAt, size int64) (*Meta, error) {
	top := children(r, 0, size)
	meta, ok := find(top, "meta")
	if !ok {
		return nil, errors.New("no meta box")
	}
	inner := children(r, meta.start+4, meta.end) // meta is a full box
	exifID := uint32(0)
	if iinf, ok := find(inner, "iinf"); ok {
		v := readN(r, iinf.start, 1)
		hdr := int64(6)
		if len(v) == 1 && v[0] == 0 {
			hdr = 6
		} else {
			hdr = 8
		}
		for _, infe := range children(r, iinf.start+hdr, iinf.end) {
			b := readN(r, infe.start, int(min64(infe.end-infe.start, 64)))
			if len(b) < 12 || infe.typ != "infe" {
				continue
			}
			ver := b[0]
			var id uint32
			var typ string
			if ver == 2 {
				id, typ = uint32(binary.BigEndian.Uint16(b[4:6])), string(b[8:12])
			} else if ver >= 3 {
				id, typ = binary.BigEndian.Uint32(b[4:8]), string(b[10:14])
			}
			if typ == "Exif" {
				exifID = id
				break
			}
		}
	}
	var m *Meta
	if exifID > 0 {
		if iloc, ok := find(inner, "iloc"); ok {
			if off, ok := ilocOffset(r, iloc, exifID); ok {
				if p := readN(r, off, 4); p != nil {
					skip := int64(binary.BigEndian.Uint32(p))
					m, _ = readTIFF(r, off+4+skip)
					if m == nil { // some writers put "Exif\0\0" first and count from there
						if sig := readN(r, off+4, 6); string(sig) == "Exif\x00\x00" {
							m, _ = readTIFF(r, off+10)
						}
					}
				}
			}
		}
	}
	if m == nil {
		m = &Meta{}
	}
	// Dimensions: the largest image spatial extent (the primary image; tiles and thumbnails are smaller).
	if iprp, ok := find(inner, "iprp"); ok {
		if ipco, ok := find(children(r, iprp.start, iprp.end), "ipco"); ok {
			w, h := 0, 0
			for _, p := range children(r, ipco.start, ipco.end) {
				if p.typ == "ispe" {
					if b := readN(r, p.start, 12); b != nil {
						pw, ph := int(binary.BigEndian.Uint32(b[4:8])), int(binary.BigEndian.Uint32(b[8:12]))
						if pw*ph > w*h {
							w, h = pw, ph
						}
					}
				}
			}
			if w > 0 {
				m.Width, m.Height = w, h
			}
		}
	}
	if m.Orientation >= 5 && m.Orientation <= 8 && m.Width > 0 {
		m.Width, m.Height = m.Height, m.Width
	}
	return m, nil
}

func ilocOffset(r io.ReaderAt, iloc box, want uint32) (int64, bool) {
	b := readN(r, iloc.start, int(min64(iloc.end-iloc.start, 64<<10)))
	if len(b) < 8 {
		return 0, false
	}
	ver := b[0]
	offSize, lenSize := int(b[4]>>4), int(b[4]&15)
	baseSize, idxSize := int(b[5]>>4), 0
	if ver == 1 || ver == 2 {
		idxSize = int(b[5] & 15)
	}
	p := 6
	rd := func(n int) (uint64, bool) {
		if p+n > len(b) {
			return 0, false
		}
		var v uint64
		for i := 0; i < n; i++ {
			v = v<<8 | uint64(b[p+i])
		}
		p += n
		return v, true
	}
	cntSize := 2
	if ver == 2 {
		cntSize = 4
	}
	count, ok := rd(cntSize)
	if !ok {
		return 0, false
	}
	for i := uint64(0); i < count; i++ {
		idSize := 2
		if ver == 2 {
			idSize = 4
		}
		id, ok := rd(idSize)
		if !ok {
			return 0, false
		}
		if ver == 1 || ver == 2 {
			if _, ok := rd(2); !ok {
				return 0, false
			}
		}
		if _, ok := rd(2); !ok { // data reference index
			return 0, false
		}
		base, _ := rd(baseSize)
		ext, ok := rd(2)
		if !ok {
			return 0, false
		}
		first := int64(-1)
		for j := uint64(0); j < ext; j++ {
			if idxSize > 0 {
				rd(idxSize)
			}
			off, _ := rd(offSize)
			if _, ok := rd(lenSize); !ok {
				return 0, false
			}
			if j == 0 {
				first = int64(base + off)
			}
		}
		if uint32(id) == want && first >= 0 {
			return first, true
		}
	}
	return 0, false
}

// ---- QuickTime / MP4 ----

var iso6709 = regexp.MustCompile(`^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)`)

func readQuickTime(r io.ReaderAt, size int64) (*Meta, error) {
	moov, ok := find(children(r, 0, size), "moov")
	if !ok {
		return nil, errors.New("no moov box")
	}
	m := &Meta{}
	in := children(r, moov.start, moov.end)
	if mvhd, ok := find(in, "mvhd"); ok {
		b := readN(r, mvhd.start, 32)
		if len(b) == 32 {
			var created, scale, dur uint64
			if b[0] == 1 {
				created, scale, dur = binary.BigEndian.Uint64(b[4:12]), uint64(binary.BigEndian.Uint32(b[20:24])), binary.BigEndian.Uint64(b[24:32])
			} else {
				created, scale, dur = uint64(binary.BigEndian.Uint32(b[4:8])), uint64(binary.BigEndian.Uint32(b[12:16])), uint64(binary.BigEndian.Uint32(b[16:20]))
			}
			const epoch1904 = 2082844800
			if created > epoch1904 {
				m.Taken = time.Unix(int64(created-epoch1904), 0).UTC()
			}
			if scale > 0 {
				m.DurationMs = int64(dur * 1000 / scale)
			}
		}
	}
	for _, trak := range in {
		if trak.typ != "trak" {
			continue
		}
		if tkhd, ok := find(children(r, trak.start, trak.end), "tkhd"); ok {
			b := readN(r, tkhd.start, int(min64(tkhd.end-tkhd.start, 96)))
			if len(b) >= 84 {
				w, h := int(binary.BigEndian.Uint32(b[len(b)-8:])>>16), int(binary.BigEndian.Uint32(b[len(b)-4:])>>16)
				if w*h > m.Width*m.Height {
					m.Width, m.Height = w, h
				}
			}
		}
	}
	// Location and a better creation date: udta ©xyz (most phones and cameras) and Apple's mdta keys.
	if udta, ok := find(in, "udta"); ok {
		for _, b := range children(r, udta.start, udta.end) {
			if b.typ == "\xa9xyz" {
				if d := readN(r, b.start+4, int(min64(b.end-b.start-4, 64))); d != nil {
					setISO6709(m, string(d))
				}
			}
		}
	}
	if meta, ok := find(in, "meta"); ok {
		inner := children(r, meta.start, meta.end)
		if _, isFull := find(inner, "hdlr"); !isFull {
			inner = children(r, meta.start+4, meta.end)
		}
		keys, ok1 := find(inner, "keys")
		ilst, ok2 := find(inner, "ilst")
		if ok1 && ok2 {
			names := map[uint32]string{}
			kb := readN(r, keys.start, int(min64(keys.end-keys.start, 16<<10)))
			if len(kb) >= 8 {
				n := binary.BigEndian.Uint32(kb[4:8])
				p := 8
				for i := uint32(1); i <= n && p+8 <= len(kb); i++ {
					l := int(binary.BigEndian.Uint32(kb[p:]))
					if l < 8 || p+l > len(kb) {
						break
					}
					names[i] = string(kb[p+8 : p+l])
					p += l
				}
			}
			for _, item := range children(r, ilst.start, ilst.end) {
				idx := binary.BigEndian.Uint32([]byte(item.typ))
				name := names[idx]
				if name != "com.apple.quicktime.location.ISO6709" && name != "com.apple.quicktime.creationdate" {
					continue
				}
				if data, ok := find(children(r, item.start, item.end), "data"); ok {
					v := readN(r, data.start+8, int(min64(data.end-data.start-8, 128)))
					switch name {
					case "com.apple.quicktime.location.ISO6709":
						setISO6709(m, string(v))
					case "com.apple.quicktime.creationdate":
						if t, err := time.Parse("2006-01-02T15:04:05-0700", string(v)); err == nil {
							m.Taken = t
						} else if t, err := time.Parse(time.RFC3339, string(v)); err == nil {
							m.Taken = t
						}
					}
				}
			}
		}
	}
	return m, nil
}

func setISO6709(m *Meta, s string) {
	g := iso6709.FindStringSubmatch(strings.TrimSpace(s))
	if g == nil {
		return
	}
	la, e1 := strconv.ParseFloat(g[1], 64)
	lo, e2 := strconv.ParseFloat(g[2], 64)
	if e1 == nil && e2 == nil && math.Abs(la) <= 90 && math.Abs(lo) <= 180 && !(la == 0 && lo == 0) {
		m.Lat, m.Lon = &la, &lo
	}
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
