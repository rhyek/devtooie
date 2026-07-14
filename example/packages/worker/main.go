package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"
)

// A tiny background worker written in Go. It has no package.json — devtooie drives
// it through the Makefile's `make` targets (start/build/clean) instead. Its dev
// process (`start` → `go run .`) does NOT watch files (see the package's
// `run.command` in devtooie.config.ts), so after editing this file you restart the
// process to recompile and pick up the change rather than relying on a reloader.
//
// Logging is structured (JSON) via the standard library's `log/slog` — the idiomatic
// Go way. In real apps you'd emit this "production" format unconditionally instead of
// branching logger behavior on an environment (dev vs prod). devtooie's per-package
// `logs.formatter` (see devtooie.config.ts) reshapes these JSON lines into a readable
// form for the TUI; in deployment the same JSON is what your log pipeline ingests.
func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	slog.Info("worker started", "port", port)

	go func() {
		ticks := 0
		// devtooie stamps each line with its own timestamp, so the worker doesn't emit one —
		// it just logs a structured event with a couple of attributes.
		for range time.Tick(5 * time.Second) {
			ticks++
			slog.Info("tick", "count", ticks)
		}
	}()

	// A minimal health endpoint so devtooie can show this package as ready (green dot).
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})

	slog.Info("health endpoint ready", "url", "http://localhost:"+port+"/health")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		slog.Error("server stopped", "err", err.Error())
		os.Exit(1)
	}
}
