// Skills-market 引擎：DI fetcher 喂假 registry/文件 + tmp skillsRoot/pluginsRoot 沙箱，
// 覆盖安装/增量更新/sha 不符拒收/路径逃逸拒收/失败不半应用/卸载/
// per-item plugin.json 正确性/根级兼容 manifest。范式同 plugins-installer.test.ts。
//
// 新布局（2026-07-17 redesign，同日又做了 skills/plugins 双根分家）：每个
// 条目按 kind 装进两个根之一：
//   <skillsRoot 或 pluginsRoot>/<id>/{manifest.json?, README.md?, assets/**?,
//     skills/<subid>/SKILL.md, .claude-plugin/plugin.json（安装器合成）,
//     .cowork-market.json（安装器合成）}
// 一个条目可以打包多个 skills/<subid>/ 子目录；测试默认场景仍是 1:1
// （skills/<id>/SKILL.md 与条目同名），除非专门测多技能打包。默认 kind='skill'
// （落 skillsRoot），显式传 kind:'plugin' 的用例落 pluginsRoot。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureRootPluginManifest,
  fetchRegistry,
  installSkill,
  listInstalled,
  uninstallSkill,
  type MarketDeps,
} from '../src/skills-market/market.js';
import {
  marketRemoteDirFor,
  parseMarketRegistry,
  type MarketEntry,
  type MarketEntryKind,
  type MarketRegistry,
  type SkillsMarketInstallEvent,
} from '@open-design/contracts';

let tmpRoot: string;
let skillsRoot: string;
let pluginsRoot: string;
// fetchRegistry 有按 baseUrl 的进程内缓存，每个测试用独立 base 防串扰
let baseSeq = 0;
let baseUrl: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'skills-market-'));
  skillsRoot = path.join(tmpRoot, 'skills');
  pluginsRoot = path.join(tmpRoot, 'plugins');
  baseUrl = `https://market.test/r${++baseSeq}`;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** fetchRegistry 按 baseUrl 缓存（TTL 内不重拉），同一测试里要发布
 * 「新版 registry」时换一个 base 模拟——生产上对应 refresh=1 或 TTL 过期 */
function nextBase(): void {
  baseUrl = `https://market.test/r${++baseSeq}`;
}

/** 由 {path: content} 生成 entry.files + 假文件存储。files 的 key 是相对
 * <remoteDir>/<id>/ 的完整路径（如 "skills/<id>/SKILL.md"、"manifest.json"）
 * ——调用方自己决定布局，帮助函数不做任何路径拼接假设之外的事。远端 URL 前缀
 * （skills/ 或 plugins/）由 overrides.kind 决定（默认 'skill' → 'skills/'），
 * 必须先于 store 的 URL 拼接求出 kind，否则 kind='plugin' 的用例文件会存在
 * 错误的 URL 键下，测试装的时候 404。 */
function makeEntry(
  id: string,
  files: Record<string, string>,
  overrides: Partial<MarketEntry> = {},
): { entry: MarketEntry; store: Map<string, string> } {
  const kind: MarketEntryKind = overrides.kind ?? 'skill';
  const remoteDir = marketRemoteDirFor(kind);
  const store = new Map<string, string>();
  const fileList = Object.entries(files).map(([p, content]) => {
    store.set(`${baseUrl}/${remoteDir}/${id}/${p}`, content);
    return { path: p, sha256: sha256(content), size: Buffer.byteLength(content) };
  });
  const entry: MarketEntry = {
    id,
    kind,
    name: id,
    displayName: id,
    description: `${id} desc`,
    version: '1.0.0',
    keywords: [],
    featured: false,
    capabilities: [],
    defaultPrompt: [],
    screenshots: [],
    files: fileList,
    totalSize: fileList.reduce((s, f) => s + f.size, 0),
    ...overrides,
  };
  return { entry, store };
}

/** 1:1 场景的便捷封装：其余非 skills/ 文件（manifest.json 等）+ 唯一的
 * skills/<id>/SKILL.md（内容可覆盖）。 */
function makeSimpleEntry(
  id: string,
  skillMdBody: string,
  extraFiles: Record<string, string> = {},
  overrides: Partial<MarketEntry> = {},
): { entry: MarketEntry; store: Map<string, string> } {
  return makeEntry(id, { [`skills/${id}/SKILL.md`]: skillMdBody, ...extraFiles }, overrides);
}

