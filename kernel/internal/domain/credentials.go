// SPDX-License-Identifier: MIT

package domain

import "regexp"

// Recognizing credentials in what a step sends back, so they aren't stored.
//
// The kernel never sees a secret's value (steps mount them; nothing here
// reads them), so it can't redact by value. It recognizes the shapes real
// credentials have: a PEM private key, a cloud access key, a GitHub or
// Slack token. Logs are for people, so a match there is replaced with
// "[redacted <kind>]"; outputs are data that flows to later steps and to
// anyone who can read the execution, so a match there fails the task
// instead. Bearer tokens and JWTs are redacted from logs but don't fail
// outputs: a product may return a short-lived token on purpose.

var (
	pemBegin = regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`)
	pemEnd   = regexp.MustCompile(`-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`)
	pemBlock = regexp.MustCompile(pemBegin.String() + `[\s\S]*?(?:` + pemEnd.String() + `|$)`)
)

type credentialShape struct {
	kind    string
	pattern *regexp.Regexp
}

// Each specific to a provider's format.
var tokens = []credentialShape{
	{"private key", pemBegin},
	{"AWS access key", regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{"GitHub token", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b`)},
	{"Google API key", regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}\b`)},
	{"Slack token", regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`)},
	{"Stripe key", regexp.MustCompile(`\b[rs]k_live_[0-9A-Za-z]{20,}\b`)},
	{"Azure storage key", regexp.MustCompile(`AccountKey=[A-Za-z0-9+/]{40,}={0,2}`)},
}

// Redacted from logs only.
var logOnly = []credentialShape{
	{"bearer token", regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{20,}=*`)},
	{"JWT", regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`)},
}

// RedactText is text with every recognized credential replaced; a PEM key
// goes from its BEGIN marker through its END marker (or the end of the text).
func RedactText(text string) string {
	text = pemBlock.ReplaceAllString(text, "[redacted private key]")
	for _, shape := range append(append([]credentialShape{}, tokens[1:]...), logOnly...) {
		text = shape.pattern.ReplaceAllLiteralString(text, "[redacted "+shape.kind+"]")
	}
	return text
}

// RedactLines is log lines with credentials redacted; a PEM key spans
// lines, so every line from its BEGIN to its END marker becomes one marker.
func RedactLines(lines []string) []string {
	redacted := make([]string, 0, len(lines))
	inKey := false
	for _, line := range lines {
		if inKey {
			if pemEnd.MatchString(line) {
				inKey = false
			}
			continue
		}
		if begin := pemBegin.FindStringIndex(line); begin != nil && !pemEnd.MatchString(line[begin[1]:]) {
			inKey = true
			redacted = append(redacted, RedactText(line[:begin[0]])+"[redacted private key]")
			continue
		}
		redacted = append(redacted, RedactText(line))
	}
	return redacted
}

// FindCredential is the kind of the first credential anywhere in value
// (decoded JSON: keys and values, at any depth), or "".
func FindCredential(value any) string {
	switch v := value.(type) {
	case string:
		for _, shape := range tokens {
			if shape.pattern.MatchString(v) {
				return shape.kind
			}
		}
	case map[string]any:
		for key, item := range v {
			if found := FindCredential(key); found != "" {
				return found
			}
			if found := FindCredential(item); found != "" {
				return found
			}
		}
	case []any:
		for _, item := range v {
			if found := FindCredential(item); found != "" {
				return found
			}
		}
	}
	return ""
}
