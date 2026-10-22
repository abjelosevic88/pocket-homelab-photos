package server

// Clouds: index the photos in a person's other clouds in place (docs/clouds.md). Accounts and their
// items belong to one person; every lookup takes their id, so somebody else's ids are "not found".

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/abjelosevic88/pocket-homelab-photos/internal/cloud"
	"github.com/abjelosevic88/pocket-homelab-photos/internal/store"
)

var cloudKinds = []struct{ Kind, Name string }{
	{"nextcloud", "Nextcloud"}, {"webdav", "WebDAV"}, {"s3", "S3 bucket"},
	{"gdrive", "Google Drive"}, {"onedrive", "OneDrive"}, {"dropbox", "Dropbox"},
}

func cloudName(kind string) string {
	for _, k := range cloudKinds {
		if k.Kind == kind {
			return k.Name
		}
	}
	return kind
}

func oauthKind(kind string) bool { return kind == "gdrive" || kind == "onedrive" || kind == "dropbox" }

type cloudField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Secret      bool   `json:"secret,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Help        string `json:"help,omitempty"`
	Optional    bool   `json:"optional,omitempty"`
}

// Which of the form fields are not secret and go into the account's config.
var cloudConfigKeys = map[string][]string{
	"nextcloud": {"url", "username"}, "webdav": {"url", "username"}, "s3": {"endpoint", "region", "bucket", "access_key"},
}
var cloudSecretKeys = map[string][]string{"nextcloud": {"password"}, "webdav": {"password"}, "s3": {"secret_key"}}

func (s *Server) cloudFields(kind string) []cloudField {
	switch kind {
	case "nextcloud":
		return []cloudField{
			{Key: "url", Label: "Nextcloud address", Placeholder: "https://cloud.example.com"},
			{Key: "username", Label: "User name"},
			{Key: "password", Label: "App password", Secret: true, Help: "Nextcloud → Personal settings → Security → Devices & sessions → Create new app password."},
		}
	case "webdav":
		return []cloudField{
			{Key: "url", Label: "WebDAV address", Placeholder: "https://dav.example.com/remote.php/webdav/", Help: "The address of the folder tree, as a WebDAV client would use it."},
			{Key: "username", Label: "User name"},
			{Key: "password", Label: "Password", Secret: true},
		}
	case "s3":
		return []cloudField{
			{Key: "endpoint", Label: "Endpoint", Placeholder: "https://s3.eu-central-003.backblazeb2.com", Help: "The S3 API address (AWS: https://s3.<region>.amazonaws.com)."},
			{Key: "region", Label: "Region", Placeholder: "eu-central-003", Optional: true},
			{Key: "bucket", Label: "Bucket"},
			{Key: "access_key", Label: "Access key ID"},
			{Key: "secret_key", Label: "Secret access key", Secret: true, Help: "A read-only key is enough."},
		}
	}
	return []cloudField{}
}

func (s *Server) oauthApp(kind string) *cloud.OAuthApp {
	c := s.cfg
	switch kind {
	case "gdrive":
		if c.GoogleClientID != "" && c.GoogleClientSecret != "" {
			return cloud.GoogleApp(c.GoogleClientID, c.GoogleClientSecret)
		}
	case "onedrive":
		if c.MicrosoftClientID != "" && c.MicrosoftClientSecret != "" {
			return cloud.MicrosoftApp(c.MicrosoftClientID, c.MicrosoftClientSecret, c.MicrosoftTenant)
		}
	case "dropbox":
		if c.DropboxAppKey != "" && c.DropboxAppSecret != "" {
			return cloud.DropboxApp(c.DropboxAppKey, c.DropboxAppSecret)
		}
	}
	return nil
}

func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.BaseURL != "" {
		return s.cfg.BaseURL
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) oauthRedirect(r *http.Request, kind string) string {
	return s.baseURL(r) + "/api/v1/clouds/oauth/" + kind + "/callback"
}

func (s *Server) oauthHelp(r *http.Request, kind string) string {
	redirect := s.oauthRedirect(r, kind)
	switch kind {
	case "gdrive":
		return "Google Drive needs an OAuth client of your own: in console.cloud.google.com enable the Google Drive API, set up the OAuth consent screen (External, and publish it — in Testing Google drops the sign-in after 7 days), create an OAuth client ID of type Web application with the redirect URI " + redirect + " , then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Pocket Photos and restart it."
	case "onedrive":
		return "OneDrive needs an app registration: in entra.microsoft.com → App registrations → New registration (accounts in any organizational directory and personal Microsoft accounts), add the Web redirect URI " + redirect + " , create a client secret under Certificates & secrets, then set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET for Pocket Photos and restart it."
	case "dropbox":
		return "Dropbox needs an app: in dropbox.com/developers/apps create a Scoped access app with Full Dropbox access, tick files.metadata.read and files.content.read under Permissions, add the redirect URI " + redirect + " , then set DROPBOX_APP_KEY and DROPBOX_APP_SECRET for Pocket Photos and restart it."
	}
	return ""
}

type cloudSetup struct {
	Console     string   `json:"console"` // where the box owner registers the app
	ConsoleName string   `json:"console_name"`
	Steps       []string `json:"steps"`
	RedirectURI string   `json:"redirect_uri"`
	Env         []string `json:"env"`
}

func (s *Server) oauthSetup(r *http.Request, kind string) *cloudSetup {
	redirect := s.oauthRedirect(r, kind)
	switch kind {
	case "gdrive":
		return &cloudSetup{Console: "https://console.cloud.google.com/apis/credentials", ConsoleName: "Google Cloud console", RedirectURI: redirect,
			Env: []string{"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"}, Steps: []string{
				"Create a project (or reuse one) and enable the Google Drive API under APIs & Services → Library.",
				"Set up the OAuth consent screen as External and publish it — in Testing, Google drops the sign-in after 7 days.",
				"Under Credentials, create an OAuth client ID of type Web application and add the redirect URI below.",
				"Set the client ID and secret for Pocket Photos and restart it."}}
	case "onedrive":
		return &cloudSetup{Console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", ConsoleName: "Microsoft Entra admin center", RedirectURI: redirect,
			Env: []string{"MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"}, Steps: []string{
				"New registration: accounts in any organizational directory and personal Microsoft accounts.",
				"Add a Web platform with the redirect URI below.",
				"Under Certificates & secrets, create a client secret.",
				"Set the application (client) ID and the secret for Pocket Photos and restart it."}}
	case "dropbox":
		return &cloudSetup{Console: "https://www.dropbox.com/developers/apps", ConsoleName: "Dropbox App Console", RedirectURI: redirect,
			Env: []string{"DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"}, Steps: []string{
				"Create app: Scoped access, Full Dropbox.",
				"Under Permissions, tick files.metadata.read and files.content.read, then Submit.",
				"Under Settings, add the redirect URI below.",
				"Set the app key and secret for Pocket Photos and restart it."}}
	}
	return nil
}

func (s *Server) handleCloudProviders(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, k := range cloudKinds {
		p := map[string]any{"kind": k.Kind, "name": k.Name, "configured": true, "fields": s.cloudFields(k.Kind), "help": ""}
		switch {
		case oauthKind(k.Kind):
			p["auth"] = "oauth"
			p["configured"] = s.oauthApp(k.Kind) != nil
			p["help"] = s.oauthHelp(r, k.Kind)
			p["setup"] = s.oauthSetup(r, k.Kind)
		case k.Kind == "nextcloud" && s.core.Configured():
			p["auth"] = "core"
			p["help"] = "Uses the Nextcloud login Pocket Core keeps for you. Or connect directly with an app password."
		default:
			p["auth"] = "form"
		}
		out = append(out, p)
	}
	writeJSON(w, 200, out)
}

// ---- accounts ----

type cloudAccountView struct {
	*store.CloudAccount
	Scan       *scanView `json:"scan,omitempty"`
	NextScanAt string    `json:"next_scan_at,omitempty"`
}

type scanView struct {
	Seen    int64 `json:"seen"`
	Indexed int64 `json:"indexed"`
}

func (s *Server) accountView(a *store.CloudAccount) cloudAccountView {
	v := cloudAccountView{CloudAccount: a}
	if st := s.scans.get(a.ID); st != nil {
		v.Scan = &scanView{Seen: st.seen.Load(), Indexed: st.indexed.Load()}
		a.Status = "scanning"
	}
	if a.LastScanAt != nil {
		if t, err := time.Parse("2006-01-02T15:04:05.999Z", *a.LastScanAt); err == nil {
			v.NextScanAt = t.Add(s.scanEvery()).UTC().Format(time.RFC3339)
		}
	}
	return v
}

func (s *Server) handleListClouds(w http.ResponseWriter, r *http.Request) {
	s.adoptCoreNextcloud(r.Context(), userFrom(r.Context()))
	list, err := s.store.ListCloudAccounts(r.Context(), userFrom(r.Context()).ID)
	if err != nil {
		s.fail(w, err, "list clouds")
		return
	}
	out := make([]cloudAccountView, len(list))
	for i, a := range list {
		out[i] = s.accountView(a)
	}
	writeJSON(w, 200, out)
}

func (s *Server) cloudAccount(w http.ResponseWriter, r *http.Request) *store.CloudAccount {
	a, err := s.store.GetCloudAccount(r.Context(), userFrom(r.Context()).ID, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "cloud account")
		return nil
	}
	return a
}

// splitFields stores the non-secret fields as config and seals the rest.
func (s *Server) splitFields(kind string, fields map[string]string, old *store.CloudAccount) (cfg, sealed string, err error) {
	conf := map[string]string{}
	sec := map[string]string{}
	if old != nil {
		_ = json.Unmarshal([]byte(old.Config), &conf)
		if old.Secret != "" {
			if plain, err := s.open(old.Secret); err == nil {
				_ = json.Unmarshal([]byte(plain), &sec)
			}
		}
	}
	for _, k := range cloudConfigKeys[kind] {
		if v, ok := fields[k]; ok {
			conf[k] = strings.TrimSpace(v)
		}
	}
	for _, k := range cloudSecretKeys[kind] {
		if v, ok := fields[k]; ok && v != "" { // an empty secret on edit keeps the stored one
			sec[k] = v
		}
	}
	b, _ := json.Marshal(conf)
	sb, _ := json.Marshal(sec)
	if sealed, err = s.seal(string(sb)); err != nil {
		return "", "", err
	}
	return string(b), sealed, nil
}

// The person's Nextcloud from Pocket Core shows up by itself, the way Pocket Files and Documents do:
// when Core lets Photos use it and the person has not connected it yet, Photos adds it (whole
// Nextcloud, via Core) and starts the first scan. Removing it is remembered, so it does not come back
// unless the person adds it again.
const coreNextcloudKey = "clouds.core_nextcloud"

func (s *Server) adoptCoreNextcloud(ctx context.Context, u *store.User) {
	if u == nil || !s.core.Configured() || s.store.UserSetting(ctx, u.ID, coreNextcloudKey) != "" {
		return
	}
	s.adoptMu.Lock()
	defer s.adoptMu.Unlock()
	if s.adoptTried == nil {
		s.adoptTried = map[int64]time.Time{}
	}
	if t, ok := s.adoptTried[u.ID]; ok && time.Since(t) < 10*time.Minute { // the list is polled; ask Core rarely
		return
	}
	s.adoptTried[u.ID] = time.Now()
	list, err := s.store.ListCloudAccounts(ctx, u.ID)
	if err != nil {
		return
	}
	for _, a := range list {
		if a.Kind == "nextcloud" && a.Via == "core" {
			_ = s.store.SetUserSetting(ctx, u.ID, coreNextcloudKey, "added")
			return
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	a := &store.CloudAccount{UserID: u.ID, Kind: "nextcloud", Name: "Nextcloud", Via: "core", Config: "{}"}
	p, login, err := s.cloudProviderFor(cctx, a, u)
	if err != nil {
		s.log.Debug("no Nextcloud from Core for this person", "user", u.Email, "error", err)
		return
	}
	if pr, ok := p.(prober); ok {
		if err := pr.Probe(cctx, ""); err != nil {
			s.log.Warn("Nextcloud from Core does not answer", "user", u.Email, "error", err)
			return
		}
	}
	a.Login = login
	if err := s.store.CreateCloudAccount(ctx, a); err != nil {
		return
	}
	_ = s.store.SetUserSetting(ctx, u.ID, coreNextcloudKey, "added")
	s.log.Info("added the Nextcloud Pocket Core links for this person", "user", u.Email, "account", a.ID)
	s.startScan(a.ID)
}

type prober interface {
	Probe(ctx context.Context, root string) error
}

func (s *Server) handleCreateCloud(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var in struct {
		Kind   string            `json:"kind"`
		Name   string            `json:"name"`
		Root   string            `json:"root"`
		Via    string            `json:"via"`
		Fields map[string]string `json:"fields"`
	}
	if decode(r, &in) != nil {
		writeErr(w, 400, "invalid account")
		return
	}
	if oauthKind(in.Kind) {
		writeErr(w, 400, "connect "+cloudName(in.Kind)+" with its sign-in page")
		return
	}
	if _, ok := cloudConfigKeys[in.Kind]; !ok {
		writeErr(w, 400, "kind is nextcloud, webdav, s3, gdrive, onedrive or dropbox")
		return
	}
	a := &store.CloudAccount{UserID: u.ID, Kind: in.Kind, Name: strings.TrimSpace(in.Name), Root: cleanRoot(in.Root)}
	if in.Kind == "nextcloud" && in.Via == "core" {
		if !s.core.Configured() {
			writeErr(w, 400, "Pocket Core is not configured on this box — connect Nextcloud with its address and an app password")
			return
		}
		a.Via, a.Config = "core", "{}"
	} else {
		if in.Fields == nil {
			in.Fields = map[string]string{}
		}
		for _, f := range s.cloudFields(in.Kind) {
			if !f.Optional && strings.TrimSpace(in.Fields[f.Key]) == "" {
				writeErr(w, 400, f.Label+" is needed")
				return
			}
		}
		for _, k := range []string{"url", "endpoint"} {
			if v := in.Fields[k]; v != "" {
				if pu, err := url.Parse(strings.TrimSpace(v)); err != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" || pu.User != nil {
					writeErr(w, 400, "the address must start with https:// (or http://)")
					return
				}
			}
		}
		var err error
		if a.Config, a.Secret, err = s.splitFields(in.Kind, in.Fields, nil); err != nil {
			s.fail(w, err, "seal account")
			return
		}
		a.Login = strings.TrimSpace(firstNonEmpty(in.Fields["username"], in.Fields["access_key"]))
	}
	if a.Name == "" {
		a.Name = cloudName(in.Kind)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	p, login, err := s.cloudProviderFor(ctx, a, u)
	if err == nil {
		if pr, ok := p.(prober); ok {
			err = pr.Probe(ctx, a.Root)
		}
	}
	if err != nil {
		writeErr(w, 400, "could not connect: "+err.Error())
		return
	}
	if login != "" {
		a.Login = login
	}
	if err := s.store.CreateCloudAccount(r.Context(), a); err != nil {
		s.fail(w, err, "create cloud")
		return
	}
	if a.Kind == "nextcloud" && a.Via == "core" {
		_ = s.store.SetUserSetting(r.Context(), u.ID, coreNextcloudKey, "added")
	}
	s.startScan(a.ID)
	writeJSON(w, 201, s.accountView(a))
}

func cleanRoot(root string) string {
	parts := []string{}
	for _, p := range strings.Split(strings.ReplaceAll(root, "\\", "/"), "/") {
		if p = strings.TrimSpace(p); p != "" && p != "." && p != ".." {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "/")
}

func (s *Server) handleUpdateCloud(w http.ResponseWriter, r *http.Request) {
	a := s.cloudAccount(w, r)
	if a == nil {
		return
	}
	var in struct {
		Name   *string           `json:"name"`
		Root   *string           `json:"root"`
		Fields map[string]string `json:"fields"`
	}
	if decode(r, &in) != nil {
		writeErr(w, 400, "invalid account")
		return
	}
	rescan := false
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		a.Name = strings.TrimSpace(*in.Name)
	}
	if in.Root != nil && cleanRoot(*in.Root) != a.Root {
		a.Root = cleanRoot(*in.Root)
		rescan = true
	}
	if len(in.Fields) > 0 && !oauthKind(a.Kind) && a.Via != "core" {
		var err error
		if a.Config, a.Secret, err = s.splitFields(a.Kind, in.Fields, a); err != nil {
			s.fail(w, err, "seal account")
			return
		}
		if v := firstNonEmpty(in.Fields["username"], in.Fields["access_key"]); v != "" {
			a.Login = v
		}
		rescan = true
	}
	if rescan {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		p, _, err := s.cloudProviderFor(ctx, a, userFrom(r.Context()))
		if err == nil {
			if pr, ok := p.(prober); ok {
				err = pr.Probe(ctx, a.Root)
			}
		}
		if err != nil {
			writeErr(w, 400, "could not connect: "+err.Error())
			return
		}
	}
	if err := s.store.UpdateCloudAccount(r.Context(), a); err != nil {
		s.fail(w, err, "update cloud")
		return
	}
	if rescan {
		s.scans.stop(a.ID)
		_ = s.store.SetCloudCursor(r.Context(), a.ID, "") // a new folder needs a full listing
		_ = s.store.SetCloudStatus(r.Context(), a.ID, "idle", "", false)
		s.startScan(a.ID)
	}
	a, _ = s.store.GetCloudAccount(r.Context(), a.UserID, a.ID)
	a.Counts, _ = s.store.CloudCounts(r.Context(), a.ID)
	writeJSON(w, 200, s.accountView(a))
}

func (s *Server) handleDeleteCloud(w http.ResponseWriter, r *http.Request) {
	a := s.cloudAccount(w, r)
	if a == nil {
		return
	}
	s.scans.stop(a.ID)
	if err := s.store.DeleteCloudAccount(r.Context(), a.UserID, a.ID); err != nil {
		s.fail(w, err, "delete cloud")
		return
	}
	_ = os.RemoveAll(s.thumbDir(a.ID))
	if a.Kind == "nextcloud" && a.Via == "core" {
		_ = s.store.SetUserSetting(r.Context(), a.UserID, coreNextcloudKey, "removed")
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleScanCloud(w http.ResponseWriter, r *http.Request) {
	a := s.cloudAccount(w, r)
	if a == nil {
		return
	}
	if a.Status == "reconnect" && oauthKind(a.Kind) {
		writeErr(w, 409, "connect the account again first")
		return
	}
	s.startScan(a.ID)
	a.Counts, _ = s.store.CloudCounts(r.Context(), a.ID)
	writeJSON(w, 202, s.accountView(a))
}

// ---- providers ----

func (s *Server) cloudHTTP() *http.Client {
	s.cloudClientOnce.Do(func() {
		// Unlike the Immich client this one follows redirects (OneDrive downloads redirect to a
		// pre-signed URL); Go drops the Authorization header when a redirect leaves the host.
		s.cloudClient = &http.Client{Transport: s.http.Transport, Timeout: 30 * time.Minute}
	})
	return s.cloudClient
}

// cloudProviderFor builds the provider for an account; login is the account's user as the cloud sees it.
func (s *Server) cloudProviderFor(ctx context.Context, a *store.CloudAccount, owner *store.User) (cloud.Provider, string, error) {
	conf := map[string]string{}
	_ = json.Unmarshal([]byte(a.Config), &conf)
	sec := map[string]string{}
	if a.Secret != "" && !oauthKind(a.Kind) {
		plain, err := s.open(a.Secret)
		if err != nil {
			return nil, "", errors.New("the stored password cannot be opened (secret.key changed?) — enter it again")
		}
		_ = json.Unmarshal([]byte(plain), &sec)
	}
	hc := s.cloudHTTP()
	switch a.Kind {
	case "nextcloud":
		origin, user, pass := conf["url"], conf["username"], sec["password"]
		if a.Via == "core" {
			if owner == nil {
				var err error
				if owner, err = s.store.GetUser(ctx, a.UserID); err != nil {
					return nil, "", err
				}
			}
			cred, err := s.core.ServiceFor(ctx, owner.Email, "nextcloud")
			if err != nil {
				return nil, "", fmt.Errorf("Pocket Core has no Nextcloud for you: %w", err)
			}
			origin, user = cred.URL, cred.Fields["USERNAME"]
			pass = firstNonEmpty(cred.Fields["APP_PASSWORD"], cred.Fields["PASSWORD"], cred.Key)
			if origin == "" || user == "" || pass == "" {
				return nil, "", errors.New("Pocket Core has no Nextcloud login for you (address, user name and app password) — add it there, or connect directly")
			}
		}
		origin = strings.TrimRight(origin, "/")
		return &cloud.WebDAV{Base: cloud.NextcloudDAV(origin, user), User: user, Password: pass, Nextcloud: origin, HTTP: hc}, user, nil
	case "webdav":
		base := conf["url"]
		if !strings.HasSuffix(base, "/") {
			base += "/"
		}
		return &cloud.WebDAV{Base: base, User: conf["username"], Password: sec["password"], HTTP: hc}, conf["username"], nil
	case "s3":
		return &cloud.S3{Endpoint: conf["endpoint"], Region: conf["region"], Bucket: conf["bucket"], AccessKey: conf["access_key"], SecretKey: sec["secret_key"], HTTP: hc}, conf["access_key"], nil
	case "gdrive", "onedrive", "dropbox":
		app := s.oauthApp(a.Kind)
		if app == nil {
			return nil, "", fmt.Errorf("%s is not set up on this box", cloudName(a.Kind))
		}
		var tok cloud.Token
		if a.Secret != "" {
			plain, err := s.open(a.Secret)
			if err != nil {
				return nil, "", &cloud.AuthError{Msg: "the stored sign-in cannot be opened — connect the account again"}
			}
			_ = json.Unmarshal([]byte(plain), &tok)
		}
		id := a.ID
		auth := cloud.NewAuthed(app, hc, &tok, func(t *cloud.Token) error {
			b, _ := json.Marshal(t)
			sealed, err := s.seal(string(b))
			if err != nil {
				return err
			}
			return s.store.SetCloudSecret(context.Background(), id, sealed)
		})
		switch a.Kind {
		case "gdrive":
			return &cloud.GoogleDrive{A: auth}, a.Login, nil
		case "onedrive":
			return &cloud.OneDrive{A: auth}, a.Login, nil
		default:
			return &cloud.Dropbox{A: auth}, a.Login, nil
		}
	}
	return nil, "", fmt.Errorf("unknown cloud %q", a.Kind)
}

// ---- OAuth sign-in ----

const cloudOAuthCookie = "pp_cloud_oauth"

func (s *Server) handleCloudOAuthStart(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	kind := chi.URLParam(r, "kind")
	app := s.oauthApp(kind)
	if !oauthKind(kind) {
		writeErr(w, 404, "unknown cloud")
		return
	}
	if app == nil {
		writeErr(w, 400, s.oauthHelp(r, kind))
		return
	}
	accID, _ := strconv.ParseInt(r.URL.Query().Get("account"), 10, 64)
	hint := ""
	if accID > 0 {
		a, err := s.store.GetCloudAccount(r.Context(), u.ID, accID)
		if err != nil || a.Kind != kind {
			writeErr(w, 404, "not found")
			return
		}
		hint = a.Login
	}
	state := store.RandomToken(16)
	payload := fmt.Sprintf("%s|%d|%d|%s|%d", state, u.ID, accID, kind, time.Now().Unix())
	http.SetCookie(w, &http.Cookie{Name: cloudOAuthCookie, Value: base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + s.sign(payload),
		Path: "/api/v1/clouds/oauth", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 900})
	target := app.AuthCodeURL(s.oauthRedirect(r, kind), state, hint)
	if r.URL.Query().Get("json") != "" {
		writeJSON(w, 200, map[string]string{"url": target})
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (s *Server) cloudSettingsURL(r *http.Request, id int64, msg string) string {
	q := url.Values{"tab": {"sources"}}
	if id > 0 {
		q.Set("cloud", strconv.FormatInt(id, 10))
	}
	if msg != "" {
		q.Set("error", msg)
	}
	return s.baseURL(r) + "/settings?" + q.Encode()
}

func (s *Server) handleCloudOAuthCallback(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	kind := chi.URLParam(r, "kind")
	back := func(id int64, msg string) {
		http.SetCookie(w, &http.Cookie{Name: cloudOAuthCookie, Path: "/api/v1/clouds/oauth", MaxAge: -1, HttpOnly: true, Secure: s.cfg.SecureCookies})
		http.Redirect(w, r, s.cloudSettingsURL(r, id, msg), http.StatusFound)
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		back(0, cloudName(kind)+" did not connect: "+firstNonEmpty(q.Get("error_description"), e))
		return
	}
	c, err := r.Cookie(cloudOAuthCookie)
	if err != nil {
		back(0, "the sign-in took too long or started in another browser — try again")
		return
	}
	val, sig, _ := strings.Cut(c.Value, ".")
	raw, derr := base64.RawURLEncoding.DecodeString(val)
	parts := strings.Split(string(raw), "|")
	if derr != nil || sig == "" || s.sign(string(raw)) != sig || len(parts) != 5 {
		back(0, "the sign-in could not be verified — try again")
		return
	}
	at, _ := strconv.ParseInt(parts[4], 10, 64)
	uid, _ := strconv.ParseInt(parts[1], 10, 64)
	accID, _ := strconv.ParseInt(parts[2], 10, 64)
	if parts[0] != q.Get("state") || parts[3] != kind || uid != u.ID || time.Since(time.Unix(at, 0)) > 15*time.Minute {
		back(0, "the sign-in could not be verified — try again")
		return
	}
	app := s.oauthApp(kind)
	if app == nil {
		back(0, cloudName(kind)+" is not set up on this box")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	tok, err := app.Exchange(ctx, s.cloudHTTP(), q.Get("code"), s.oauthRedirect(r, kind))
	if err != nil {
		back(0, err.Error())
		return
	}
	if tok.RefreshToken == "" {
		back(0, cloudName(kind)+" gave no lasting sign-in (refresh token) — remove Pocket Photos from the account's connected apps and connect again")
		return
	}
	b, _ := json.Marshal(tok)
	sealed, err := s.seal(string(b))
	if err != nil {
		back(0, "could not store the sign-in")
		return
	}
	var a *store.CloudAccount
	if accID > 0 {
		if a, err = s.store.GetCloudAccount(r.Context(), u.ID, accID); err != nil || a.Kind != kind {
			back(0, "that account is gone")
			return
		}
		a.Secret = sealed
	} else {
		a = &store.CloudAccount{UserID: u.ID, Kind: kind, Name: cloudName(kind), Config: "{}", Secret: sealed}
	}
	p, _, err := s.cloudProviderFor(ctx, a, u)
	if err != nil {
		back(0, err.Error())
		return
	}
	type loginer interface {
		Login(context.Context) (string, error)
	}
	if l, ok := p.(loginer); ok {
		if login, err := l.Login(ctx); err == nil && login != "" {
			a.Login = login
		} else if err != nil {
			back(0, "connected, but "+cloudName(kind)+" did not answer: "+err.Error())
			return
		}
	}
	if accID > 0 {
		if err := s.store.UpdateCloudAccount(r.Context(), a); err != nil {
			back(0, "could not save the account")
			return
		}
		_ = s.store.SetCloudStatus(r.Context(), a.ID, "idle", "", false)
	} else {
		if a.Login != "" {
			a.Name = cloudName(kind) + " · " + a.Login
		}
		if err := s.store.CreateCloudAccount(r.Context(), a); err != nil {
			back(0, "could not save the account")
			return
		}
	}
	s.startScan(a.ID)
	back(a.ID, "")
}

// ---- scanning ----

type scanState struct {
	seen, indexed atomic.Int64
	cancel        context.CancelFunc
}

type cloudScans struct {
	mu      sync.Mutex
	running map[int64]*scanState
	slots   chan struct{}
}

func (c *cloudScans) get(id int64) *scanState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running[id]
}

func (c *cloudScans) stop(id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if st := c.running[id]; st != nil {
		st.cancel()
		delete(c.running, id)
	}
}

func (s *Server) startScan(id int64) bool {
	s.scans.mu.Lock()
	if s.scans.running == nil {
		s.scans.running = map[int64]*scanState{}
		s.scans.slots = make(chan struct{}, 2)
	}
	if s.scans.running[id] != nil {
		s.scans.mu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(s.bg)
	st := &scanState{cancel: cancel}
	s.scans.running[id] = st
	slots := s.scans.slots
	s.scans.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			s.scans.mu.Lock()
			if s.scans.running[id] == st {
				delete(s.scans.running, id)
			}
			s.scans.mu.Unlock()
		}()
		select { // two accounts at a time across the box
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			return
		}
		s.runScan(ctx, id, st)
	}()
	return true
}

func (s *Server) runScan(ctx context.Context, id int64, st *scanState) {
	a, err := s.store.CloudAccountByID(ctx, id)
	if err != nil {
		return
	}
	finish := func(err error) {
		if ctx.Err() != nil && !errors.Is(err, context.DeadlineExceeded) {
			return // stopped on purpose (account removed or changed)
		}
		switch {
		case err == nil:
			_ = s.store.SetCloudStatus(context.Background(), id, "idle", "", true)
		case errors.Is(err, cloud.ErrReconnect):
			_ = s.store.SetCloudStatus(context.Background(), id, "reconnect", err.Error(), true)
		default:
			s.log.Warn("cloud scan", "account", id, "kind", a.Kind, "error", err)
			_ = s.store.SetCloudStatus(context.Background(), id, "error", err.Error(), true)
		}
	}
	_ = s.store.SetCloudStatus(ctx, id, "scanning", "", false)
	p, _, err := s.cloudProviderFor(ctx, a, nil)
	if err != nil {
		finish(err)
		return
	}
	scanNo := time.Now().UnixNano()
	// Metadata is read while the listing is still going, so a large cloud fills in from the first
	// minute instead of after the whole walk.
	ictx, stopIndex := context.WithCancel(ctx)
	defer stopIndex()
	walkDone := make(chan struct{})
	indexed := make(chan error, 1)
	go func() { indexed <- s.indexWhileWalking(ictx, p, id, st, walkDone) }()
	next, full, err := p.Walk(ctx, a.Root, a.Cursor, func(e cloud.Entry) error {
		if e.Deleted {
			return s.store.DeleteCloudItemByRemote(ctx, id, e.ID)
		}
		if !worthIndexing(e) {
			return nil
		}
		it := entryItem(id, e)
		_, err := s.store.UpsertCloudItem(ctx, it, scanNo)
		st.seen.Add(1)
		return err
	})
	close(walkDone)
	if err != nil {
		stopIndex()
		<-indexed
		finish(err)
		return
	}
	if err := <-indexed; err != nil {
		finish(err)
		return
	}
	if full {
		if _, err := s.store.PruneCloudItems(ctx, id, scanNo); err != nil {
			finish(err)
			return
		}
	}
	_ = s.store.SetCloudCursor(ctx, id, next)
	s.geocodePending(ctx, a)
	finish(nil)
}

// Folders that hold app and system files, never anybody's photos.
var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, ".svn": true, "vendor": true, "__macosx": true, ".thumbnails": true, ".thumbs": true,
	"@eadir": true, "#recycle": true, ".trash": true, ".trashes": true, ".cache": true, "cache": true, "thumbnails": true,
	".stfolder": true, ".stversions": true, "appdata": true, "site-packages": true, ".npm": true, ".gradle": true,
}

// worthIndexing keeps photos and videos and leaves out what only looks like one: icons, sprites and
// thumbnails (images under 64 KiB — a camera photo is hundreds of KB) and files in app/system folders.
func worthIndexing(e cloud.Entry) bool {
	for _, seg := range strings.Split(strings.ToLower(e.Path), "/") {
		if skipDirs[seg] {
			return false
		}
	}
	_, video, _ := cloud.MediaType(e.Name, e.Mime)
	if e.Size > 0 && !video && e.Size < 64<<10 {
		return false
	}
	return true
}

func entryItem(accountID int64, e cloud.Entry) *store.CloudItem {
	_, video, _ := cloud.MediaType(e.Name, e.Mime)
	it := &store.CloudItem{AccountID: accountID, RemoteID: e.ID, Path: e.Path, Name: e.Name, Mime: e.Mime, Size: e.Size, ETag: e.ETag,
		WebURL: e.WebURL, ThumbRef: e.ThumbRef, Video: video}
	if !e.Modified.IsZero() {
		it.ModifiedAt = e.Modified.UTC().Format(time.RFC3339)
	}
	if e.Meta != nil {
		applyMeta(it, e.Meta)
		it.Indexed = true
	}
	return it
}

func applyMeta(it *store.CloudItem, m *cloud.Meta) {
	if !m.Taken.IsZero() {
		it.TakenAt = m.Taken.Format(time.RFC3339)
	}
	if m.Width > 0 && m.Height > 0 {
		it.Width, it.Height = m.Width, m.Height
	}
	if m.Lat != nil && m.Lon != nil {
		la, lo := math.Round(*m.Lat*1e6)/1e6, math.Round(*m.Lon*1e6)/1e6
		it.Lat, it.Lon = &la, &lo
	}
	if c := m.Camera(); c != "" {
		it.Camera = c
	}
	if m.DurationMs > 0 {
		it.DurationMs = m.DurationMs
	}
}

func itemEntry(it *store.CloudItem) cloud.Entry {
	e := cloud.Entry{ID: it.RemoteID, Path: it.Path, Name: it.Name, Mime: it.Mime, Size: it.Size, ETag: it.ETag, WebURL: it.WebURL, ThumbRef: it.ThumbRef}
	e.Modified, _ = time.Parse(time.RFC3339, it.ModifiedAt)
	return e
}

// indexWhileWalking keeps reading metadata of newly listed items until the walk has ended and
// nothing is left.
func (s *Server) indexWhileWalking(ctx context.Context, p cloud.Provider, id int64, st *scanState, walkDone <-chan struct{}) error {
	if n, err := s.store.CountCloudIndexed(ctx, id); err == nil {
		st.indexed.Store(int64(n))
	}
	for {
		if err := s.indexPending(ctx, p, id, st); err != nil {
			return err
		}
		select {
		case <-walkDone:
			return s.indexPending(ctx, p, id, st) // what the last pages of the listing added
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// indexPending reads the metadata of every item the listing did not describe, four at a time.
func (s *Server) indexPending(ctx context.Context, p cloud.Provider, id int64, st *scanState) error {
	for {
		batch, err := s.store.CloudItemsToIndex(ctx, id, 64)
		if err != nil || len(batch) == 0 {
			return err
		}
		var wg sync.WaitGroup
		var authErr atomic.Value
		sem := make(chan struct{}, 4)
		for _, it := range batch {
			if ctx.Err() != nil {
				break
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(it *store.CloudItem) {
				defer wg.Done()
				defer func() { <-sem }()
				rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
				defer cancel()
				rr := cloud.NewRangeReader(rctx, p, itemEntry(it))
				m, err := cloud.ReadMeta(rr, it.Size, it.Mime)
				msg := ""
				if err != nil {
					if errors.Is(err, cloud.ErrReconnect) {
						authErr.Store(err)
						return
					}
					msg = err.Error()
				} else {
					applyMeta(it, m)
				}
				if ctx.Err() == nil {
					_ = s.store.SaveCloudMeta(ctx, it, msg)
					st.indexed.Add(1)
				}
			}(it)
		}
		wg.Wait()
		if v := authErr.Load(); v != nil {
			return v.(error)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
}

// geocodePending names the places of located items with the owner's Immich (its offline reverse
// geocoder, the same names the rest of the library uses). Without an Immich connection the items
// keep their coordinates and simply have no place name.
func (s *Server) geocodePending(ctx context.Context, a *store.CloudAccount) {
	owner, err := s.store.GetUser(ctx, a.UserID)
	if err != nil {
		return
	}
	c, err := s.connection(ctx, owner)
	if err != nil {
		return
	}
	for {
		batch, err := s.store.CloudItemsToGeocode(ctx, a.ID, 200)
		if err != nil || len(batch) == 0 || ctx.Err() != nil {
			return
		}
		for _, it := range batch {
			key := fmt.Sprintf("%.2f,%.2f", *it.Lat, *it.Lon)
			city, country, ok := s.store.Geocache(ctx, key)
			if !ok {
				city, country, err = s.reverseGeocode(ctx, c, *it.Lat, *it.Lon)
				if err != nil {
					return // Immich unreachable or too old: try again with the next scan
				}
				_ = s.store.PutGeocache(ctx, key, city, country)
			}
			_ = s.store.SetCloudPlace(ctx, it.ID, city, country)
		}
	}
}

func (s *Server) reverseGeocode(ctx context.Context, c *connection, lat, lon float64) (string, string, error) {
	res, err := s.upstream(ctx, c, "GET", fmt.Sprintf("/map/reverse-geocode?lat=%f&lon=%f", lat, lon), nil, nil)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", "", fmt.Errorf("reverse geocode: %s", res.Status)
	}
	var out []struct {
		City    string `json:"city"`
		State   string `json:"state"`
		Country string `json:"country"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		return "", "", err
	}
	if len(out) == 0 {
		return "", "", nil
	}
	return firstNonEmpty(out[0].City, out[0].State), out[0].Country, nil
}

