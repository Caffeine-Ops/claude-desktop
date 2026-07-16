// Monorepo root postinstall, bun edition.
//
// PHASED ROLLOUT: during the skeleton stage the open-design packages/tools and
// apps/daemon are NOT yet copied in. Every step below is guarded by an
// existence check so this script is a safe no-op until those land. Once
// open-design is vendored, the same script does the real work with zero edits.
//
// One job: build the workspace packages that everything else imports from
// `dist/` (contracts, host, sidecar, tools/*, ...). open-design's source
// imports compiled `.js` from these packages, so they must be built once after
// install or the daemon/web won't resolve them.
//
// NOTE (2026-07-15): the second historical job — verifying/rebuilding the
// better-sqlite3 native addon for the current ABI — is GONE. The daemon no
// longer depends on any native module: its SQLite layer moved to node:sqlite
// (Node 24 built-in, zero native compile, no ABI to match), which let us stop
// bundling a standalone node-runtime and run the daemon on Electron's own node.
// See apps/daemon/src/lib/sqlite.ts for the full rationale. There is therefore
// nothing native to verify here anymore.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

// Build order matters: leaf packages first, then dependents. Mirrors
// open-design's postinstall buildTargets. Missing targets are skipped (skeleton
// stage) so this list can be the final one from day one.
const buildTargets = [
  "packages/contracts",
  "packages/host",
  "packages/registry-protocol",
  "packages/agui-adapter",
  "packages/plugin-runtime",
  "packages/sidecar-proto",
  "packages/sidecar",
  "packages/platform",
  "packages/diagnostics",
  "tools/dev",
  "tools/pack",
  "tools/pr",
  "tools/serve",
];

for (const target of buildTargets) {
  if (!existsSync(resolve(repoRoot, target, "package.json"))) {
    continue; // not vendored yet — skeleton-safe
  }
  const result = spawnSync("bun", ["run", "--cwd", target, "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// No native-addon verification step: the daemon has no native modules anymore
// (SQLite is node:sqlite, built into the runtime). Nothing to rebuild.
