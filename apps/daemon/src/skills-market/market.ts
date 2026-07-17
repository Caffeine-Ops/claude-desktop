import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  INSTALLED_SKILL_META_FILENAME,
  InstalledSkillMetaSchema,
  MARKET_SAFE_ID,
  marketRemoteDirFor,
  parseMarketRegistry,
  type InstalledSkillMeta,
  type MarketEntry,
  type MarketEntryKind,
  type MarketFile,
  type MarketRegistry,
  type SkillsMarketInstallEvent,
  type SkillsMarketInstalledItem,
} from '@open-design/contracts';

// ── Skills Market 引擎 ────────────────────────────────────────────────────
//
// 从静态 registry 源（默认 gitee raw，COWORK_MARKET_BASE_URL 可整体切换）
// 安装一整套条目目录（manifest.json + README.md + assets/ +
// skills/<subid>/SKILL.md，见 contracts/skills-market.ts 头注释的完整布局
// 说明）。2026-07-17 分家：安装根按条目 kind 二选一——
// kind=skill → ~/.cowork/skills/<id>，kind=plugin → ~/.cowork/plugins/<id>
// （marketRemoteDirFor() 是唯一的映射源，别在别处重复写 'skills'/'plugins'）。
// 刻意不走 plugins/installer.ts：那套安装的是 od 插件（manifest 解析/trust/
// SQLite/od-data 根全不匹配这套布局），这里只借它的安全思路（SAFE id、路径
// 双保险、大小上限）。
//
// 记账哲学：目录即真相。每个装好的条目目录里放一份 .cowork-market.json
// （id/version/files+sha/installedAt），用户手删目录时 meta 一起消失，不会
// 像 SQLite 那样留幽灵记录；files 的 sha 支撑增量更新（同 sha 的文件直接从
// 旧目录 copy，不重下）。它和下载来的 manifest.json 是两码事：
// .cowork-market.json 是安装器自己写的记账，manifest.json 是条目作者填的
// 市场资料，谁都不覆盖谁。
//
// 全部依赖可注入（fetchImpl/nowMs/skillsRoot/并发/上限），bun test 直测，
// 范式同 plugins/installer.ts 的 ArchiveFetcher 与 studio 侧 kbSync.ts。
//
// 代理注意（本仓库历史上反复踩）：daemon 生产态跑在 Node（ELECTRON_RUN_AS_NODE
// spawn dist/cli.js），undici fetch **不读** HTTP_PROXY 等环境变量——gitee 国内
// 直连没问题；但若用 bun 直接跑本模块（脚本/调试），bun 的 fetch **会吃**
// 代理 env，本机地址也会被送进代理（表现为 127.0.0.1 拉出 502）。调试时
// `env -u HTTP_PROXY …` 或注入 fetchImpl。真要走代理的部署，给 fetchImpl
// 注入 EnvHttpProxyAgent 版本即可，接口已 DI。

