package server

// The bundled Immich scans each new photo for faces (People), what is in it (smart search) and text
// (OCR) with its machine-learning part. A photo that arrives while that part is still downloading its
// models or the machine is overloaded (a Raspberry Pi installing apps) fails those scans once, and
// Immich doesn't try again: the photo never shows up under People. So Pocket Photos asks the bundled
// Immich, a minute or two after it is ready and then every half hour, to scan whatever is still missing.
// "start" without force only queues photos that lack the result, so it costs nothing when all is done.

import (
	"context"
	"time"
)

// The scans that need the machine-learning part, by Immich's queue names.
var catchUpQueues = []string{"faceDetection", "smartSearch", "ocr"}

const catchUpEvery = 30 * time.Minute

func (s *Server) scanCatchUpLoop(ctx context.Context) {
	// Look every minute until the bundled Immich is ready (on a Raspberry Pi that takes a few
	// minutes after a start), catch up a minute after that, then every half hour.
	var last time.Time
	readySince := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
		ready, _ := s.bundledReady()
		switch {
		case !ready:
			readySince = time.Time{}
		case readySince.IsZero():
			readySince = time.Now()
		case time.Since(last) >= catchUpEvery:
			s.catchUpScans(ctx)
			last = time.Now()
		}
	}
}

// catchUpScans queues the missing scans; a queue this Immich doesn't have is skipped quietly.
func (s *Server) catchUpScans(ctx context.Context) {
	pw := s.openKV(ctx, kvBundledAdmin)
	if pw == "" {
		return
	}
	auth, _, err := s.immichLogin(ctx, bundledAdminEmail, pw)
	if err != nil {
		s.log.Debug("scan catch-up: sign-in", "err", err)
		return
	}
	for _, q := range catchUpQueues {
		// PUT /jobs/{name} (Immich marks it deprecated since 2.4 but has no other "start missing").
		code, err := s.immichCall(ctx, "PUT", "/jobs/"+q, auth, map[string]any{"command": "start", "force": false}, nil)
		if err != nil && code != 400 && code != 404 {
			s.log.Warn("scan catch-up", "queue", q, "err", err)
		}
	}
}
