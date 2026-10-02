package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func adminRequest(s *Server, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-Admin-Token", token)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func adminFixture(t *testing.T, s *Server, tenant, id, filename string, size int64, expiry time.Time) {
	t.Helper()
	dir := filepath.Join(s.store.tenantDir(tenant), id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, blobName), []byte("test content"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.store.saveMeta(dir, &Meta{ID: id, Filename: filename, Size: size,
		ContentType: "text/plain", Uploader: "ci-agent", UploadedAt: time.Now().Add(-time.Hour), ExpiresAt: expiry}); err != nil {
		t.Fatal(err)
	}
}

func TestAdminPageAndAssets(t *testing.T) {
	for path, contentType := range map[string]string{"/admin": "text/html", "/admin/": "text/html", "/admin.css": "text/css", "/admin.js": "text/javascript"} {
		t.Run(path, func(t *testing.T) {
			rec := adminRequest(&Server{}, http.MethodGet, path, "")
			if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), contentType) || rec.Body.Len() == 0 {
				t.Fatalf("asset response = %d, %s", rec.Code, rec.Header().Get("Content-Type"))
			}
			if contentType == "text/html" {
				if rec.Header().Get("Cache-Control") != "no-store" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
					t.Error("admin page missing cache or CSP protection")
				}
				if !strings.Contains(rec.Body.String(), "Root admin token") {
					t.Error("admin page missing login")
				}
			}
		})
	}
}

func TestAdminRequiresRootToken(t *testing.T) {
	s := newTestServer(t)
	tenant := createTenant(t, s, "acme")
	jwt, _, err := mintJWT([]byte(tenant.JWTSecret), "agent", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/admin/overview", "/api/admin/files", "/api/admin/files/abc12?tenant=acme"} {
		method := http.MethodGet
		if strings.Contains(path, "abc12") {
			method = http.MethodDelete
		}
		for _, token := range []string{"", "wrong", tenant.AdminToken, jwt} {
			rec := adminRequest(s, method, path, token)
			if rec.Code != http.StatusUnauthorized || rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("%s with non-root token: %d, cache %q", path, rec.Code, rec.Header().Get("Cache-Control"))
			}
		}
	}
}

