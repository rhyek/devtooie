package main

import (
	"log"
	"net/http"
	"os"
	"time"
)

// A tiny background worker written in Go. It has no package.json — devtooie drives
// it through the Makefile's `make` targets (start/build/clean) instead. Its dev
// process (`start` → `go run .`) does NOT watch files (see the package's
// `run.command` in devtooie.config.ts), so after editing this file you restart the
// process to recompile and pick up the change rather than relying on a reloader.
func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	log.Println("[worker] started")

	go func() {
		for now := range time.Tick(5 * time.Second) {
			log.Printf("[worker] tick @ %s", now.UTC().Format(time.RFC3339))
		}
	}()

	// A minimal health endpoint so devtooie can show this package as ready (green dot).
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("[worker] health endpoint on http://localhost:%s/health", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
