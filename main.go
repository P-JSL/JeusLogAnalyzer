package main

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed web/*
var webFiles embed.FS

func main() {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	handler := http.FileServer(http.FS(assets))
	engine, err := newEngine()
	if err != nil {
		log.Fatal(err)
	}
	var lastActive atomic.Int64
	lastActive.Store(time.Now().UnixNano())
	mux := http.NewServeMux()
	engine.register(mux, listener.Addr().String())
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		lastActive.Store(time.Now().UnixNano())
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		handler.ServeHTTP(w, r)
	})
	url := fmt.Sprintf("http://127.0.0.1:%d/", listener.Addr().(*net.TCPAddr).Port)
	if os.Getenv("JEUS_ANALYZER_NO_BROWSER") != "1" {
		if err := openBrowser(url); err != nil {
			fmt.Fprintf(os.Stderr, "브라우저에서 열어 주세요: %s (%v)\n", url, err)
		}
	} else {
		fmt.Println(url)
	}
	// The localhost server serves static UI and a disk-backed local-only event archive.
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 10 * time.Minute}
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for range tick.C {
			if time.Since(time.Unix(0, lastActive.Load())) > 3*time.Minute {
				_ = server.Close()
				return
			}
		}
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
