import { z } from 'zod';

// ── Skills Market（Gitee/静态源技能市场）契约 ────────────────────────────
//
// 三方共用：daemon 的 skills-market 引擎（拉取/安装）、发布脚本
// scripts/publish-skills-registry.ts（生成 registry.json）、studio 前端市场页
// （渲染/安装按钮态）。registry 托管在任意静态 HTTP 源（首选 gitee raw，
// COWORK_MARKET_BASE_URL 可整体切换到自建服务器/镜像）。
//
// 目录布局（源仓库与本地安装目录同构，仿 OpenAI Codex 插件缓存的实拍结构：
// `<plugin>/<version>/{assets/,README.md,skills/}`，本项目省掉版本号那层——
// 版本号已经在 manifest.json 里，git 历史本身就是版本记录）。
//
// 2026-07-17 分家：技能与插件不再挤在同一个 `skills/` 前缀下，`kind` 字段
// 同时决定远端前缀目录与本地安装根（见下面的 marketRemoteDirFor）：
//
//   <base>/registry.json                                   ← 聚合清单，客户端唯一入口
//   <base>/skills/<id>/manifest.json                        ← kind=skill 条目
//   <base>/skills/<id>/README.md
//   <base>/skills/<id>/assets/{icon.png,logo.png}
//   <base>/skills/<id>/skills/<subid>/SKILL.md               ← 真正喂给 CLI 的技能内容
//   <base>/plugins/<id>/manifest.json                       ← kind=plugin 条目，结构同上
//   <base>/plugins/<id>/skills/<subid>/SKILL.md
//
// 两份 manifest 分工不同、互不覆盖：
//   - `.claude-plugin/plugin.json`（daemon 安装时在本地合成，不从远端下载）
//     ——fusion-code 唯一认的格式，只有 {name, skills} 两个字段，name 恒为
//     "cowork"，skills 恒指向 "./skills/"。CLI 加载完全不关心 manifest.json。
//   - `manifest.json`（远端下载、由发布脚本从每个 skill 目录生成）
//     ——纯市场展示用，字段仿 Codex 插件 manifest（interface.* 分组），
//     daemon 把它拍平进 registry.json 的条目里供列表/搜索直接渲染，无需
//     逐个下载 manifest.json 才能出目录页。
//
// 「插件」与「技能」安装机制完全相同（都是这套目录结构、同一个
// SkillManifestSchema）；`kind` 现在身兼两职——UI 分流（plugin 走详情页 +
// 示例 prompt 横幅，skill 走轻量弹层）**以及**远端前缀目录/本地安装根的选择
// （kind=skill → <base>/skills/<id> → ~/.cowork/skills/<id>；kind=plugin →
// <base>/plugins/<id> → ~/.cowork/plugins/<id>），见 marketRemoteDirFor()。
//
// 一个 market 条目现在天然可以打包多个技能（条目内 skills/ 下多个 <subid>
// 子目录，各自独立暴露为 `cowork:<subid>`）——多数条目仍是 1:1（skills/ 下
// 只有一个和条目 id 同名的子目录），但 schema 和安装机制都不假设这一点。

/** 与 daemon plugins/installer.ts 的 SAFE_BASENAME 同一条正则：目录名即 id，
 * 首字符必须字母数字（天然排除 `.claude-plugin` / `.staging-*` 等点目录）。 */
export const MARKET_SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** manifest 内文件路径必须是 POSIX 相对路径：拒绝 `..`、绝对路径、反斜杠、
 * 空段与点目录段。parse 期整份拒收（沿用 kbManifest 的防御哲学：坏清单
 * 不进入任何下游逻辑，而不是逐文件跳过）。 */
export function isSafeMarketRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (p.includes('\\') || p.startsWith('/') || p.includes(' ')) return false;
  const segs = p.split('/');
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

export const MarketFileSchema = z.object({
  /** POSIX 相对路径（相对 skills/<id>/），落盘时按平台 join */
  path: z.string().refine(isSafeMarketRelPath),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type MarketFile = z.infer<typeof MarketFileSchema>;

export const MarketEntryKindSchema = z.enum(['plugin', 'skill']);
export type MarketEntryKind = z.infer<typeof MarketEntryKindSchema>;

/** 单一映射源：kind → 远端仓库前缀目录名 == 本地安装根的子目录名。daemon
 * （下载 URL 拼接、本地安装根选择）与发布脚本（扫源目录、校验 kind 与
 * 所在前缀目录一致）共用这一个函数，禁止在别处重复写 'skills'/'plugins'
 * 字面量——两处硬编码迟早漂移。 */
export function marketRemoteDirFor(kind: MarketEntryKind): 'skills' | 'plugins' {
  return kind === 'plugin' ? 'plugins' : 'skills';
}

/** author 三件套，逐字段照抄 Codex manifest 的 `author` 形状 */
export const ManifestAuthorSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
});
export type ManifestAuthor = z.infer<typeof ManifestAuthorSchema>;