func (s *Server) scanEvery() time.Duration {
	if s.cfg.CloudScanEvery <= 0 {
		return 6 * time.Hour
	}
	return s.cfg.CloudScanEvery
}

// cloudLoop rescans every account whose last scan is older than CLOUD_SCAN_INTERVAL, and picks up
// scans a restart interrupted.
func (s *Server) cloudLoop(ctx context.Context) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for first := true; ; first = false {
		if !first {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
		list, err := s.store.ListCloudAccounts(ctx, 0)
		if err != nil {
			continue
		}
		for _, a := range list {
			if a.Status == "reconnect" {
				continue
			}
			due := a.LastScanAt == nil || a.Status == "scanning"
			if a.LastScanAt != nil {
				if t, err := time.Parse("2006-01-02T15:04:05.999Z", *a.LastScanAt); err == nil && time.Since(t) > s.scanEvery() {
					due = true
				}
			}
			if due {
				s.startScan(a.ID)
			}
		}
	}
}

// ---- items ----

func hasThumb(a *store.CloudAccount, it *store.CloudItem) bool {
	switch a.Kind {
	case "gdrive", "onedrive", "dropbox":
		return true
	case "nextcloud":
		if it.ThumbRef != "" {
			return true
		}
	}
	return !it.Video && cloud.Decodable(it.Mime) && it.Size <= cloud.MaxDecode
}