function makeDeps(
  registry: MarketRegistry,
  store: Map<string, string>,
  log?: string[],
): MarketDeps {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    log?.push(url);
    if (url === `${baseUrl}/registry.json`) {
      return new Response(JSON.stringify(registry), { status: 200 });
    }
    const body = store.get(url);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { baseUrl, skillsRoot, pluginsRoot, fetchImpl, retries: 0, nowMs: () => 1_752_000_000_000 };
}

function registryOf(...entries: MarketEntry[]): MarketRegistry {
  return { schemaVersion: 2, generatedAtMs: 1, categories: [], entries };
}

async function runInstall(deps: MarketDeps, id: string): Promise<SkillsMarketInstallEvent[]> {
  const events: SkillsMarketInstallEvent[] = [];
  for await (const ev of installSkill(deps, id)) events.push(ev);
  return events;
}

describe('installSkill', () => {
  it('installs nested skill files, meta, and its own plugin.json', async () => {
    const { entry, store } = makeSimpleEntry('demo', '# demo skill', {
      'skills/demo/scripts/run.py': 'print(1)',
      'manifest.json': '{"ok":true}',
    });
    const events = await runInstall(makeDeps(registryOf(entry), store), 'demo');
    const last = events.at(-1);
    expect(last?.kind).toBe('success');

    const dir = path.join(skillsRoot, 'demo');
    expect(await readFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo skill');
    expect(await readFile(path.join(dir, 'skills', 'demo', 'scripts', 'run.py'), 'utf8')).toBe('print(1)');
    expect(await readFile(path.join(dir, 'manifest.json'), 'utf8')).toBe('{"ok":true}');

    const meta = JSON.parse(await readFile(path.join(dir, '.cowork-market.json'), 'utf8'));
    expect(meta.id).toBe('demo');
    expect(meta.version).toBe('1.0.0');

    // 条目自己的 plugin.json——skills 指向 "./skills/"，不是共享根的 "./"
    const itemManifest = JSON.parse(
      await readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(itemManifest.name).toBe('cowork');
    expect(itemManifest.skills).toBe('./skills/');

    // 根级兼容 manifest 也顺手铺好了（供手放老式扁平技能用），skills 指向 "./"
    const rootManifest = JSON.parse(
      await readFile(path.join(skillsRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(rootManifest.skills).toBe('./');

    // 无 staging/trash 残留
    const leftovers = (await readdir(skillsRoot)).filter((n) => n.startsWith('.staging') || n.startsWith('.trash'));
    expect(leftovers).toEqual([]);
  });

  it('supports one entry bundling multiple sub-skills', async () => {
    const { entry, store } = makeEntry('bundle', {
      'skills/one/SKILL.md': 'skill one',
      'skills/two/SKILL.md': 'skill two',
    });
    const events = await runInstall(makeDeps(registryOf(entry), store), 'bundle');
    expect(events.at(-1)?.kind).toBe('success');
    const dir = path.join(skillsRoot, 'bundle');
    expect(await readFile(path.join(dir, 'skills', 'one', 'SKILL.md'), 'utf8')).toBe('skill one');
    expect(await readFile(path.join(dir, 'skills', 'two', 'SKILL.md'), 'utf8')).toBe('skill two');
  });

  it('installs a plugin-kind entry into pluginsRoot, not skillsRoot', async () => {
    const { entry, store } = makeSimpleEntry('demo-plugin', '# demo plugin', {}, { kind: 'plugin' });
    const events = await runInstall(makeDeps(registryOf(entry), store), 'demo-plugin');
    expect(events.at(-1)?.kind).toBe('success');

    const dir = path.join(pluginsRoot, 'demo-plugin');
    expect(await readFile(path.join(dir, 'skills', 'demo-plugin', 'SKILL.md'), 'utf8')).toBe(
      '# demo plugin',
    );
    const itemManifest = JSON.parse(
      await readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(itemManifest.skills).toBe('./skills/');

    // 落进 pluginsRoot，不落进 skillsRoot；插件没有"手放"场景，根级兼容
    // manifest 只服务 skillsRoot，不该被插件安装顺手创建
    expect(existsSync(path.join(skillsRoot, 'demo-plugin'))).toBe(false);
    expect(existsSync(path.join(skillsRoot, '.claude-plugin', 'plugin.json'))).toBe(false);
  });

  it('regenerates the item plugin.json on every install (deterministic, not sticky)', async () => {
    const { entry, store } = makeSimpleEntry('demo', 'x');
    await runInstall(makeDeps(registryOf(entry), store), 'demo');
    const manifestPath = path.join(skillsRoot, 'demo', '.claude-plugin', 'plugin.json');
    await writeFile(manifestPath, '{"name":"tampered","skills":"./skills/"}', 'utf8');

    nextBase();
    const { entry: v2, store: store2 } = makeSimpleEntry('demo', 'y', {}, { version: '2.0.0' });
    await runInstall(makeDeps(registryOf(v2), store2), 'demo');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.name).toBe('cowork'); // 手改的内容被下一次安装重新覆盖为规范内容
  });

  it('incremental update: unchanged files are copied locally, not re-downloaded', async () => {
    const { entry: v1, store: store1 } = makeSimpleEntry('demo', 'v1 body', {
      'skills/demo/assets/big.txt': 'unchanged payload',
    });
    await runInstall(makeDeps(registryOf(v1), store1), 'demo');

    nextBase();
    const { entry: v2, store: store2 } = makeSimpleEntry(
      'demo',
      'v2 body',
      { 'skills/demo/assets/big.txt': 'unchanged payload' },
      { version: '2.0.0' },
    );
    const log: string[] = [];
    const events = await runInstall(makeDeps(registryOf(v2), store2, log), 'demo');
    expect(events.at(-1)?.kind).toBe('success');
    expect(await readFile(path.join(skillsRoot, 'demo', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('v2 body');
    // 只有变更文件与 registry 走网络，unchanged 走本地 copy
    expect(log.some((u) => u.endsWith('/skills/demo/skills/demo/SKILL.md'))).toBe(true);
    expect(log.some((u) => u.endsWith('/skills/demo/skills/demo/assets/big.txt'))).toBe(false);
    const meta = JSON.parse(
      await readFile(path.join(skillsRoot, 'demo', '.cowork-market.json'), 'utf8'),
    );
    expect(meta.version).toBe('2.0.0');
  });

  it('rejects sha mismatch and leaves nothing behind', async () => {
    const { entry, store } = makeSimpleEntry('demo', 'real body');
    store.set(`${baseUrl}/skills/demo/skills/demo/SKILL.md`, 'tampered body');
    const events = await runInstall(makeDeps(registryOf(entry), store), 'demo');
    const last = events.at(-1);
    expect(last?.kind).toBe('error');
    expect(last && 'message' in last ? last.message : '').toContain('sha256 mismatch');
    expect(existsSync(path.join(skillsRoot, 'demo'))).toBe(false);
    const leftovers = existsSync(skillsRoot)
      ? (await readdir(skillsRoot)).filter((n) => n.startsWith('.staging'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('a failed update keeps the previous install intact', async () => {
    const { entry: v1, store: store1 } = makeSimpleEntry('demo', 'v1 body');
    await runInstall(makeDeps(registryOf(v1), store1), 'demo');

    nextBase();
    const { entry: v2, store: store2 } = makeSimpleEntry('demo', 'v2 body', {}, { version: '2.0.0' });
    store2.delete(`${baseUrl}/skills/demo/skills/demo/SKILL.md`); // 下载 404
    const events = await runInstall(makeDeps(registryOf(v2), store2), 'demo');
    expect(events.at(-1)?.kind).toBe('error');
    // 旧安装原样保留
    expect(await readFile(path.join(skillsRoot, 'demo', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('v1 body');
  });

  it('rejects an id missing from the registry', async () => {
    const { entry, store } = makeSimpleEntry('demo', 'x');
    const events = await runInstall(makeDeps(registryOf(entry), store), 'ghost');
    expect(events.at(-1)?.kind).toBe('error');
  });
});

describe('registry parsing / path safety', () => {
  it('rejects path escape in file lists at parse time', () => {
    const bad = {
      schemaVersion: 2,
      generatedAtMs: 1,
      categories: [],
      entries: [{
        id: 'evil', kind: 'skill', name: 'evil', displayName: 'evil', description: 'x', version: '1',
        keywords: [], featured: false, capabilities: [], defaultPrompt: [], screenshots: [],
        files: [
          { path: 'skills/evil/SKILL.md', sha256: 'a'.repeat(64), size: 1 },
          { path: '../escape.txt', sha256: 'a'.repeat(64), size: 1 },
        ],
        totalSize: 2,
      }],
    };
    expect(parseMarketRegistry(bad)).toBeNull();
  });

  it('rejects entries without a nested skills/<subid>/SKILL.md and duplicate ids', () => {
    const noSkillMd = registryOf(makeEntry('a', { 'other.md': 'x' }).entry);
    expect(parseMarketRegistry(noSkillMd)).toBeNull();
    // 老布局（SKILL.md 直接在条目根）不再满足新 schema——必须在 skills/<subid>/ 下
    const flatSkillMd = registryOf(makeEntry('a', { 'SKILL.md': 'x' }).entry);
    expect(parseMarketRegistry(flatSkillMd)).toBeNull();
    const dup = registryOf(
      makeSimpleEntry('a', 'x').entry,
      makeSimpleEntry('a', 'y').entry,
    );
    expect(parseMarketRegistry(dup)).toBeNull();
  });

  it('fetchRegistry rejects an invalid registry body', async () => {
    const deps = makeDeps(registryOf(), new Map());
    const badFetch = (async () => new Response('{"schemaVersion":1}', { status: 200 })) as typeof fetch;
    await expect(fetchRegistry({ ...deps, fetchImpl: badFetch })).rejects.toThrow(/rejected|failed/);
  });
});

describe('listInstalled / uninstall', () => {
  it('lists market and local skills, flags updates', async () => {
    const { entry, store } = makeSimpleEntry('demo', 'x');
    const deps = makeDeps(registryOf(entry), store);
    await runInstall(deps, 'demo');
    // 手放的本地 skill（老式扁平布局，无 meta，SKILL.md 直接在根）
    await mkdir(path.join(skillsRoot, 'handmade'), { recursive: true });
    await writeFile(path.join(skillsRoot, 'handmade', 'SKILL.md'), 'local', 'utf8');
    // 没有 SKILL.md 的目录不算条目
    await mkdir(path.join(skillsRoot, 'not-a-skill'), { recursive: true });

    const bumped = registryOf({ ...entry, version: '3.0.0' });
    const items = await listInstalled(deps, bumped);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(['demo', 'handmade']);
    const demo = items.find((i) => i.name === 'demo');
    expect(demo?.origin).toBe('market');
    expect(demo?.updateAvailable).toBe(true);
    expect(items.find((i) => i.name === 'handmade')?.origin).toBe('local');
  });

  it('merges installed items across skillsRoot and pluginsRoot', async () => {
    const { entry: skillEntry, store: skillStore } = makeSimpleEntry('demo-skill', 'x');
    const { entry: pluginEntry, store: pluginStore } = makeSimpleEntry(
      'demo-plugin',
      'y',
      {},
      { kind: 'plugin' },
    );
    const deps = makeDeps(registryOf(skillEntry, pluginEntry), new Map([...skillStore, ...pluginStore]));
    await runInstall(deps, 'demo-skill');
    await runInstall(deps, 'demo-plugin');

    const items = await listInstalled(deps, registryOf(skillEntry, pluginEntry));
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('demo-skill')?.kind).toBe('skill');
    expect(byName.get('demo-plugin')?.kind).toBe('plugin');
    expect(byName.size).toBe(2);
  });

  it('uninstall removes the directory and rejects dot names', async () => {
    const { entry, store } = makeSimpleEntry('demo', 'x');
    const deps = makeDeps(registryOf(entry), store);
    await runInstall(deps, 'demo');
    expect((await uninstallSkill(deps, 'demo')).ok).toBe(true);
    expect(existsSync(path.join(skillsRoot, 'demo'))).toBe(false);
    expect((await uninstallSkill(deps, 'demo')).ok).toBe(false);
    expect((await uninstallSkill(deps, '.claude-plugin')).ok).toBe(false);
    expect(existsSync(path.join(skillsRoot, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect((await uninstallSkill(deps, '../outside')).ok).toBe(false);
  });

  it('uninstall finds a plugin-kind item in pluginsRoot', async () => {
    const { entry, store } = makeSimpleEntry('demo-plugin', 'x', {}, { kind: 'plugin' });
    const deps = makeDeps(registryOf(entry), store);
    await runInstall(deps, 'demo-plugin');
    expect(existsSync(path.join(pluginsRoot, 'demo-plugin'))).toBe(true);
    expect((await uninstallSkill(deps, 'demo-plugin')).ok).toBe(true);
    expect(existsSync(path.join(pluginsRoot, 'demo-plugin'))).toBe(false);
  });

  it('ensureRootPluginManifest writes atomically once and is idempotent', async () => {
    await ensureRootPluginManifest(skillsRoot);
    const first = await readFile(path.join(skillsRoot, '.claude-plugin', 'plugin.json'), 'utf8');
    await ensureRootPluginManifest(skillsRoot);
    expect(await readFile(path.join(skillsRoot, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(first);
    const parsed = JSON.parse(first);
    expect(parsed.name).toBe('cowork');
    expect(parsed.skills).toBe('./');
  });
});
