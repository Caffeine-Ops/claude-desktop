// Monorepo root postinstall, bun edition.
//
// PHASED ROLLOUT: during the skeleton stage the open-design packages/tools and
// apps/daemon are NOT yet copied in. Every step below is guarded by an
// existence check so this script is a safe no-op until those land. Once
// open-design is vendored, the same script does the real work with zero edits.
//
// Two jobs, in order:
//   1. Build the workspace packages that everything else imports from `dist/`
//      (contracts, host, sidecar, tools/*, ...). open-design's source imports
//      compiled `.js` from these packages, so they must be built once after
//      install or the daemon/web won't resolve them.
//   2. Verify the better-sqlite3 native addon actually loads under the CURRENT
//      runtime ABI, and rebuild only if it doesn't.
//
// WHY this differs from open-design's original (which was pnpm-only):
//   - Original resolved the package manager from `npm_execpath` / `pnpm.cmd`
//     and rebuilt via `pnpm --filter <pkg> rebuild`. Under bun there is no
//     `pnpm`; we build per-package with `bun run --cwd` and rebuild natives in
//     the addon's own dir with an explicit --target.
//   - CRITICAL (error log 2026-05-23 better-sqlite3 ABI): "rebuild printed
//     Done" never proves the ABI changed. prebuild-install may fetch a binary
//     for the wrong ABI; node-gyp may reuse a cached header version. The ONLY
//     trustworthy signal is `process.versions.modules` after a successful
//     require(). So we verify by loading, not by exit code.
//   - The daemon's better-sqlite3 is compiled for Node's ABI (137 = Node 24),
//     NOT bun's runtime. The daemon therefore runs under `node`, not `bun`.
//     bun is the package manager + tools runner here, not the daemon runtime.
//     (Verified 2026-05-23: bun 1.3.11 + Node 24 trustedDependencies produces
//     a working ABI-137 addon.)

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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

// --- better-sqlite3 ABI verification ----------------------------------------
// Resolve from the daemon package context: better-sqlite3 is a dep of
// apps/daemon, not the root. Skip entirely until the daemon is vendored.
const daemonPkg = resolve(repoRoot, "apps/daemon/package.json");
if (existsSync(daemonPkg)) {
  const req = createRequire(daemonPkg);
  let needsRebuild = false;
  try {
    req("better-sqlite3");
    process.stdout.write(
      `postinstall: better-sqlite3 OK (NODE_MODULE_VERSION=${process.versions.modules}, ${process.version})\n`,
    );
  } catch (e) {
    // MODULE_NOT_FOUND => daemon deps not installed yet, not our problem.
    if (e?.code !== "MODULE_NOT_FOUND") needsRebuild = true;
  }

  if (needsRebuild) {
    process.stdout.write(
      `postinstall: rebuilding better-sqlite3 for ${process.version} (ABI ${process.versions.modules})...\n`,
    );
    const rebuild = spawnSync(
      "bun",
      [
        "run",
        "--cwd",
        "apps/daemon",
        "exec",
        "node-gyp",
        "rebuild",
        "--release",
        `--target=${process.versions.node}`,
        "--directory=node_modules/better-sqlite3",
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (rebuild.error != null) throw rebuild.error;
    if (rebuild.status !== 0) {
      process.stderr.write(
        "postinstall: better-sqlite3 rebuild failed.\n" +
          `Install build tools (python3, make, g++/clang++), ensure Node 24, then: bun install\n`,
      );
      process.exit(rebuild.status ?? 1);
    }
    try {
      delete req.cache?.[req.resolve("better-sqlite3")];
      req("better-sqlite3");
      process.stdout.write(
        `postinstall: better-sqlite3 rebuilt OK (NODE_MODULE_VERSION=${process.versions.modules})\n`,
      );
    } catch (e) {
      process.stderr.write(
        `postinstall: better-sqlite3 still failing after rebuild: ${e?.message}\n`,
      );
      process.exit(1);
    }
  }
}