/** interface{} 分组 —— 市场展示专属字段，字段名与 Codex manifest 一一对应
 * （composerIcon/logo/defaultPrompt/brandColor 等），方便未来若要接现成的
 * 素材/文案时直接照抄，不用做名字翻译。 */
export const ManifestInterfaceSchema = z.object({
  displayName: z.string().min(1).max(200),
  shortDescription: z.string().max(300),
  longDescription: z.string().max(20000).optional(),
  developerName: z.string().max(200).optional(),
  /** 单个分类 id（对应 registry 顶层 categories[].id）。Codex 原版是单分类；
   * 是否额外出现在"精选"由下面独立的 featured 字段控制，不占用这个字段。 */
  category: z.string().max(64).optional(),
  capabilities: z.array(z.string().max(64)).default([]),
  websiteURL: z.string().max(500).optional(),
  privacyPolicyURL: z.string().max(500).optional(),
  termsOfServiceURL: z.string().max(500).optional(),
  /** 相对 skills/<id>/ 的路径，如 "assets/icon.png"；小图标，列表/mini-tile 用 */
  composerIcon: z.string().refine(isSafeMarketRelPath).optional(),
  /** 相对 skills/<id>/ 的路径；详情页头图用的大 logo，可以是非正方形 */
  logo: z.string().refine(isSafeMarketRelPath).optional(),
  /** 详情页示例 prompt 横幅（UI 只取前 3 条），对应 Codex 的 defaultPrompt */
  defaultPrompt: z.array(z.string().max(500)).max(10).default([]),
  /** #RRGGBB；图标加载前的占位底色、也是详情页横幅的基调色来源 */
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  screenshots: z.array(z.string().refine(isSafeMarketRelPath)).default([]),
});
export type ManifestInterface = z.infer<typeof ManifestInterfaceSchema>;

/** 远端 skills/<id>/manifest.json 的完整 schema —— 发布脚本读它、拍平进
 * registry 条目；daemon 不下发这份原始嵌套结构给客户端（客户端只吃拍平后的
 * MarketEntry），它只是"作者填写市场资料"的编辑态格式。 */