func (s *Server) handleCloudItems(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q := r.URL.Query()
	cq := store.CloudQuery{UserID: u.ID, Filter: q.Get("filter"), Type: q.Get("type"), Q: q.Get("q"), Asc: q.Get("order") == "asc", Cursor: q.Get("cursor")}
	cq.Limit, _ = strconv.Atoi(q.Get("limit"))
	accounts := map[int64]*store.CloudAccount{}
	if v := q.Get("account"); v != "" {
		id, _ := strconv.ParseInt(v, 10, 64)
		a, err := s.store.GetCloudAccount(r.Context(), u.ID, id)
		if err != nil {
			s.fail(w, err, "cloud account")
			return
		}
		cq.AccountID = id
		accounts[id] = a
	}
	items, next, total, err := s.store.ListCloudItems(r.Context(), cq)
	if err != nil {
		if err.Error() == "bad cursor" {
			writeErr(w, 400, "bad cursor")
			return
		}
		s.fail(w, err, "list cloud items")
		return
	}
	for _, it := range items {
		a := accounts[it.AccountID]
		if a == nil {
			if a, err = s.store.GetCloudAccount(r.Context(), u.ID, it.AccountID); err != nil {
				continue
			}
			accounts[it.AccountID] = a
		}
		it.HasThumb = hasThumb(a, it)
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": next, "total": total})
}

func (s *Server) cloudItem(w http.ResponseWriter, r *http.Request) (*store.CloudItem, *store.CloudAccount) {
	it, a, err := s.store.GetCloudItem(r.Context(), userFrom(r.Context()).ID, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "cloud item")
		return nil, nil
	}
	it.HasThumb = hasThumb(a, it)
	return it, a
}

