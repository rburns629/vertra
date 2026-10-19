// SPDX-License-Identifier: MIT

// Package prompt asks init's questions on a terminal. With Interactive off,
// every question takes its default (or fails when there's none), so init
// can run from flags alone.
package prompt

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// Asker asks questions.
type Asker struct {
	Interactive bool
	in          *bufio.Reader
	out         io.Writer
}

// New returns an Asker reading answers from in.
func New(in io.Reader, out io.Writer, interactive bool) *Asker {
	return &Asker{Interactive: interactive, in: bufio.NewReader(in), out: out}
}

// Option is one choice.
type Option struct {
	Value string
	Label string
	Note  string
}

func (a *Asker) readLine() (string, error) {
	line, err := a.in.ReadString('\n')
	if err != nil && line == "" {
		return "", fmt.Errorf("no answer (input closed)")
	}
	return strings.TrimSpace(line), nil
}

// Choose asks for one of options; def is the default's Value.
func (a *Asker) Choose(question string, options []Option, def string) (string, error) {
	if !a.Interactive {
		if def == "" {
			return "", fmt.Errorf("%s: no default; give it as a flag", question)
		}
		return def, nil
	}
	fmt.Fprintln(a.out, question)
	defIndex := 0
	for i, o := range options {
		marker := " "
		if o.Value == def {
			marker, defIndex = "*", i+1
		}
		line := fmt.Sprintf("  %s %d) %s", marker, i+1, o.Label)
		if o.Note != "" {
			line += "  (" + o.Note + ")"
		}
		fmt.Fprintln(a.out, line)
	}
	for {
		if defIndex > 0 {
			fmt.Fprintf(a.out, "Choose [%d]: ", defIndex)
		} else {
			fmt.Fprint(a.out, "Choose: ")
		}
		answer, err := a.readLine()
		if err != nil {
			return "", err
		}
		if answer == "" && defIndex > 0 {
			return def, nil
		}
		if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(options) {
			return options[n-1].Value, nil
		}
		for _, o := range options {
			if strings.EqualFold(answer, o.Value) {
				return o.Value, nil
			}
		}
		fmt.Fprintln(a.out, "  Please choose one of the numbers above.")
	}
}

// Confirm asks a yes/no question.
func (a *Asker) Confirm(question string, def bool) (bool, error) {
	if !a.Interactive {
		return def, nil
	}
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	for {
		fmt.Fprintf(a.out, "%s [%s]: ", question, hint)
		answer, err := a.readLine()
		if err != nil {
			return false, err
		}
		switch strings.ToLower(answer) {
		case "":
			return def, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
		fmt.Fprintln(a.out, "  Please answer y or n.")
	}
}

// Text asks for a value; validate (optional) returns why an answer won't do.
func (a *Asker) Text(question, def string, validate func(string) error) (string, error) {
	if !a.Interactive {
		if def == "" {
			return "", fmt.Errorf("%s: no default; give it as a flag", question)
		}
		return def, nil
	}
	for {
		if def != "" {
			fmt.Fprintf(a.out, "%s [%s]: ", question, def)
		} else {
			fmt.Fprintf(a.out, "%s: ", question)
		}
		answer, err := a.readLine()
		if err != nil {
			return "", err
		}
		if answer == "" {
			answer = def
		}
		if answer == "" {
			fmt.Fprintln(a.out, "  An answer is needed.")
			continue
		}
		if validate != nil {
			if err := validate(answer); err != nil {
				fmt.Fprintf(a.out, "  %v\n", err)
				continue
			}
		}
		return answer, nil
	}
}

// Number asks for an integer between lo and hi.
func (a *Asker) Number(question string, def, lo, hi int) (int, error) {
	answer, err := a.Text(question, strconv.Itoa(def), func(s string) error {
		n, err := strconv.Atoi(s)
		if err != nil || n < lo || n > hi {
			return fmt.Errorf("a whole number from %d to %d", lo, hi)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(answer)
	return n, nil
}

// Secret asks for a value without echoing it, or takes it from the
// environment variable env (for non-interactive runs). It's never shown,
// logged or written anywhere.
func (a *Asker) Secret(question, env string) (string, error) {
	if v := os.Getenv(env); v != "" {
		return v, nil
	}
	if !a.Interactive {
		return "", fmt.Errorf("%s: set %s (non-interactive)", question, env)
	}
	fmt.Fprintf(a.out, "%s (or set %s): ", question, env)
	data, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.out)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", fmt.Errorf("%s: no answer", question)
	}
	return string(data), nil
}
