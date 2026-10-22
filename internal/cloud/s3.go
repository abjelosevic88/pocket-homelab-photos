package cloud

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"
)

// S3 lists a bucket (any S3-compatible store: AWS, Backblaze B2, Wasabi, MinIO, R2) with ListObjectsV2
// and path-style addressing, signed with AWS Signature V4. The prefix is the account's folder.
type S3 struct {
	Endpoint  string // https://s3.eu-central-003.backblazeb2.com
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	HTTP      *http.Client
	now       func() time.Time
	payload   string // signed payload hash; UNSIGNED-PAYLOAD unless a test pins it
}

func (s *S3) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return http.DefaultClient
}

func (s *S3) objectURL(key string, q url.Values) string {
	u, _ := url.Parse(strings.TrimRight(s.Endpoint, "/"))
	segs := []string{s.Bucket}
	if key != "" {
		segs = append(segs, strings.Split(key, "/")...)
	}
	for i, p := range segs {
		segs[i] = awsEscape(p)
	}
	u.RawPath = "/" + strings.Join(segs, "/")
	u.Path, _ = url.PathUnescape(u.RawPath)
	if q != nil {
		u.RawQuery = canonicalQuery(q)
	}
	return u.String()
}

func (s *S3) do(ctx context.Context, method, target string, h http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range h {
		req.Header[k] = v
	}
	s.sign(req)
	return s.client().Do(req)
}

func (s *S3) Probe(ctx context.Context, prefix string) error {
	res, err := s.do(ctx, "GET", s.objectURL("", url.Values{"list-type": {"2"}, "max-keys": {"1"}, "prefix": {strings.Trim(prefix, "/")}}), nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return check(res, "connect", 200)
}

type listV2 struct {
	Contents []struct {
		Key          string `xml:"Key"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
	} `xml:"Contents"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

func (s *S3) Walk(ctx context.Context, root, _ string, fn func(Entry) error) (string, bool, error) {
	prefix := strings.Trim(root, "/")
	if prefix != "" {
		prefix += "/"
	}
	token := ""
	for pages := 0; pages < 100000; pages++ {
		q := url.Values{"list-type": {"2"}, "max-keys": {"1000"}}
		if prefix != "" {
			q.Set("prefix", prefix)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		res, err := s.do(ctx, "GET", s.objectURL("", q), nil)
		if err != nil {
			return "", false, err
		}
		if err := check(res, "list bucket", 200); err != nil {
			return "", false, err
		}
		var l listV2
		err = xml.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&l)
		res.Body.Close()
		if err != nil {
			return "", false, err
		}
		for _, o := range l.Contents {
			name := path.Base(o.Key)
			typ, _, ok := MediaType(name, "")
			if !ok || strings.HasSuffix(o.Key, "/") || strings.HasPrefix(name, ".") {
				continue
			}
			mod, _ := time.Parse(time.RFC3339, o.LastModified)
			if err := fn(Entry{ID: o.Key, Path: o.Key, Name: name, Mime: typ, Size: o.Size, ETag: strings.Trim(o.ETag, `"`), Modified: mod.UTC()}); err != nil {
				return "", false, err
			}
		}
		if !l.IsTruncated || l.NextContinuationToken == "" {
			return "", true, nil
		}
		token = l.NextContinuationToken
	}
	return "", true, nil
}

func (s *S3) Get(ctx context.Context, e Entry, rng string) (*http.Response, error) {
	h := http.Header{}
	if rng != "" {
		h.Set("Range", rng)
	}
	return s.do(ctx, "GET", s.objectURL(e.ID, nil), h)
}

func (s *S3) Thumb(context.Context, Entry, int) (*http.Response, error) { return nil, ErrNoThumb }

// ---- Signature V4 ----

func (s *S3) sign(req *http.Request) {
	now := time.Now
	if s.now != nil {
		now = s.now
	}
	t := now().UTC()
	amzDate, day := t.Format("20060102T150405Z"), t.Format("20060102")
	region := s.Region
	if region == "" {
		region = "us-east-1"
	}
	payload := s.payload
	if payload == "" {
		payload = "UNSIGNED-PAYLOAD"
	}
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payload)
	req.Header.Set("Host", req.URL.Host)
	names := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if req.Header.Get("Range") != "" {
		names = append(names, "range")
	}
	sort.Strings(names)
	var ch strings.Builder
	for _, n := range names {
		v := req.Header.Get(n)
		if n == "host" {
			v = req.URL.Host
		}
		ch.WriteString(n + ":" + strings.TrimSpace(v) + "\n")
	}
	signed := strings.Join(names, ";")
	cpath := req.URL.EscapedPath()
	if cpath == "" {
		cpath = "/"
	}
	creq := strings.Join([]string{req.Method, cpath, req.URL.RawQuery, ch.String(), signed, payload}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	sum := sha256.Sum256([]byte(creq))
	sts := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	k := hmacSHA([]byte("AWS4"+s.SecretKey), day)
	k = hmacSHA(k, region)
	k = hmacSHA(k, "s3")
	k = hmacSHA(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA(k, sts))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", s.AccessKey, scope, signed, sig))
	req.Header.Del("Host")
}

func hmacSHA(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// awsEscape is S3's URI encoding: everything but unreserved characters is %XX.
func awsEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		vs := append([]string{}, q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, awsEscape(k)+"="+awsEscape(v))
		}
	}
	return strings.Join(parts, "&")
}