func (s *Server) handleCloudItem(w http.ResponseWriter, r *http.Request) {
	if it, _ := s.cloudItem(w, r); it != nil {
		writeJSON(w, 200, it)
	}
}

func (s *Server) handleCloudMap(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.URL.Query().Get("account"), 10, 64)
	pts, err := s.store.CloudMap(r.Context(), userFrom(r.Context()).ID, id)
	if err != nil {
		s.fail(w, err, "cloud map")
		return
	}
	writeJSON(w, 200, pts)
}

func (s *Server) thumbDir(accountID int64) string {
	return filepath.Join(s.cfg.DataDir, "cloud-thumbs", strconv.FormatInt(accountID, 10))
}

const thumbSize = 400

func (s *Server) handleCloudThumb(w http.ResponseWriter, r *http.Request) {
	it, a := s.cloudItem(w, r)
	if it == nil {
		return
	}
	sum := sha1.Sum([]byte(it.ETag + "|" + strconv.FormatInt(it.Size, 10)))
	base := filepath.Join(s.thumbDir(a.ID), fmt.Sprintf("%d-%s", it.ID, hex.EncodeToString(sum[:6])))
	if b, err := os.ReadFile(base + ".jpg"); err == nil {
		serveImage(w, b)
		return
	}
	if _, err := os.Stat(base + ".none"); err == nil {
		writeErr(w, 404, "no thumbnail for this file")
		return
	}
	select {
	case s.thumbSlots <- struct{}{}:
		defer func() { <-s.thumbSlots }()
	case <-r.Context().Done():
		return
	}
	b, err := s.makeThumb(r.Context(), a, it, thumbSize, 80)
	if err != nil {
		if errors.Is(err, cloud.ErrNoThumb) {
			_ = os.MkdirAll(filepath.Dir(base), 0o755)
			_ = os.WriteFile(base+".none", nil, 0o644)
			writeErr(w, 404, "no thumbnail for this file")
			return
		}
		if errors.Is(err, cloud.ErrReconnect) {
			writeErr(w, 409, err.Error())
			return
		}
		writeErr(w, 502, "the thumbnail could not be made: "+err.Error())
		return
	}
	_ = os.MkdirAll(filepath.Dir(base), 0o755)
	_ = os.WriteFile(base+".jpg", b, 0o644)
	serveImage(w, b)
}

