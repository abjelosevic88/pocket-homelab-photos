package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Token is what an OAuth account keeps (sealed) between requests.
type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	Expiry       time.Time `json:"expiry"`
}

// OAuthApp is one provider's OAuth endpoints plus the box owner's client registration.
type OAuthApp struct {
	Kind         string
	AuthURL      string
	TokenURL     string
	Scopes       string
	ClientID     string
	ClientSecret string
	Extra        url.Values // provider-specific authorize parameters
}

// Endpoints of the three OAuth clouds; tests point them at fakes.
var Endpoints = struct {
	GoogleAuth, GoogleToken, GoogleAPI, GoogleUser        string
	MSAuth, MSToken, Graph                                string
	DropboxAuth, DropboxToken, DropboxAPI, DropboxContent string
}{
	GoogleAuth: "https://accounts.google.com/o/oauth2/v2/auth", GoogleToken: "https://oauth2.googleapis.com/token",
	GoogleAPI: "https://www.googleapis.com", GoogleUser: "https://openidconnect.googleapis.com/v1/userinfo",
	MSAuth: "https://login.microsoftonline.com/%s/oauth2/v2.0/authorize", MSToken: "https://login.microsoftonline.com/%s/oauth2/v2.0/token",
	Graph:       "https://graph.microsoft.com/v1.0",
	DropboxAuth: "https://www.dropbox.com/oauth2/authorize", DropboxToken: "https://api.dropboxapi.com/oauth2/token",
	DropboxAPI: "https://api.dropboxapi.com/2", DropboxContent: "https://content.dropboxapi.com/2",
}

func GoogleApp(id, secret string) *OAuthApp {
	return &OAuthApp{Kind: "gdrive", AuthURL: Endpoints.GoogleAuth, TokenURL: Endpoints.GoogleToken, ClientID: id, ClientSecret: secret,
		Scopes: "openid email https://www.googleapis.com/auth/drive.readonly",
		Extra:  url.Values{"access_type": {"offline"}, "prompt": {"consent"}, "include_granted_scopes": {"true"}}}
}

func MicrosoftApp(id, secret, tenant string) *OAuthApp {
	if tenant == "" {
		tenant = "common"
	}
	return &OAuthApp{Kind: "onedrive", AuthURL: fmt.Sprintf(Endpoints.MSAuth, tenant), TokenURL: fmt.Sprintf(Endpoints.MSToken, tenant),
		ClientID: id, ClientSecret: secret, Scopes: "offline_access User.Read Files.Read", Extra: url.Values{"prompt": {"select_account"}}}
}

func DropboxApp(key, secret string) *OAuthApp {
	return &OAuthApp{Kind: "dropbox", AuthURL: Endpoints.DropboxAuth, TokenURL: Endpoints.DropboxToken, ClientID: key, ClientSecret: secret,
		Scopes: "account_info.read files.metadata.read files.content.read", Extra: url.Values{"token_access_type": {"offline"}}}
}

// AuthCodeURL is where the browser goes to sign in.
func (a *OAuthApp) AuthCodeURL(redirect, state, loginHint string) string {
	q := url.Values{"client_id": {a.ClientID}, "redirect_uri": {redirect}, "response_type": {"code"}, "scope": {a.Scopes}, "state": {state}}
	for k, v := range a.Extra {
		q[k] = v
	}
	if loginHint != "" && a.Kind != "dropbox" {
		q.Set("login_hint", loginHint)
	}
	sep := "?"
	if strings.Contains(a.AuthURL, "?") {
		sep = "&"
	}
	return a.AuthURL + sep + q.Encode()
}

func (a *OAuthApp) Exchange(ctx context.Context, hc *http.Client, code, redirect string) (*Token, error) {
	return a.token(ctx, hc, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}})
}

func (a *OAuthApp) Refresh(ctx context.Context, hc *http.Client, refresh string) (*Token, error) {
	t, err := a.token(ctx, hc, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err == nil && t.RefreshToken == "" {
		t.RefreshToken = refresh // Google and Dropbox keep the old one; Microsoft rotates it
	}
	return t, err
}

func (a *OAuthApp) token(ctx context.Context, hc *http.Client, form url.Values) (*Token, error) {
	form.Set("client_id", a.ClientID)
	form.Set("client_secret", a.ClientSecret)
	if a.Kind == "onedrive" && form.Get("grant_type") == "refresh_token" {
		form.Set("scope", a.Scopes)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", a.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		Description  string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &out)
	if res.StatusCode != 200 || out.AccessToken == "" {
		if out.Error == "invalid_grant" || res.StatusCode == 400 && form.Get("grant_type") == "refresh_token" {
			return nil, &AuthError{"the cloud no longer accepts this sign-in (" + firstNonEmpty(out.Description, out.Error, res.Status) + ") — connect the account again"}
		}
		return nil, fmt.Errorf("sign-in failed: %s", firstNonEmpty(out.Description, out.Error, res.Status))
	}
	t := &Token{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken}
	if out.ExpiresIn > 0 {
		t.Expiry = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	}
	return t, nil
}

// Authed sends requests with a fresh access token, refreshing it (and saving the new one) when it is
// about to expire or the API says it has.
type Authed struct {
	App  *OAuthApp
	HTTP *http.Client
	Save func(*Token) error
	mu   sync.Mutex
	tok  *Token
}

func NewAuthed(app *OAuthApp, hc *http.Client, t *Token, save func(*Token) error) *Authed {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Authed{App: app, HTTP: hc, Save: save, tok: t}
}

func (a *Authed) access(ctx context.Context, force bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.tok == nil {
		return "", &AuthError{"no sign-in stored — connect the account again"}
	}
	if !force && a.tok.AccessToken != "" && (a.tok.Expiry.IsZero() || time.Until(a.tok.Expiry) > time.Minute) {
		return a.tok.AccessToken, nil
	}
	if a.tok.RefreshToken == "" {
		return "", &AuthError{"the sign-in expired and cannot be renewed — connect the account again"}
	}
	t, err := a.App.Refresh(ctx, a.HTTP, a.tok.RefreshToken)
	if err != nil {
		return "", err
	}
	a.tok = t
	if a.Save != nil {
		if err := a.Save(t); err != nil {
			return "", err
		}
	}
	return t.AccessToken, nil
}

// Do sends req (whose body, if any, must be re-readable via GetBody) with the bearer token.
func (a *Authed) Do(req *http.Request) (*http.Response, error) {
	for attempt := 0; attempt < 2; attempt++ {
		tok, err := a.access(req.Context(), attempt > 0)
		if err != nil {
			return nil, err
		}
		r := req.Clone(req.Context())
		if req.GetBody != nil {
			r.Body, _ = req.GetBody()
		}
		r.Header.Set("Authorization", "Bearer "+tok)
		res, err := a.HTTP.Do(r)
		if err != nil {
			return nil, err
		}
		if res.StatusCode == 401 && attempt == 0 {
			res.Body.Close()
			continue
		}
		return res, nil
	}
	return nil, &AuthError{"the cloud refused the sign-in — connect the account again"}
}

func (a *Authed) JSON(ctx context.Context, method, target string, body any, out any) error {
	var rd io.Reader
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
		rd = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(string(raw))), nil }
	}
	req.Header.Set("Accept", "application/json")
	res, err := a.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if err := check(res, method+" "+shortURL(target), 200); err != nil {
		return err
	}
	return json.NewDecoder(io.LimitReader(res.Body, 128<<20)).Decode(out)
}

func shortURL(s string) string {
	if u, err := url.Parse(s); err == nil {
		return u.Path
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
