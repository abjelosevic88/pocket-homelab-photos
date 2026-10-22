// Package cloudtest builds test photos with real EXIF for the cloud tests.
package cloudtest

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
)

// ExifTIFF builds a big-endian TIFF block: IFD0 (Make, Model, Orientation, Exif and GPS pointers),
// the Exif IFD (DateTimeOriginal, OffsetTimeOriginal) and the GPS IFD (44°30'0" N, 18°45'36" E).
func ExifTIFF(orientation uint16) []byte {
	bo := binary.BigEndian
	var data bytes.Buffer // out-of-line values, placed after the IFDs
	const ifd0, exifIFD, gpsIFD, dataStart = 8, 8 + 2 + 6*12 + 4, 8 + 2 + 6*12 + 4 + 2 + 2*12 + 4, 8 + 2 + 6*12 + 4 + 2 + 2*12 + 4 + 2 + 4*12 + 4
	put := func(b []byte) uint32 { off := dataStart + data.Len(); data.Write(b); return uint32(off) }
	entry := func(w *bytes.Buffer, tag, typ uint16, count uint32, val uint32, inline []byte) {
		var e [12]byte
		bo.PutUint16(e[0:], tag)
		bo.PutUint16(e[2:], typ)
		bo.PutUint32(e[4:], count)
		if inline != nil {
			copy(e[8:], inline)
		} else {
			bo.PutUint32(e[8:], val)
		}
		w.Write(e[:])
	}
	rat := func(v ...[2]uint32) []byte {
		b := make([]byte, 8*len(v))
		for i, r := range v {
			bo.PutUint32(b[i*8:], r[0])
			bo.PutUint32(b[i*8+4:], r[1])
		}
		return b
	}
	var ifds bytes.Buffer
	ifds.Write([]byte{0, 6})
	entry(&ifds, 0x010F, 2, 6, put([]byte("Apple\x00")), nil)
	entry(&ifds, 0x0110, 2, 18, put([]byte("iPhone 15 Pro\x00\x00\x00\x00\x00")), nil)
	o := make([]byte, 4)
	bo.PutUint16(o, orientation)
	entry(&ifds, 0x0112, 3, 1, 0, o)
	entry(&ifds, 0x0132, 2, 20, put([]byte("2001:01:01 00:00:00\x00")), nil)
	entry(&ifds, 0x8769, 4, 1, exifIFD, nil)
	entry(&ifds, 0x8825, 4, 1, gpsIFD, nil)
	ifds.Write([]byte{0, 0, 0, 0})
	ifds.Write([]byte{0, 2})
	entry(&ifds, 0x9003, 2, 20, put([]byte("2026:09:07 14:03:22\x00")), nil)
	entry(&ifds, 0x9011, 2, 7, put([]byte("+02:00\x00")), nil)
	ifds.Write([]byte{0, 0, 0, 0})
	ifds.Write([]byte{0, 4})
	entry(&ifds, 1, 2, 2, 0, []byte("N\x00"))
	entry(&ifds, 2, 5, 3, put(rat([2]uint32{44, 1}, [2]uint32{30, 1}, [2]uint32{0, 1})), nil)
	entry(&ifds, 3, 2, 2, 0, []byte("E\x00"))
	entry(&ifds, 4, 5, 3, put(rat([2]uint32{18, 1}, [2]uint32{45, 1}, [2]uint32{3600, 100})), nil)
	ifds.Write([]byte{0, 0, 0, 0})
	if 8+ifds.Len() != dataStart {
		panic(fmt.Sprintf("layout: %d != %d", 8+ifds.Len(), dataStart))
	}
	out := []byte{'M', 'M', 0, 42, 0, 0, 0, ifd0}
	out = append(out, ifds.Bytes()...)
	return append(out, data.Bytes()...)
}

// JPEG is a w×h test photo carrying ExifTIFF: Apple iPhone 15 Pro, 2026-09-07 14:03:22 +02:00, 44.5 N 18.76 E.
func JPEG(w, h int, orientation uint16) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			// deterministic noise, so the JPEG is the size of a real photo (a few hundred KB), not an icon
			n := uint32(x*73856093 ^ y*19349663)
			n ^= n >> 13
			n *= 0x5bd1e995
			img.Set(x, y, color.RGBA{uint8(x) ^ uint8(n), uint8(y) ^ uint8(n>>8), uint8(n >> 16), 255})
		}
	}
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var enc bytes.Buffer
	if err := jpeg.Encode(&enc, img, &jpeg.Options{Quality: 90}); err != nil {
		panic(err)
	}
	b := enc.Bytes()
	tiff := ExifTIFF(orientation)
	app1 := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(2+6+len(tiff)))
	app1 = append(append(app1, "Exif\x00\x00"...), tiff...)
	return append(append([]byte{0xFF, 0xD8}, app1...), b[2:]...)
}
