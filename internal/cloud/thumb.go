package cloud

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// MaxDecode is the largest file Photos downloads to render a thumbnail itself.
const MaxDecode = 48 << 20

// Render scales an image so its longer side is at most size pixels, upright, as a JPEG.
// orientation is the EXIF orientation (1–8; 0 = read it from the data when it is a JPEG).
func Render(src io.Reader, size, orientation int, quality int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(src, MaxDecode+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxDecode {
		return nil, errors.New("too large to render")
	}
	if orientation == 0 && len(data) > 2 && data[0] == 0xFF && data[1] == 0xD8 {
		if m, err := readJPEG(bytes.NewReader(data)); err == nil {
			orientation = m.Orientation
		}
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width*cfg.Height > 120_000_000 {
		return nil, errors.New("too many pixels to render")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > size || h > size {
		if w >= h {
			w, h = size, max(1, h*size/w)
		} else {
			w, h = max(1, w*size/h), size
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src) // transparent PNGs on white
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Over, nil)
	out := orient(dst, orientation)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// orient turns an image stored sideways or mirrored (EXIF orientation 2–8) upright.
func orient(src *image.RGBA, o int) image.Image {
	if o < 2 || o > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var nx, ny int
			switch o {
			case 2:
				nx, ny = w-1-x, y
			case 3:
				nx, ny = w-1-x, h-1-y
			case 4:
				nx, ny = x, h-1-y
			case 5:
				nx, ny = y, x
			case 6:
				nx, ny = h-1-y, x
			case 7:
				nx, ny = h-1-y, w-1-x
			case 8:
				nx, ny = y, w-1-x
			}
			i, j := src.PixOffset(x, y), dst.PixOffset(nx, ny)
			copy(dst.Pix[j:j+4], src.Pix[i:i+4])
		}
	}
	return dst
}