export const SkillManifestSchema = z.object({
  /** 机器名（英文，通常与目录名一致），对应 Codex manifest 顶层 name */
  name: z.string().regex(MARKET_SAFE_ID).max(128),
  version: z.string().min(1).max(64),
  /** 简短描述（列表行副标题），对应 Codex 顶层 description */
  description: z.string().max(2000),
  author: ManifestAuthorSchema.optional(),
  homepage: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  license: z.string().max(100).optional(),
  keywords: z.array(z.string().max(64)).default([]),
  /** 恒为 "./skills/"（约定，发布脚本会校验并强制写成这个值）；kind 是本项目
   * 相对 Codex 原版新增的字段——他们的世界里没有 skill/plugin 之分。 */
  skills: z.literal('./skills/'),
  kind: MarketEntryKindSchema.default('skill'),
  /** 精选：额外出现在市场首屏的"精选"分区（不影响 interface.category 的常规分区） */
  featured: z.boolean().default(false),
  interface: ManifestInterfaceSchema,
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/** 拍平后的 registry 条目 —— interface.* 拍平到顶层。这个 schema 在管线的
 * 两个阶段共用、同一批字段含义随阶段变化：
 *   1. daemon 从 gitee 取 registry.json 时（fetchRegistry/parseMarketRegistry）：
 *      composerIcon/logo/screenshots 是相对路径（"assets/icon.png"），因为
 *      静态发布的 JSON 不可能预先知道运行它的 daemon 会监听哪个端口。
 *   2. daemon 经 GET /api/skills-market/registry 发给前端时：这几个字段被
 *      改写成走 daemon 代理的绝对 URL（/api/skills-market/entries/:id/
 *      assets/...，见 routes.ts），前端不用关心远端 base URL 是什么，也不用
 *      区分"装没装"——远端热链和本地文件用同一个代理端点。
 * 两阶段都是合法字符串，schema 不做相对/绝对路径的强校验，只卡长度。
 * 缺图标时前端退回 brandColor + 首字母渲染，不是硬错误。 */
export const MarketEntrySchema = z.object({
  /** == 仓库子目录名 == 本地安装目录名 */
  id: z.string().regex(MARKET_SAFE_ID).max(128),
  kind: MarketEntryKindSchema,
  name: z.string().min(1).max(128),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000),
  longDescription: z.string().max(20000).optional(),
  version: z.string().min(1).max(64),
  author: ManifestAuthorSchema.optional(),
  developerName: z.string().max(200).optional(),
  homepage: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  license: z.string().max(100).optional(),
  keywords: z.array(z.string().max(64)).default([]),
  category: z.string().max(64).optional(),
  featured: z.boolean().default(false),
  capabilities: z.array(z.string().max(64)).default([]),
  websiteURL: z.string().max(500).optional(),
  privacyPolicyURL: z.string().max(500).optional(),
  termsOfServiceURL: z.string().max(500).optional(),
  composerIcon: z.string().max(1000).optional(),
  logo: z.string().max(1000).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** plugin 详情页示例 prompt 横幅（UI 只取前 3 条） */
  defaultPrompt: z.array(z.string().max(500)).max(10).default([]),
  screenshots: z.array(z.string().max(1000)).default([]),
  files: z.array(MarketFileSchema).min(1),
  totalSize: z.number().int().nonnegative(),
});
export type MarketEntry = z.infer<typeof MarketEntrySchema>;

export const MarketCategorySchema = z.object({
  id: z.string().max(64),
  title: z.string().max(100),
  order: z.number().int().optional(),
});
export type MarketCategory = z.infer<typeof MarketCategorySchema>;

export const MarketRegistrySchema = z.object({
  schemaVersion: z.literal(2),
  generatedAtMs: z.number().int().nonnegative(),
  categories: z.array(MarketCategorySchema).default([]),
  entries: z.array(MarketEntrySchema),
});
export type MarketRegistry = z.infer<typeof MarketRegistrySchema>;

/** 防御解析：schema 校验 + 条目 id 去重 + 文件清单里必须至少有一个
 * `skills/<subid>/SKILL.md`（否则装完 CLI 也加载不到任何东西，视为坏条目）。
 * 任一条不满足返回 null（坏清单整份拒收，不做部分接受）。 */
export function parseMarketRegistry(raw: unknown): MarketRegistry | null {
  const parsed = MarketRegistrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    if (!entry.files.some((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))) return null;
  }
  return parsed.data;
}

// ── 本地安装记账（<安装根>/<id>/.cowork-market.json，安装根按 kind 分家，
// 见 marketRemoteDirFor：skill → ~/.cowork/skills、plugin → ~/.cowork/plugins）
// ──────────────────────────────────────────────────────────────────────
// 目录即真相：meta 随目录删除天然一致，不进 SQLite。files 的 sha 留给
// 增量更新（同 sha 本地 copy 跳过重下）。这份文件与 manifest.json 是两个
// 概念——manifest.json 是下载下来的"作者填写的资料"，.cowork-market.json
// 是安装器自己写的"我怎么装的"记账，两者都在但用途不同。

export const INSTALLED_SKILL_META_FILENAME = '.cowork-market.json';

export const InstalledSkillMetaSchema = z.object({
  id: z.string().regex(MARKET_SAFE_ID),
  kind: MarketEntryKindSchema,
  version: z.string(),
  /** 安装时的 registry base URL（诊断用） */
  source: z.string(),
  files: z.array(MarketFileSchema),
  installedAt: z.number().int().nonnegative(),
});
export type InstalledSkillMeta = z.infer<typeof InstalledSkillMetaSchema>;

// ── daemon HTTP API DTO ───────────────────────────────────────────────────

export interface SkillsMarketInstalledItem {
  /** 目录名（= 市场条目 id，或本地手放目录的名字） */
  name: string;
  /** market=经市场安装（有 meta）；local=用户手放目录（无 meta） */
  origin: 'market' | 'local';
  kind?: MarketEntryKind | undefined;
  version?: string | undefined;
  /** registry 里同 id 条目 version 字符串不等 → 可更新 */
  updateAvailable?: boolean | undefined;
}

/** POST /api/skills-market/install 的 NDJSON 流事件 */
export type SkillsMarketInstallEvent =
  | { kind: 'progress'; phase: 'resolving' | 'downloading' | 'finalizing'; done: number; total: number }
  | { kind: 'success'; meta: InstalledSkillMeta }
  | { kind: 'error'; message: string };
