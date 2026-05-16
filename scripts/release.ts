/**
 * Release script — runs a signed Tauri build, copies the artifacts that the
 * updater needs into the landing-page repo, and emits the `latest.json`
 * manifest the updater pings.
 *
 * Run:  `bun run scripts/release.ts`
 * Env:  `TAURI_SIGNING_PRIVATE_KEY_PATH` defaults to `~/.tauri/ishot.key`.
 *
 * What it produces in landing-page/public/download/:
 *   - iShot_<version>_aarch64.dmg     (download for fresh installs)
 *   - iShot.app.tar.gz                (updater payload)
 *   - iShot.app.tar.gz.sig            (minisign signature)
 *   - latest.json                     (updater manifest)
 *
 * The updater plugin pings latest.json, compares its `version` to the running
 * binary's version, downloads `url`, verifies it against `signature` using
 * the pubkey baked into tauri.conf.json, swaps the .app, and restarts.
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dir, "..");
const LANDING = path.resolve(ROOT, "..", "ishot-landingpage");
const LANDING_DL = path.join(LANDING, "public", "download");

const TAURI_CONF = JSON.parse(
	readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
);
const VERSION: string = TAURI_CONF.version;
const PRODUCT: string = TAURI_CONF.productName;

const keyPath =
	process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ??
	path.join(os.homedir(), ".tauri", "ishot.key");

console.log(`\n→ Building signed release ${PRODUCT} v${VERSION}`);
console.log(`  signing key: ${keyPath}`);

execSync("bun run tauri build", {
	stdio: "inherit",
	cwd: ROOT,
	env: {
		...process.env,
		TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
	},
});

const BUNDLE = path.join(ROOT, "src-tauri", "target", "release", "bundle");

// Artifact names. macOS aarch64 build paths:
//   bundle/dmg/iShot_<v>_aarch64.dmg
//   bundle/macos/iShot.app.tar.gz       (only when createUpdaterArtifacts=true)
//   bundle/macos/iShot.app.tar.gz.sig
const DMG = path.join(BUNDLE, "dmg", `${PRODUCT}_${VERSION}_aarch64.dmg`);
const TARBALL = path.join(BUNDLE, "macos", `${PRODUCT}.app.tar.gz`);
const SIG = `${TARBALL}.sig`;

mkdirSync(LANDING_DL, { recursive: true });

console.log("\n→ Copying artifacts to landing-page/public/download/");
for (const src of [DMG, TARBALL, SIG]) {
	const dest = path.join(LANDING_DL, path.basename(src));
	cpSync(src, dest);
	console.log(`  ${path.basename(dest)}`);
}

// `signature` field in latest.json is the literal contents of the .sig file —
// the updater compares this against what it downloads + the pubkey.
const signature = readFileSync(SIG, "utf8").trim();

const manifest = {
	version: VERSION,
	notes: `iShot ${VERSION} — see the release notes on the landing page.`,
	pub_date: new Date().toISOString(),
	platforms: {
		"darwin-aarch64": {
			signature,
			url: `https://ishot-landingpage.vercel.app/download/${PRODUCT}.app.tar.gz`,
		},
	},
};

const manifestPath = path.join(LANDING_DL, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`  latest.json (v${VERSION})`);

console.log(`\n✓ Release ${VERSION} ready in ${LANDING_DL}`);
console.log("  Next: commit + push the landing-page repo, then users will see");
console.log("        the update next time they pick 'Check for Updates…'.");
