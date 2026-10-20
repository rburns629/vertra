// SPDX-License-Identifier: MIT

// Package logging is the kernel's structured logs: one JSON object per line
// on stdout, in the Python kernel's shape (timestamp, severity, logger,
// message, service, then the call's own fields), so Cloud Logging maps
// severity and existing queries keep working.
package logging

import (
	"io"
	"log/slog"
	"os"
	"time"
)

// New returns a logger for service ("kernel-scheduler"), named logger.
func New(service, logger string) *slog.Logger {
	return NewTo(os.Stdout, service, logger)
}

// NewTo is New writing to w.
func NewTo(w io.Writer, service, logger string) *slog.Logger {
	handler := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				return slog.String("timestamp", a.Value.Time().UTC().Format(time.RFC3339Nano))
			case slog.LevelKey:
				return slog.String("severity", severity(a.Value.Any().(slog.Level)))
			case slog.MessageKey:
				return slog.String("message", a.Value.String())
			}
			return a
		},
	})
	return slog.New(handler).With("logger", logger, "service", service)
}

// severity is Python's level name for a slog level.
func severity(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "ERROR"
	case level >= slog.LevelWarn:
		return "WARNING"
	case level >= slog.LevelInfo:
		return "INFO"
	}
	return "DEBUG"
}
