package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

// Pocket Core app links (docs/links.md in pocket-homelab-core), Photos as the
// target: another Pocket app the person allowed in Core (Pocket Photo Lab)
// may act here for them with a pcx_ token, only within these scopes. Every
// route not listed in linkRoutes stays closed to it (403).

var linkOffers = []core.Offer{
	{Scope: "photos:read", Name: "See your photos", Description: "Browse and search your photo library and open thumbnails and originals (Pocket Photo Lab picks pictures to edit). Nothing is changed."},
	{Scope: "photos:write", Name: "Add photos", Description: "Add new photos to your library (Pocket Photo Lab saves edited copies there). It cannot change or delete the photos you have."},
}

type linkRoute struct {
	methods string
	path    *regexp.Regexp
	scope   string // "" = any linked app
}

var linkRoutes = []linkRoute{
	{"GET", regexp.MustCompile(`^/api/v1/auth/me$`), ""},
	{"GET", regexp.MustCompile(`^/api/v1/immich/(users/me|timeline/(buckets|bucket)|albums)$`), "photos:read"},
	{"POST", regexp.MustCompile(`^/api/v1/immich/search/(metadata|smart|random)$`), "photos:read"},
	{"GET", regexp.MustCompile(`^/api/v1/immich/assets/[a-fA-F0-9-]{36}(/(thumbnail|original))?$`), "photos:read"},
	{"POST", regexp.MustCompile(`^/api/v1/immich/assets$`), "photos:write"},
}

var errLinkScope = errors.New("outside the link's scope")

// linkAllows reports whether a link token with these scopes may make this request.
func linkAllows(scopes []string, r *http.Request) bool {
	for _, lr := range linkRoutes {
		if !strings.Contains(" "+lr.methods+" ", " "+r.Method+" ") || !lr.path.MatchString(r.URL.Path) {
			continue
		}
		if lr.scope == "" {
			return true
		}
		for _, sc := range scopes {
			if sc == lr.scope {
				return true
			}
		}
	}
	return false
}

// linkUser validates a pcx_ token, checks the route against its scopes and
// maps it to the person it acts for.
func (s *Server) linkUser(ctx context.Context, tok string, r *http.Request) (*store.User, error) {
	in, err := s.core.Introspect(ctx, tok)
	if err != nil {
		return nil, err
	}
	if !in.Active || !in.Delegated() || in.Audience != "photos" || in.User == nil || in.User.Email == "" || in.App == nil || in.App.Slug == "" {
		return nil, http.ErrNoCookie
	}
	if !linkAllows(strings.Fields(in.Scope), r) {
		return nil, errLinkScope
	}
	return s.coreIdentityUser(ctx, in)
}

// sibling addresses from Core, cached a minute ("Edit in Photo Lab").
var siblingCache = struct {
	sync.Mutex
	m map[string]siblingURL
}{m: map[string]siblingURL{}}

type siblingURL struct {
	url string
	at  time.Time
}

func (s *Server) siblingURL(ctx context.Context, slug string) string {
	if !s.core.Configured() {
		return ""
	}
	siblingCache.Lock()
	if v, ok := siblingCache.m[slug]; ok && time.Since(v.at) < time.Minute {
		siblingCache.Unlock()
		return v.url
	}
	siblingCache.Unlock()
	url := ""
	if res, err := s.core.Resolve(ctx, slug); err == nil {
		url = res.PublicURL
		if url == "" {
			url = res.URL
		}
	}
	siblingCache.Lock()
	siblingCache.m[slug] = siblingURL{url, time.Now()}
	siblingCache.Unlock()
	return url
}
