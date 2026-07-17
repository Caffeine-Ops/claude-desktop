import type { Express } from 'express';
import {
  isSafeMarketRelPath,
  MARKET_SAFE_ID,
  marketRemoteDirFor,
  type MarketEntry,
} from '@open-design/contracts';
import {
  fetchRegistry,
  installSkill,
  listInstalled,
  resolveMarketBaseUrl,
  uninstallSkill,
} from './market.js';

// ── /api/skills-market/* ─────────────────────────────────────────────────
//
// 挂 /api 前缀：dev 由 next.config rewrites、prod 由 appProtocol 的
// DAEMON_PROXY_PREFIXES 自动反代，前端相对路径 fetch 两端直通（新端点
// 不在 /api 下 prod 会 404——这是规约不是巧合，别挪）。
//
// install 走 SSE（同 POST /api/plugins/install 的事件形状：event: <kind> +
// data JSON，终态 success/error 后断流）；v1 前端只消费终态即可。

/** composerIcon/logo/screenshots 在 GET /registry 里从"相对路径"改写成
 * "走本 daemon 代理的绝对路径"（见 contracts MarketEntrySchema 头注释的两
 * 阶段说明）。前端永远不用知道远端 gitee/自建服务器的 base URL 是什么。 */
function toAssetProxyPath(id: string, relPath: string | undefined): string | undefined {
  if (!relPath) return undefined;
  return `/api/skills-market/entries/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(relPath)}`;
}

function rewriteEntryAssetPaths(entry: MarketEntry): MarketEntry {
  return {
    ...entry,
    composerIcon: toAssetProxyPath(entry.id, entry.composerIcon),
    logo: toAssetProxyPath(entry.id, entry.logo),
    screenshots: entry.screenshots
      .map((p) => toAssetProxyPath(entry.id, p))
      .filter((p): p is string => !!p),
  };
}

export function registerSkillsMarketRoutes(app: Express): void {
  app.get('/api/skills-market/registry', async (req, res) => {
    try {
      const registry = await fetchRegistry({}, { refresh: req.query.refresh === '1' });
      res.json({ ...registry, entries: registry.entries.map(rewriteEntryAssetPaths) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/skills-market/installed', async (_req, res) => {
    try {
      // registry 拉不到不阻塞已安装列表（离线也要能看本地装了什么），
      // 只是 updateAvailable 缺席
      const registry = await fetchRegistry({}).catch(() => undefined);
      res.json({ installed: await listInstalled({}, registry) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/skills-market/install', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      for await (const ev of installSkill({}, id)) {
        writeEvent(ev.kind, ev);
        if (ev.kind === 'success' || ev.kind === 'error') break;
      }
    } catch (err) {
      writeEvent('error', { kind: 'error', message: String(err) });
    } finally {
      res.end();
    }
  });

  app.post('/api/skills-market/uninstall', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    try {
      const result = await uninstallSkill({}, name);
      if (!result.ok) {
        return res.status(result.warning === 'not installed' ? 404 : 400).json(result);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 技能弹层的 README 面板：代理拉条目的 README.md（人类可读的市场说明，
  // 不是喂给 CLI 的 SKILL.md）。id 必须在 registry 里，免前端直连 gitee 的 CORS。
  app.get('/api/skills-market/entries/:id/readme', async (req, res) => {
    try {
      const registry = await fetchRegistry({});
      const entry = registry.entries.find((e) => e.id === req.params.id);
      if (!entry) {
        return res.status(404).json({ error: 'entry not found' });
      }
      const url = `${resolveMarketBaseUrl()}/${marketRemoteDirFor(entry.kind)}/${entry.id}/README.md`;
      const raw = await fetch(url);
      if (!raw.ok) {
        return res.status(502).json({ error: `HTTP ${raw.status}` });
      }
      res.json({ content: await raw.text() });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 图标/logo/截图代理：?path 必须是该条目 manifest 里声明过的 composerIcon/
  // logo/screenshots 之一（不接受任意路径——这个端点不是条目目录的通用文件
  // 浏览器，只转发已知的图片资源），且过路径安全校验防穿越到 base URL 之外。
  app.get('/api/skills-market/entries/:id/asset', async (req, res) => {
    const id = req.params.id;
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!MARKET_SAFE_ID.test(id) || !relPath || !isSafeMarketRelPath(relPath)) {
      return res.status(400).json({ error: 'invalid asset request' });
    }
    try {
      const registry = await fetchRegistry({});
      const entry = registry.entries.find((e) => e.id === id);
      const declared = entry && [entry.composerIcon, entry.logo, ...entry.screenshots].includes(relPath);
      if (!entry || !declared) {
        return res.status(404).json({ error: 'asset not declared by this entry' });
      }
      const url = `${resolveMarketBaseUrl()}/${marketRemoteDirFor(entry.kind)}/${entry.id}/${relPath}`;
      const raw = await fetch(url);
      if (!raw.ok) {
        return res.status(502).end();
      }
      res.setHeader('Content-Type', raw.headers.get('content-type') ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(Buffer.from(await raw.arrayBuffer()));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