export interface MarketDeps {
  /** registry 根 URL（不带尾斜杠）。默认读 COWORK_MARKET_BASE_URL，再退到占位 gitee 仓库。 */
  baseUrl?: string;
  /** kind=skill 的安装根。默认 ~/.cowork/skills（COWORK_SKILLS_DIR 可覆盖，与 electron 侧共用同一 env）。 */
  skillsRoot?: string;
  /** kind=plugin 的安装根。默认 ~/.cowork/plugins（COWORK_PLUGINS_DIR 可覆盖，与 electron 侧共用同一 env）。 */
  pluginsRoot?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /** 下载并发，默认 3（对 gitee raw 客气一点）。 */
  concurrency?: number;
  /** 每文件失败重试次数，默认 2（指数退避）。 */
  retries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

// 2026-07-17 建仓完成，占位地址替换为真实仓库；COWORK_MARKET_BASE_URL 仍可
// 覆盖（换镜像/自建服务器，只要按 <base>/registry.json + <base>/skills|plugins/<id>/<path> 布局）。
const DEFAULT_BASE_URL = 'https://gitee.com/guanzhengbing/plugins-skills/raw/main';

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 发布脚本卡 1MiB，运行时留一倍余量
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REGISTRY_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export function resolveMarketBaseUrl(): string {
  const env = process.env.COWORK_MARKET_BASE_URL;
  return (env && env.trim() ? env.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function defaultSkillsRoot(): string {
  const env = process.env.COWORK_SKILLS_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(homedir(), '.cowork', 'skills');
}

export function defaultPluginsRoot(): string {
  const env = process.env.COWORK_PLUGINS_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(homedir(), '.cowork', 'plugins');
}

function resolved(deps: MarketDeps) {
  return {
    baseUrl: (deps.baseUrl ?? resolveMarketBaseUrl()).replace(/\/+$/, ''),
    skillsRoot: deps.skillsRoot ?? defaultSkillsRoot(),
    pluginsRoot: deps.pluginsRoot ?? defaultPluginsRoot(),
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    nowMs: deps.nowMs ?? (() => Date.now()),
    concurrency: deps.concurrency ?? 3,
    retries: deps.retries ?? 2,
    maxFileBytes: deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: deps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
}

/** kind → 安装根的唯一映射点（daemon 内部用；对外 URL 前缀走 contracts 的
 * marketRemoteDirFor，两者含义不同——一个是本地路径，一个是远端目录名，
 * 但都由同一个 kind 驱动，故意保持相邻方便对照）。 */
function rootFor(d: { skillsRoot: string; pluginsRoot: string }, kind: MarketEntryKind): string {
  return kind === 'plugin' ? d.pluginsRoot : d.skillsRoot;
}

// ── registry 拉取（进程内缓存，TTL 5min）─────────────────────────────────

const registryCache = new Map<string, { atMs: number; registry: MarketRegistry }>();

export async function fetchRegistry(
  deps: MarketDeps = {},
  opts: { refresh?: boolean } = {},
): Promise<MarketRegistry> {
  const d = resolved(deps);
  const cached = registryCache.get(d.baseUrl);
  if (!opts.refresh && cached && d.nowMs() - cached.atMs < REGISTRY_TTL_MS) {
    return cached.registry;
  }
  const raw = await fetchWithTimeout(d.fetchImpl, `${d.baseUrl}/registry.json`);
  if (!raw.ok) throw new Error(`registry fetch failed: HTTP ${raw.status}`);
  let json: unknown;
  try {
    json = await raw.json();
  } catch {
    throw new Error('registry fetch failed: invalid JSON');
  }
  const registry = parseMarketRegistry(json);
  if (!registry) throw new Error('registry rejected: schema/path-safety validation failed');
  registryCache.set(d.baseUrl, { atMs: d.nowMs(), registry });
  return registry;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── 已安装列表（扫目录，目录即真相）──────────────────────────────────────
//
// 一个已装条目在磁盘上长这样（新布局，见文件头注释；`<root>` 是 skillsRoot
// 或 pluginsRoot 二者之一，2026-07-17 分家后按 kind 各自独立）：
//   <root>/<id>/.claude-plugin/plugin.json   ← 安装器合成，本函数不读它
//   <root>/<id>/.cowork-market.json          ← 安装器合成的记账文件
//   <root>/<id>/manifest.json                ← 下载来的市场资料（可选，手放目录可能没有）
//   <root>/<id>/skills/<subid>/SKILL.md      ← 真正的技能内容，至少一个
//
// 「这是不是一个技能目录」的判定改成看有没有 `.claude-plugin/plugin.json`
// 或 `skills/` 下至少一个 `SKILL.md`——不再要求 SKILL.md 直接在条目根目录，
// 因为新布局里它总在一层 `skills/<subid>/` 之下。仍然兼容用户手放的老式
// 扁平目录（SKILL.md 直接放在 <id>/ 下，没有 skills/ 子目录、没有
// .claude-plugin），这类目录靠仓库根共享的 plugin.json 兜底加载（见
// resolveCoworkPluginEntries 的注释），origin 标 'local'。两个根都扫、结果
// 拼接——正常情况下 id 在两根间不会重名（registry 层面全局去重），手放目录
// 理论上可能撞名，属于用户自己造成的边界情况，不特殊处理。

export async function listInstalled(
  deps: MarketDeps = {},
  registry?: MarketRegistry,
): Promise<SkillsMarketInstalledItem[]> {
  const d = resolved(deps);
  const byId = new Map(registry?.entries.map((e) => [e.id, e]) ?? []);
  const [skills, plugins] = await Promise.all([
    listInstalledInRoot(d.skillsRoot, byId),
    listInstalledInRoot(d.pluginsRoot, byId),
  ]);
  return [...skills, ...plugins];
}

async function listInstalledInRoot(
  root: string,
  byId: Map<string, MarketEntry>,
): Promise<SkillsMarketInstalledItem[]> {
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 = 这个根还没装过任何东西
  }
  const out: SkillsMarketInstalledItem[] = [];
  for (const ent of dirents) {
    // 点目录（.claude-plugin / .staging-* / .trash-*）不是条目
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const dir = path.join(root, ent.name);
    const looksLikeItem =
      (await exists(path.join(dir, '.claude-plugin', 'plugin.json'))) ||
      (await hasAnySkillMd(path.join(dir, 'skills'))) ||
      (await exists(path.join(dir, 'SKILL.md'))); // 老式扁平手放目录兜底
    if (!looksLikeItem) continue;
    const meta = await readMeta(dir);
    if (meta) {
      const remote = byId.get(meta.id);
      out.push({
        name: ent.name,
        origin: 'market',
        kind: meta.kind,
        version: meta.version,
        updateAvailable: remote ? remote.version !== meta.version : undefined,
      });
    } else {
      out.push({ name: ent.name, origin: 'local' });
    }
  }
  return out;
}

async function hasAnySkillMd(skillsSubdir: string): Promise<boolean> {
  let dirents;
  try {
    dirents = await fs.readdir(skillsSubdir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of dirents) {
    if (ent.isDirectory() && (await exists(path.join(skillsSubdir, ent.name, 'SKILL.md')))) {
      return true;
    }
  }
  return false;
}

async function readMeta(dir: string): Promise<InstalledSkillMeta | null> {
  try {
    const raw = await fs.readFile(path.join(dir, INSTALLED_SKILL_META_FILENAME), 'utf8');
    const parsed = InstalledSkillMetaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── .claude-plugin/plugin.json（让目录树对 fusion-code 可见）───────────────
//
// 这是 fusion-code 唯一认的格式（{name, skills} 两个字段），和下载来的市场
// 展示用 manifest.json 是两回事、互不覆盖（见文件头注释的分工说明）。
// engine.ts 侧的 resolveCoworkPluginEntries() 以「manifest 在才算数」为守卫
// （同 bundled skills 的规矩），所以每次安装都要幂等写出来。name 恒为
// "cowork"——决定 skill 的命名空间前缀（cowork:<subid>），改名会让所有
// 已装 skill 的触发名全部闪变，**这个值一旦发布就不要动**。
//
// 两个写手，对应两种目录形态：
//   - ensureItemPluginManifest：写在 <root>/<id>/.claude-plugin/（root 是
//     skillsRoot 或 pluginsRoot，由条目 kind 决定），skills 指向 "./skills/"
//     ——市场安装的新布局，每个条目自己独立注册成一个 local plugin，天然支持
//     一个条目打包多个技能（skills/ 下多个子目录）。
//   - ensureRootPluginManifest：只写在 <skillsRoot>/.claude-plugin/（不对
//     pluginsRoot 做，插件永远来自市场、每个条目自带 plugin.json，没有"手放
//     插件"这种场景），skills 指向 "./"——只服务用户手放的老式扁平目录
//     （SKILL.md 直接放在 <skillsRoot>/<name>/ 下，没走市场）。市场安装的
//     条目因为 SKILL.md 不在这一层，不会被这份根 manifest 重复扫到，两者
//     不冲突。

function pluginManifestContent(skillsRelPath: '.' | 'skills'): string {
  const manifest = {
    name: 'cowork',
    version: '0.0.1',
    description:
      'Cowork skills market install root, exposed to the fusion-code agent as plugin skills (namespaced cowork:<skill>).',
    skills: skillsRelPath === '.' ? './' : './skills/',
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writePluginManifestIfMissing(
  dir: string,
  skillsRelPath: '.' | 'skills',
): Promise<void> {
  const manifestDir = path.join(dir, '.claude-plugin');
  const manifestPath = path.join(manifestDir, 'plugin.json');
  if (await exists(manifestPath)) return;
  await fs.mkdir(manifestDir, { recursive: true });
  // tmp+rename 原子写（同 publish-kb-manifest 的规矩），防半写文件被 CLI 读到
  const tmp = path.join(manifestDir, `.plugin.json.tmp-${randomBytes(4).toString('hex')}`);
  await fs.writeFile(tmp, pluginManifestContent(skillsRelPath), 'utf8');
  await fs.rename(tmp, manifestPath);
}

export async function ensureRootPluginManifest(skillsRoot: string): Promise<void> {
  await writePluginManifestIfMissing(skillsRoot, '.');
}

export async function ensureItemPluginManifest(itemDir: string): Promise<void> {
  await writePluginManifestIfMissing(itemDir, 'skills');
}

// ── 安装 ─────────────────────────────────────────────────────────────────

export async function* installSkill(
  deps: MarketDeps,
  id: string,
): AsyncGenerator<SkillsMarketInstallEvent> {
  const d = resolved(deps);
  // staging 的落点依赖 entry.kind（skillsRoot 还是 pluginsRoot），只有拿到
  // registry 条目之后才能确定——故 staging 延后到 try 内部才赋值，catch
  // 块靠这个可选变量判断"有没有留下半成品目录要清理"。
  let staging: string | undefined;
  // 池句柄放 try 外：失败路径要先等所有在飞请求收尾（allSettled），
  // 否则 rm(staging) 之后慢请求的 mkdir/writeFile 会把 staging 目录写回来
  const inflight = new Set<Promise<void>>();
  try {
    yield { kind: 'progress', phase: 'resolving', done: 0, total: 1 };
    if (!MARKET_SAFE_ID.test(id)) throw new Error(`invalid skill id: ${id}`);
    const registry = await fetchRegistry(deps);
    const entry = registry.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`skill "${id}" not found in registry`);
    const declaredTotal = entry.files.reduce((sum, f) => sum + f.size, 0);
    if (declaredTotal > d.maxTotalBytes) {
      throw new Error(`skill "${id}" exceeds total size limit`);
    }

    const root = rootFor(d, entry.kind);
    // 局部非可选副本：`staging` 外层变量是 string|undefined（供 catch 块判断
    // 是否有半成品要清理），闭包里传给 fetchOneFile 的必须是已确定的 string。
    const stagingDir = path.join(root, `.staging-${randomBytes(6).toString('hex')}`);
    staging = stagingDir;

    // 根级兼容 manifest（供用户手放的老式扁平技能用）幂等确保存在——只对
    // skillsRoot 做（插件没有"手放"这种场景，见上方写手说明）。放在这里而
    // 不是要求用户自己创建，因为一旦装过市场东西就说明目录已经在用，顺手
    // 把兜底也铺好成本几乎为零。
    if (entry.kind === 'skill') await ensureRootPluginManifest(d.skillsRoot);
    await fs.mkdir(stagingDir, { recursive: true });
    // 条目自己的 .claude-plugin/plugin.json 写进 staging——rename 上位后自动
    // 落在正确位置（staging/.claude-plugin/... → <id>/.claude-plugin/...），
    // 不需要在最终目录再补一次。
    await ensureItemPluginManifest(stagingDir);

    // 旧安装的 sha 索引：同 sha 的文件本地 copy，不重下（增量更新的核心）
    const targetDir = path.join(root, entry.id);
    const oldMeta = await readMeta(targetDir);
    const oldShaByPath = new Map(oldMeta?.files.map((f) => [f.path, f.sha256]) ?? []);

    // 并发池下载：在飞集合 + Promise.race，每完成一个文件吐一次进度。
    // 首个失败即整体失败——catch 里删 staging，旧安装原样保留（不半应用）。
    let done = 0;
    const total = entry.files.length;
    const queue = [...entry.files];
    const launch = (file: MarketFile) => {
      const p: Promise<void> = fetchOneFile(d, entry, file, stagingDir, targetDir, oldShaByPath)
        .then(() => {
          done += 1;
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    };
    while (queue.length > 0 || inflight.size > 0) {
      while (queue.length > 0 && inflight.size < d.concurrency) launch(queue.shift()!);
      await Promise.race(inflight);
      yield { kind: 'progress', phase: 'downloading', done, total };
    }

    yield { kind: 'progress', phase: 'finalizing', done: total, total };
    const meta: InstalledSkillMeta = {
      id: entry.id,
      kind: entry.kind,
      version: entry.version,
      source: d.baseUrl,
      files: entry.files,
      installedAt: d.nowMs(),
    };
    await fs.writeFile(
      path.join(stagingDir, INSTALLED_SKILL_META_FILENAME),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8',
    );

    // 原子换名：旧目录先挪 .trash 兜底，staging 上位失败时可回滚
    const trash = path.join(root, `.trash-${randomBytes(6).toString('hex')}`);
    const hadOld = await exists(targetDir);
    if (hadOld) await fs.rename(targetDir, trash);
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (err) {
      if (hadOld) await fs.rename(trash, targetDir).catch(() => {});
      throw err;
    }
    if (hadOld) await fs.rm(trash, { recursive: true, force: true });

    yield { kind: 'success', meta };
  } catch (err) {
    await Promise.allSettled([...inflight]);
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchOneFile(
  d: ReturnType<typeof resolved>,
  entry: MarketEntry,
  file: MarketFile,
  staging: string,
  oldDir: string,
  oldShaByPath: Map<string, string>,
): Promise<void> {
  // 路径双保险：schema 的 isSafeMarketRelPath 已拒 ../绝对/反斜杠，这里再
  // resolve 一次确认落在 staging 里（防未来 schema 松动时静默逃逸）
  const dest = path.resolve(staging, ...file.path.split('/'));
  if (!dest.startsWith(path.resolve(staging) + path.sep)) {
    throw new Error(`unsafe file path: ${file.path}`);
  }
  if (file.size > d.maxFileBytes) {
    throw new Error(`file too large: ${file.path} (${file.size} bytes)`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });

  // 增量：旧安装里同路径同 sha → 直接 copy（copy 后不再验 sha，安装时已验过）
  if (oldShaByPath.get(file.path) === file.sha256) {
    const oldFile = path.resolve(oldDir, ...file.path.split('/'));
    try {
      await fs.copyFile(oldFile, dest);
      return;
    } catch {
      // 旧文件丢了（用户手删）→ 落回网络下载
    }
  }

  const url = `${d.baseUrl}/${marketRemoteDirFor(entry.kind)}/${entry.id}/${file.path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= d.retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
    try {
      const res = await fetchWithTimeout(d.fetchImpl, url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${file.path}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > d.maxFileBytes) {
        throw new FatalInstallError(`file too large: ${file.path}`);
      }
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== file.sha256) {
        // sha 不符不重试：内容错了重试也不会对，直接判定清单/源不一致
        throw new FatalInstallError(`sha256 mismatch for ${file.path}`);
      }
      await fs.writeFile(dest, bytes);
      return;
    } catch (err) {
      if (err instanceof FatalInstallError) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `download failed for ${file.path}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

class FatalInstallError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 卸载 ─────────────────────────────────────────────────────────────────

export async function uninstallSkill(
  deps: MarketDeps,
  name: string,
): Promise<{ ok: boolean; warning?: string }> {
  const d = resolved(deps);
  // MARKET_SAFE_ID 首字符必须字母数字——天然拒掉 .claude-plugin/.staging-* 等
  // 点目录与路径穿越（不含 / 或 ..），无需再 resolve 比对
  if (!MARKET_SAFE_ID.test(name)) {
    return { ok: false, warning: `invalid skill name: ${name}` };
  }
  // 不知道调用方要卸载的是 skill 还是 plugin，两个根都探一下——正常只会
  // 命中其中一个（id 全局唯一），命中哪个删哪个。
  for (const root of [d.skillsRoot, d.pluginsRoot]) {
    const dir = path.join(root, name);
    if (await exists(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: true };
    }
  }
  return { ok: false, warning: 'not installed' };
}
