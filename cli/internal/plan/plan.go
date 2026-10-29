// SPDX-License-Identifier: MIT

// Package plan is the approval screen: everything apply or destroy will do,
// shown once before anything changes.
package plan

import (
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Floor is a size's platform requests while awake, database in-cluster,
// and its steps' limits (cli/DESIGN.md, "Sizes"; the charts' sizes/), as
// words for the screen and as numbers for the cost.
type Floor struct {
	CPU, Memory string
	Copies      string
	Volume      string
	Steps       string

	// The platform's requests awake, lowest and highest (auto scales).
	CPUCores [2]float64
	MemGiB   [2]float64
	// A step at the default size, how many can run at once, and whether
	// they run on Spot capacity.
	StepCPU, StepMemGiB float64
	StepCap             int
	Spot                bool
	VolumeGiB           float64
}

// Floors per size.
var Floors = map[string]Floor{
	"minimal": {CPU: "0.55 vCPU", Memory: "1.75 GiB", Copies: "one copy of everything", Volume: "10Gi",
		Steps:    "up to 10 at once (5 per team), 0.25 vCPU and 512 MiB each unless a product says",
		CPUCores: [2]float64{0.55, 0.55}, MemGiB: [2]float64{1.75, 1.75}, StepCPU: 0.25, StepMemGiB: 0.5, StepCap: 10, Spot: true, VolumeGiB: 10},
	"resilient": {CPU: "1 vCPU", Memory: "3 GiB", Copies: "two copies of the console and API", Volume: "50Gi",
		Steps:    "up to 50 at once (20 per team), 0.5 vCPU and 1 GiB each unless a product says",
		CPUCores: [2]float64{1, 1}, MemGiB: [2]float64{3, 3}, StepCPU: 0.5, StepMemGiB: 1, StepCap: 50, Spot: true, VolumeGiB: 50},
	"scaled": {CPU: "1.8 vCPU", Memory: "5.25 GiB", Copies: "three copies of the console and API, two schedulers", Volume: "100Gi",
		Steps:    "up to 200 at once (50 per team), 0.5 vCPU and 1 GiB each unless a product says",
		CPUCores: [2]float64{1.8, 1.8}, MemGiB: [2]float64{5.25, 5.25}, StepCPU: 0.5, StepMemGiB: 1, StepCap: 200, Spot: false, VolumeGiB: 100},
	"auto": {CPU: "0.8–1.2 vCPU", Memory: "2.25–3.75 GiB", Copies: "one to three copies of the console and API, on load", Volume: "50Gi",
		Steps:    "up to 50 at once (20 per team), 0.5 vCPU and 1 GiB each unless a product says",
		CPUCores: [2]float64{0.8, 1.2}, MemGiB: [2]float64{2.25, 3.75}, StepCPU: 0.5, StepMemGiB: 1, StepCap: 50, Spot: true, VolumeGiB: 50},
}

// Line is one labelled line of the screen.
type Line struct {
	Label string
	Text  string
}

// Plan is what will happen.
type Plan struct {
	Title string
	// Access is who's signed in, where it goes and what that allows.
	Access   []Line
	Settings []Line
	Changes  []Line
	Cost     []Line
	Notes    []string
	// Nothing to do: everything is as configured.
	NoChanges bool
}

// Width is the screen's line length.
const Width = 88

// Render writes the screen.
func (p *Plan) Render(w io.Writer) {
	fmt.Fprintln(w, p.Title)
	fmt.Fprintln(w)
	if len(p.Access) > 0 {
		section(w, p.Access)
		fmt.Fprintln(w)
	}
	section(w, p.Settings)
	if len(p.Changes) > 0 {
		fmt.Fprintln(w)
		section(w, p.Changes)
	}
	if len(p.Cost) > 0 {
		fmt.Fprintln(w)
		section(w, p.Cost)
	}
	if len(p.Notes) > 0 {
		fmt.Fprintln(w)
		notes := make([]Line, len(p.Notes))
		for i, n := range p.Notes {
			notes[i] = Line{Label: "Note", Text: n}
		}
		section(w, notes)
	}
	fmt.Fprintln(w)
}

// section writes labelled lines, the text in one column and wrapped.
func section(w io.Writer, lines []Line) {
	width := 0
	for _, l := range lines {
		width = max(width, utf8.RuneCountInString(l.Label))
	}
	indent := strings.Repeat(" ", width+2)
	for _, l := range lines {
		for i, text := range wrap(l.Text, Width-width-2) {
			if i == 0 {
				fmt.Fprintln(w, l.Label+strings.Repeat(" ", width-utf8.RuneCountInString(l.Label)+2)+text)
			} else {
				fmt.Fprintln(w, indent+text)
			}
		}
	}
}

// wrap splits text into lines of at most width characters, at spaces (a
// longer word gets a line of its own).
func wrap(text string, width int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}
	var lines []string
	line := words[0]
	for _, word := range words[1:] {
		if utf8.RuneCountInString(line)+1+utf8.RuneCountInString(word) > width {
			lines = append(lines, line)
			line = word
			continue
		}
		line += " " + word
	}
	return append(lines, line)
}
