// SPDX-License-Identifier: MIT

package tools

// Pin is a downloadable tool's pinned version and published checksums.
type Pin struct {
	Version string
	// URL with {os}, {arch} and {version}.
	URL string
	// TarMember, for an archive: the binary's path inside it.
	TarMember string
	// SHA256 per "os/arch", from the project's own checksum files.
	SHA256 map[string]string
}

// The tools vertra may download. To upgrade one: change its version and
// take the four sums from the release's published checksums (kubectl:
// dl.k8s.io/release/<v>/bin/<os>/<arch>/kubectl.sha256; helm:
// get.helm.sh/helm-<v>-<os>-<arch>.tar.gz.sha256sum; kind: the release's
// kind-<os>-<arch>.sha256sum; tofu: the release's tofu_<v>_SHA256SUMS).
// Pick releases at least two weeks old.
var pins = map[string]Pin{
	"kubectl": {
		Version: "1.37.1",
		URL:     "https://dl.k8s.io/release/v{version}/bin/{os}/{arch}/kubectl",
		SHA256: map[string]string{
			"darwin/amd64": "6851381c486ff6edd691623e3d65c87cb9a5b02887ff8fbbb38d8a031b748387",
			"darwin/arm64": "fd65982c97ddad3106754b69ffa196d0e543aa591930ae52aed1adfb92f8c77f",
			"linux/amd64":  "65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8",
			"linux/arm64":  "ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7",
		},
	},
	"helm": {
		Version:   "4.3.0",
		URL:       "https://get.helm.sh/helm-v{version}-{os}-{arch}.tar.gz",
		TarMember: "{os}-{arch}/helm",
		SHA256: map[string]string{
			"darwin/amd64": "347a784877e0e20eac865e8d1c36a80f6bb0861d6f29abd34defb6570ef95d92",
			"darwin/arm64": "d3870437e1e95b67f8edbde964156c84a26503f560821d40c542441658934fba",
			"linux/amd64":  "86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb",
			"linux/arm64":  "31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08",
		},
	},
	"tofu": {
		Version:   "1.13.1",
		URL:       "https://github.com/opentofu/opentofu/releases/download/v{version}/tofu_{version}_{os}_{arch}.tar.gz",
		TarMember: "tofu",
		SHA256: map[string]string{
			"darwin/amd64": "a73720443ba38712d7d96dc1e857add02c15a790919c653ad07492e9952f8c27",
			"darwin/arm64": "be78f659f04ef06a9dbd9b3934d46af95d787a3aa38396d459dea395261816a9",
			"linux/amd64":  "378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69",
			"linux/arm64":  "9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3",
		},
	},
	"kind": {
		Version: "0.33.0",
		URL:     "https://github.com/kubernetes-sigs/kind/releases/download/v{version}/kind-{os}-{arch}",
		SHA256: map[string]string{
			"darwin/amd64": "5a99f26f57246dc9319dd294803313197a0f34d33c525b3ea8b655db5916ece0",
			"darwin/arm64": "0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f",
			"linux/amd64":  "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d",
			"linux/arm64":  "20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2",
		},
	},
}

// Pinned returns a tool's pinned version, if vertra can download it.
func Pinned(tool string) (string, bool) {
	p, ok := pins[tool]
	return p.Version, ok
}