func TestAdminOverview(t *testing.T) {
	s := newTestServer(t)
	acme := createTenant(t, s, "acme")
	createTenant(t, s, "empty")
	adminFixture(t, s, "acme", "abc12", "recording.txt", 100, time.Now().Add(time.Hour))
	adminFixture(t, s, "", "def34", "legacy.txt", 200, time.Now().Add(48*time.Hour))
	adminFixture(t, s, "acme", "ghi56", "expired.txt", 1000, time.Now().Add(-time.Hour))
	if err := os.Mkdir(filepath.Join(s.store.tenantDir("acme"), "jkl78"), 0o755); err != nil {
		t.Fatal(err)
	}
	rec := adminRequest(s, http.MethodGet, "/api/admin/overview", s.cfg.AdminToken)
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	var result struct {
		Tenants       []adminTenant `json:"tenants"`
		TenantCount   int           `json:"tenant_count"`
		FileCount     int           `json:"file_count"`
		TotalBytes    int64         `json:"total_bytes"`
		ExpiringCount int           `json:"expiring_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.TenantCount != 2 || result.FileCount != 2 || result.TotalBytes != 300 || result.ExpiringCount != 1 || len(result.Tenants) != 3 {
		t.Fatalf("unexpected overview: %+v", result)
	}
	if result.Tenants[0].Name != "acme" || result.Tenants[0].FileCount != 1 || result.Tenants[0].MaxUploadBytes != s.cfg.MaxUploadBytes || !result.Tenants[2].Legacy {
		t.Error("tenant summaries or inherited limits are incorrect")
	}
	for _, secret := range []string{s.cfg.AdminToken, acme.AdminToken, acme.JWTSecret, "jwt_secret", "admin_token"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatal("overview leaked credentials")
		}
	}
	s.cfg.JWTSecret = nil
	rec = adminRequest(s, http.MethodGet, "/api/admin/overview", s.cfg.AdminToken)
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.FileCount != 1 || len(result.Tenants) != 2 {
		t.Fatal("disabled legacy tenant should not be included")
	}
}

func TestAdminFilesFilterAndPagination(t *testing.T) {
	s := newTestServer(t)
	s.cfg.BaseURL = "https://files.example.test/"
	createTenant(t, s, "acme")
	createTenant(t, s, "beta")
	adminFixture(t, s, "acme", "abc12", "report <unsafe>.txt", 100, time.Now().Add(time.Hour))
	adminFixture(t, s, "beta", "abc12", "other.txt", 200, time.Now().Add(time.Hour))
	adminFixture(t, s, "", "def34", "legacy.txt", 300, time.Now().Add(time.Hour))
	for _, tc := range []struct {
		query string
		total int
		count int
	}{
		{"", 3, 3}, {"?tenant=acme", 1, 1}, {"?tenant=", 1, 1},
		{"?q=REPORT", 1, 1}, {"?q=ci-agent", 3, 3}, {"?q=missing", 0, 0},
		{"?limit=1&offset=1", 3, 1}, {"?offset=99", 3, 0},
	} {
		rec := adminRequest(s, http.MethodGet, "/api/admin/files"+tc.query, s.cfg.AdminToken)
		var result struct {
			Files []adminFile `json:"files"`
			Total int         `json:"total"`
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d, %s", tc.query, rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Total != tc.total || len(result.Files) != tc.count || result.Files == nil {
			t.Errorf("%s: total=%d, files=%d; want %d, %d", tc.query, result.Total, len(result.Files), tc.total, tc.count)
		}
		for _, file := range result.Files {
			want := tenantPrefix(file.Tenant) + "/f/" + file.ID + "/" + url.PathEscape(file.Filename)
			if file.Path != want || file.URL != "https://files.example.test"+want {
				t.Errorf("unsafe or incorrect public path: %q", file.Path)
			}
		}
	}
	for _, query := range []string{"?tenant=../acme", "?limit=0", "?limit=101", "?offset=-1", "?offset=oops"} {
		if rec := adminRequest(s, http.MethodGet, "/api/admin/files"+query, s.cfg.AdminToken); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", query, rec.Code)
		}
	}
	if rec := adminRequest(s, http.MethodGet, "/api/admin/files?tenant=unknown", s.cfg.AdminToken); rec.Code != http.StatusNotFound {
		t.Errorf("unknown tenant status: %d", rec.Code)
	}
}

func TestAdminDeleteFileIsolation(t *testing.T) {
	s := newTestServer(t)
	createTenant(t, s, "acme")
	createTenant(t, s, "beta")
	for _, name := range []string{"acme", "beta", ""} {
		adminFixture(t, s, name, "abc12", "file.txt", 10, time.Now().Add(time.Hour))
	}
	for _, path := range []string{"/api/admin/files/abc12", "/api/admin/files/%2e%2e?tenant=acme", "/api/admin/files/abc12?tenant=../acme"} {
		if rec := adminRequest(s, http.MethodDelete, path, s.cfg.AdminToken); rec.Code != http.StatusBadRequest {
			t.Errorf("invalid deletion %s: %d", path, rec.Code)
		}
	}
	rec := adminRequest(s, http.MethodDelete, "/api/admin/files/abc12?tenant=acme", s.cfg.AdminToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d, %s", rec.Code, rec.Body.String())
	}
	if _, err := s.store.Load("acme", "abc12"); !os.IsNotExist(err) {
		t.Error("acme file was not deleted")
	}
	for _, name := range []string{"beta", ""} {
		if _, err := s.store.Load(name, "abc12"); err != nil {
			t.Error("deletion affected another namespace")
		}
	}
	if rec := adminRequest(s, http.MethodDelete, "/api/admin/files/abc12?tenant=acme", s.cfg.AdminToken); rec.Code != http.StatusNotFound {
		t.Errorf("already-deleted file: %d", rec.Code)
	}
	s.cfg.JWTSecret = nil
	if rec := adminRequest(s, http.MethodDelete, "/api/admin/files/abc12?tenant=", s.cfg.AdminToken); rec.Code != http.StatusNotFound {
		t.Errorf("disabled legacy deletion: %d", rec.Code)
	}
	if _, err := s.store.Load("", "abc12"); err != nil {
		t.Fatal("disabled legacy file was deleted")
	}
}
