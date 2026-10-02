package main

import (
	_ "embed"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed public/admin.html
var adminPage string

//go:embed public/admin.css
var adminCSS []byte

//go:embed public/admin.js
var adminJS []byte

func (s *Server) handleAdminPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	_, _ = io.WriteString(w, adminPage)
}

func (s *Server) handleAdminCSS(w http.ResponseWriter, _ *http.Request) {
	serveStatic(w, "text/css; charset=utf-8", adminCSS)
}

func (s *Server) handleAdminJS(w http.ResponseWriter, _ *http.Request) {
	serveStatic(w, "text/javascript; charset=utf-8", adminJS)
}

type adminTenant struct {
	publicTenant
	Legacy        bool  `json:"legacy"`
	FileCount     int   `json:"file_count"`
	TotalBytes    int64 `json:"total_bytes"`
	ExpiringCount int   `json:"expiring_count"`
}

type adminFile struct {
	Meta
	Tenant string `json:"tenant"`
	Path   string `json:"path"`
	URL    string `json:"url"`
}

func (s *Server) dashboardTenants() []adminTenant {
	list := s.tenants.List()
	out := make([]adminTenant, 0, len(list)+1)
	for _, t := range list {
		def, max, size := t.effectiveLimits(s.cfg)
		p := t.public()
		p.DefaultTTL, p.MaxTTL, p.MaxUploadBytes = def.String(), max.String(), size
		out = append(out, adminTenant{publicTenant: p})
	}
	if len(s.cfg.JWTSecret) >= 16 {
		out = append(out, adminTenant{Legacy: true, publicTenant: publicTenant{
			DefaultTTL: s.cfg.DefaultTTL.String(), MaxTTL: s.cfg.MaxTTL.String(), MaxUploadBytes: s.cfg.MaxUploadBytes,
		}})
	}
	return out
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, _ *http.Request) {
	now := time.Now()
	tenants := s.dashboardTenants()
	count, expiring, tenantCount := 0, 0, 0
	var bytes int64
	for i := range tenants {
		if !tenants[i].Legacy {
			tenantCount++
		}
		files, err := s.store.List(tenants[i].Name, now)
		if err != nil {
			log.Printf("admin list files: %v", err)
			writeErr(w, http.StatusInternalServerError, "could not read stored files")
			return
		}
		for _, f := range files {
			tenants[i].FileCount++
			tenants[i].TotalBytes += f.Size
			if !f.ExpiresAt.After(now.Add(24 * time.Hour)) {
				tenants[i].ExpiringCount++
			}
		}
		count += tenants[i].FileCount
		bytes += tenants[i].TotalBytes
		expiring += tenants[i].ExpiringCount
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenants": tenants, "tenant_count": tenantCount,
		"file_count": count, "total_bytes": bytes, "expiring_count": expiring,
		"default_ttl": s.cfg.DefaultTTL.String(), "max_ttl": s.cfg.MaxTTL.String(),
		"max_upload_bytes": s.cfg.MaxUploadBytes, "legacy_enabled": len(s.cfg.JWTSecret) >= 16,
	})
}

// A present but empty tenant parameter selects legacy files. An omitted
// parameter selects all tenants on lists and is rejected for deletion.
func (s *Server) validAdminTenant(w http.ResponseWriter, name string) bool {
	if name == legacyTenant {
		if len(s.cfg.JWTSecret) >= 16 {
			return true
		}
		writeErr(w, http.StatusNotFound, "legacy tenant disabled")
		return false
	}
	if !validTenantName(name) {
		writeErr(w, http.StatusBadRequest, "invalid tenant name")
		return false
	}
	if _, ok := s.tenants.Get(name); !ok {
		writeErr(w, http.StatusNotFound, "unknown tenant")
		return false
	}
	return true
}

func (s *Server) handleAdminFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, offset := 50, 0
	for key, target := range map[string]*int{"limit": &limit, "offset": &offset} {
		if q.Has(key) {
			v, err := strconv.Atoi(q.Get(key))
			if err != nil || v < 0 || (key == "limit" && (v == 0 || v > 100)) {
				writeErr(w, http.StatusBadRequest, "limit must be 1–100 and offset must be nonnegative")
				return
			}
			*target = v
		}
	}
	tenants := s.dashboardTenants()
	if q.Has("tenant") {
		if !s.validAdminTenant(w, q.Get("tenant")) {
			return
		}
		tenants = []adminTenant{{publicTenant: publicTenant{Name: q.Get("tenant")}}}
	}
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	files := make([]adminFile, 0)
	for _, t := range tenants {
		list, err := s.store.List(t.Name, time.Now())
		if err != nil {
			log.Printf("admin list files: %v", err)
			writeErr(w, http.StatusInternalServerError, "could not read stored files")
			return
		}
		for _, f := range list {
			if search != "" && !strings.Contains(strings.ToLower(f.Filename+" "+f.Uploader+" "+f.ID+" "+t.Name), search) {
				continue
			}
			path := tenantPrefix(t.Name) + "/f/" + f.ID + "/" + url.PathEscape(f.Filename)
			files = append(files, adminFile{Meta: f, Tenant: t.Name, Path: path, URL: s.publicBase(r) + path})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].UploadedAt.Equal(files[j].UploadedAt) {
			return files[i].Tenant+"/"+files[i].ID < files[j].Tenant+"/"+files[j].ID
		}
		return files[i].UploadedAt.After(files[j].UploadedAt)
	})
	total := len(files)
	if offset > total {
		offset = total
	}
	end := offset + min(limit, total-offset)
	writeJSON(w, http.StatusOK, map[string]any{"files": files[offset:end], "total": total, "offset": offset, "limit": limit})
}

func (s *Server) handleAdminDeleteFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) || !r.URL.Query().Has("tenant") {
		writeErr(w, http.StatusBadRequest, "a valid file ID and explicit tenant are required")
		return
	}
	tenant := r.URL.Query().Get("tenant")
	if !s.validAdminTenant(w, tenant) {
		return
	}
	if _, err := s.store.Load(tenant, id); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "file not found")
		} else {
			writeErr(w, http.StatusInternalServerError, "could not read file")
		}
		return
	}
	if err := s.store.DeleteFile(tenant, id); err != nil {
		log.Printf("admin delete file: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not delete file")
		return
	}
	log.Printf("admin deleted %s/f/%s", tenantPrefix(tenant), id)
	w.WriteHeader(http.StatusNoContent)
}