// makeThumb asks the cloud for its rendering, or renders the image itself when the cloud has none.
func (s *Server) makeThumb(ctx context.Context, a *store.CloudAccount, it *store.CloudItem, size, quality int) ([]byte, error) {
	p, _, err := s.cloudProviderFor(ctx, a, nil)
	if err != nil {
		return nil, err
	}
	e := itemEntry(it)
	res, err := p.Thumb(ctx, e, size)
	if err == nil {
		defer res.Body.Close()
		// normalise the cloud's rendering to an upright JPEG of our size
		if b, err := cloud.Render(res.Body, size, 0, quality); err == nil {
			return b, nil
		}
		return nil, errors.New("the cloud's thumbnail could not be read")
	}
	if !errors.Is(err, cloud.ErrNoThumb) {
		return nil, err
	}
	if it.Video || !cloud.Decodable(it.Mime) || it.Size > cloud.MaxDecode {
		return nil, cloud.ErrNoThumb
	}
	res, err = p.Get(ctx, e, "")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("download: %s", res.Status)
	}
	return cloud.Render(res.Body, size, 0, quality)
}

func serveImage(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
}

// handleCloudPreview answers a browser-safe image to look at: the original when it already is one
// (and not huge), else the cloud's large rendering, else one Photos renders.
func (s *Server) handleCloudPreview(w http.ResponseWriter, r *http.Request) {
	it, a := s.cloudItem(w, r)
	if it == nil {
		return
	}
	if !it.Video && cloud.WebSafe(it.Mime) && it.Size <= 25<<20 {
		s.streamCloud(w, r, a, it, false)
		return
	}
	ctx := r.Context()
	p, _, err := s.cloudProviderFor(ctx, a, nil)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	if res, err := p.Thumb(ctx, itemEntry(it), 2048); err == nil {
		defer res.Body.Close()
		ct := res.Header.Get("Content-Type")
		if !strings.HasPrefix(ct, "image/") {
			ct = "image/jpeg"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = io.Copy(w, io.LimitReader(res.Body, 32<<20))
		return
	} else if !errors.Is(err, cloud.ErrNoThumb) {
		writeErr(w, 502, err.Error())
		return
	}
	if !it.Video && cloud.Decodable(it.Mime) && it.Size <= cloud.MaxDecode {
		select {
		case s.thumbSlots <- struct{}{}:
			defer func() { <-s.thumbSlots }()
		case <-ctx.Done():
			return
		}
		b, err := s.makeThumb(ctx, a, it, 2048, 85)
		if err == nil {
			serveImage(w, b)
			return
		}
	}
	writeErr(w, 415, "this cloud shows no preview of "+strings.TrimPrefix(it.Mime, "image/")+" files — download the original to look at it")
}

func (s *Server) handleCloudOriginal(w http.ResponseWriter, r *http.Request) {
	it, a := s.cloudItem(w, r)
	if it == nil {
		return
	}
	s.streamCloud(w, r, a, it, true)
}

func (s *Server) streamCloud(w http.ResponseWriter, r *http.Request, a *store.CloudAccount, it *store.CloudItem, download bool) {
	ctx := r.Context()
	p, _, err := s.cloudProviderFor(ctx, a, nil)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	res, err := p.Get(ctx, itemEntry(it), r.Header.Get("Range"))
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 206 {
		writeErr(w, 502, "the cloud answered "+res.Status)
		return
	}
	h := w.Header()
	h.Set("Content-Type", it.Mime)
	for _, k := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := res.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	if h.Get("Accept-Ranges") == "" && res.StatusCode == 206 {
		h.Set("Accept-Ranges", "bytes")
	}
	disp := "inline"
	if download {
		disp = "attachment"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": it.Name}))
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

func (s *Server) handleCloudImport(w http.ResponseWriter, r *http.Request) {
	it, a := s.cloudItem(w, r)
	if it == nil {
		return
	}
	ctx := r.Context()
	c, err := s.connection(ctx, userFrom(ctx))
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	p, _, err := s.cloudProviderFor(ctx, a, nil)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	res, err := p.Get(ctx, itemEntry(it), "")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		writeErr(w, 502, "the cloud answered "+res.Status)
		return
	}
	created, _ := time.Parse(time.RFC3339, firstNonEmpty(it.TakenAt, it.ModifiedAt))
	modified, _ := time.Parse(time.RFC3339, it.ModifiedAt)
	up, err := s.uploadToImmich(ctx, c, it.Name, res.Body, created, modified)
	if err != nil {
		writeErr(w, 502, "import failed; the file in the cloud was left unchanged")
		return
	}
	defer up.Body.Close()
	if up.StatusCode != 200 && up.StatusCode != 201 {
		relay(w, up)
		return
	}
	var out struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	_ = json.NewDecoder(io.LimitReader(up.Body, 64<<10)).Decode(&out)
	status := "imported"
	if out.Status == "duplicate" {
		status = "duplicate"
	}
	_ = s.store.SetCloudImport(ctx, it.ID, status, out.ID)
	writeJSON(w, 200, map[string]string{"status": status, "asset_id": out.ID})
}
