// SPDX-License-Identifier: MIT

// Package limits holds each calling team to an API's rate: a token bucket
// per API and team, refilled continuously at the per-minute rate, holding at
// most a minute's worth. Kept in this replica's memory: with N replicas a
// team may get up to N times its rate, which the limits allow for (they're
// to protect backends from a runaway caller, not to meter).
package limits

import (
	"sync"
	"time"
)

// Limiter is every bucket.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

// New is an empty limiter.
func New() *Limiter { return &Limiter{buckets: map[string]*bucket{}} }

// Allow takes one request from key's bucket at perMinute, or says how long
// until one is free.
func (l *Limiter) Allow(key string, perMinute int, now time.Time) (bool, time.Duration) {
	if perMinute <= 0 {
		return false, time.Minute
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	capacity := float64(perMinute)
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: capacity, at: now}
		l.buckets[key] = b
	}
	b.tokens = min(capacity, b.tokens+now.Sub(b.at).Minutes()*capacity)
	b.at = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / capacity * float64(time.Minute))
	return false, max(wait, time.Second)
}
