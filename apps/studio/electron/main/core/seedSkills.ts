import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBundledSkillsPluginDir, resolveCoworkPluginEntries } from './cliDetect'

/**
 * Pre-warm the skill list from disk so the `/` composer popover and the
 * SkillsDialog show something on first open, before fusion-code's
 * `system init` SDK message has landed (that message only fires after
 * the user sends their first prompt — see engine.ts ensureSessionReady).
 *
 * Discovery mirrors fusion-code's skill loader, in four buckets:
 *   1. User-level:  `~/.claude/skills/<name>/SKILL.md`          → `<name>`
 *   2. Project:     `<workspace>/.claude/skills/<name>/SKILL.md` → `<name>`
 *   3. Bundled plugin: the repo-root `skills/` we ship as a local plugin
 *                   (see resolveBundledSkillsPluginDir / engine `plugins`
 *                   option). Its `.claude-plugin/plugin.json` has
 *                   `"name": "claude-desktop"`, so fusion-code exposes each
 *                   `<dir>/<name>/SKILL.md` as `claude-desktop:<name>`. This
 *                   is where gpt-image-2 / ppt-master live — the bucket that
 *                   was previously missing, which is why the `/` popover was
 *                   empty until the first turn.
 *   4. Other plugins: read `~/.claude/plugins/installed_plugins.json`,
 *                   for each installed plugin scan
 *                   `<installPath>/skills/<name>/SKILL.md` and
 *                   `<installPath>/.claude/skills/<name>/SKILL.md` →
 *                   `<plugin-short-name>:<name>` (matches fusion-code's
 *                   namespace format, e.g. `vercel:deploy`).
 *
 * Not covered: skills compiled into the free-code binary itself — those
 * only appear in the real `system init` list after the first user turn.
 * The seed's job is to make the `/` popover useful on cold start; the
 * authoritative list wins later (the `systemInitSeen` guard in engine
 * keeps a late seed from clobbering it).
 *
 * Best-effort: any unreadable path is silently skipped.
 */
export async function seedSkillsFromDisk(workspaceDir: string | null): Promise<string[]> {
  const found = new Set<string>()

  // User + project (non-namespaced).
  const bareRoots: string[] = [join(homedir(), '.claude', 'skills')]
  if (workspaceDir) {
    bareRoots.push(join(workspaceDir, '.claude', 'skills'))
  }
  await Promise.all(
    bareRoots.map((root) => scanSkillsRoot(root, null, found))
  )

  // Bundled plugin (the repo-root skills/ shipped with the app). The plugin
  // manifest's name is `claude-desktop`, and `"skills": "./"` makes each
  // immediate subdir a skill — so they surface as `claude-desktop:<name>`,
  // exactly the value fusion-code's `system init` later reports, so the seed
  // and the authoritative list use identical strings (no flicker / dupes).
  const bundledPluginDir = resolveBundledSkillsPluginDir()
  if (bundledPluginDir) {
    await scanSkillsRoot(bundledPluginDir, 'claude-desktop', found)
  }

  // Marketplace-installed skills (~/.cowork/skills). Each installed item is
  // now its own local plugin (2026-07-17 redesign) — `skillsDir` is either
  // the shared root itself (legacy flat hand-placed skills) or
  // `<item>/skills/` (market-installed items with a nested skills/ subdir,
  // see resolveCoworkPluginEntries). Namespace `cowork` MUST equal the
  // plugin.json name every entry's installer writes — that's the exact
  // string fusion-code's `system init` reports later, keeping seed and
  // authoritative list identical (no flicker / dupes).
  await Promise.all(
    resolveCoworkPluginEntries().map((e) => scanSkillsRoot(e.skillsDir, 'cowork', found))
  )

  // Other plugin skills — driven by installed_plugins.json so we never show
  // stale cached plugin versions the user uninstalled.
  const plugins = await readInstalledPlugins()
  await Promise.all(
    plugins.map(async ({ shortName, installPath }) => {
      // Plugins ship skills either flat at `<installPath>/skills/` or
      // nested under `<installPath>/.claude/skills/`. Scan both.
      await scanSkillsRoot(join(installPath, 'skills'), shortName, found)
      await scanSkillsRoot(join(installPath, '.claude', 'skills'), shortName, found)
    })
  )

  return [...found].sort()
}

/**
 * Scan one skills root: each immediate subdir with a SKILL.md is a skill.
 * When `namespace` is non-null, names are prefixed `<namespace>:` to
 * match fusion-code's plugin skill naming.
 */
async function scanSkillsRoot(
  root: string,
  namespace: string | null,
  out: Set<string>
): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries
      // Accept both real dirs AND symlinks (Dirent.isDirectory() does
      // NOT follow symlinks, and a lot of user setups — notably the
      // gstack family — symlink ~/.claude/skills/<name> → gstack/<name>,
      // so filtering on isDirectory() alone drops every linked skill).
      // The `stat(…SKILL.md)` below follows symlinks, so actual
      // validity is checked there.
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map(async (e) => {
        try {
          await stat(join(root, e.name, 'SKILL.md'))
          out.add(namespace ? `${namespace}:${e.name}` : e.name)
        } catch {
          /* no SKILL.md → not a skill dir */
        }
      })
  )
}

interface InstalledPlugin {
  /** Short name used as the skill namespace, e.g. `vercel`. */
  shortName: string
  /** Absolute path on disk — taken verbatim from installed_plugins.json. */
  installPath: string
}

/**
 * Parse `~/.claude/plugins/installed_plugins.json`. Shape (v2):
 *
 *   {
 *     "version": 2,
 *     "plugins": {
 *       "vercel@claude-plugins-official": [
 *         { "installPath": "...", "version": "0.40.0", ... }
 *       ],
 *       ...
 *     }
 *   }
 *
 * The key is `<shortName>@<marketplace>`; we split on `@` and take the
 * head for the namespace. Multiple installs per plugin are rare; we
 * pick the first entry (matches fusion-code behavior of loading one
 * active version per plugin).
 */
async function readInstalledPlugins(): Promise<InstalledPlugin[]> {
  const path = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('plugins' in parsed) ||
    typeof (parsed as { plugins: unknown }).plugins !== 'object' ||
    (parsed as { plugins: unknown }).plugins === null
  ) {
    return []
  }
  const pluginsMap = (parsed as { plugins: Record<string, unknown> }).plugins
  const result: InstalledPlugin[] = []
  for (const [key, value] of Object.entries(pluginsMap)) {
    const shortName = key.split('@', 1)[0]
    if (!shortName) continue
    if (!Array.isArray(value) || value.length === 0) continue
    const first = value[0]
    if (
      typeof first !== 'object' ||
      first === null ||
      typeof (first as { installPath?: unknown }).installPath !== 'string'
    ) {
      continue
    }
    const installPath = (first as { installPath: string }).installPath
    result.push({ shortName, installPath })
  }
  return result
}
