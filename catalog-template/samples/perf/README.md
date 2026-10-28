# perf

`noop.run` does nothing for `sleepMs`, then succeeds, or fails as `fail`
asks (`always`, or `first-attempt`, retryable, so its second attempt
succeeds), with up to `outputBytes` of padding in its outputs. It reports
when its container started and finished (`startedAtMs`, `finishedAtMs`), so
a benchmark can tell the platform's time from the step's. No network, no
credentials, no secrets.

It's what `perf/` in the platform's repository runs; see its README.
