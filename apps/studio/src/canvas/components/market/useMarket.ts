import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketRegistry, SkillsMarketInstalledItem } from '@open-design/contracts';

// 技能市场数据层：全走 daemon HTTP（/api/skills-market/*，dev 由 next
// rewrites、prod 由 app:// 反代转发）。没有全局 store——市场页是独立
// 浏览面，状态跟随组件生命周期即可，跨页共享的唯一真相在 daemon/磁盘。

export interface UseMarketResult {
  registry: MarketRegistry | null;
  registryError: string | null;
  loading: boolean;
  installed: SkillsMarketInstalledItem[];
  /** 与 registry 条目同名的内置（bundled）skill id 集合，用于「内置」徽标 */
  bundledIds: Set<string>;
  installingIds: Set<string>;
  notice: string | null;
  install: (id: string) => Promise<void>;
  uninstall: (name: string) => Promise<void>;
  refreshRegistry: (opts?: { refresh?: boolean }) => Promise<void>;
  notify: (msg: string) => void;
}

export function useMarket(): UseMarketResult {
  const [registry, setRegistry] = useState<MarketRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installed, setInstalled] = useState<SkillsMarketInstalledItem[]>([]);
  const [bundledIds, setBundledIds] = useState<Set<string>>(new Set());
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      const res = await fetch('/api/skills-market/installed');
      if (!res.ok) return;
      const data = (await res.json()) as { installed?: SkillsMarketInstalledItem[] };
      setInstalled(data.installed ?? []);
    } catch {
      // 离线/daemon 未起——保持现状，安装列表本地为真相下次刷新自愈
    }
  }, []);

  const refreshRegistry = useCallback(async (opts: { refresh?: boolean } = {}) => {
    setLoading(true);
    setRegistryError(null);
    try {
      const res = await fetch(`/api/skills-market/registry${opts.refresh ? '?refresh=1' : ''}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setRegistry((await res.json()) as MarketRegistry);
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRegistry();
    void refreshInstalled();
    // 内置 skill 名单：daemon 读 bundled skills/ 的既有端点。拉不到就没有
    // 「内置」徽标，纯增强不阻塞。
    void fetch('/api/skills')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { skills?: Array<{ id?: string }> } | null) => {
        if (d?.skills) {
          setBundledIds(new Set(d.skills.map((s) => s.id).filter((x): x is string => !!x)));
        }
      })
      .catch(() => {});
  }, [refreshRegistry, refreshInstalled]);

  const install = useCallback(
    async (id: string) => {
      setInstallingIds((prev) => new Set(prev).add(id));
      try {
        const res = await fetch('/api/skills-market/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        // 端点是 SSE 流（同 /api/plugins/install 形状）；v1 只消费终态——
        // text() 等到流结束，取最后一个 success/error 事件
        const terminal = parseTerminalSseEvent(await res.text());
        if (terminal?.kind === 'success') {
          notify('已安装，新会话生效');
          await refreshInstalled();
        } else {
          notify(`安装失败：${terminal && 'message' in terminal ? terminal.message : `HTTP ${res.status}`}`);
        }
      } catch (err) {
        notify(`安装失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [notify, refreshInstalled],
  );

  const uninstall = useCallback(
    async (name: string) => {
      try {
        const res = await fetch('/api/skills-market/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          notify('已移除，进行中的会话不受影响');
          await refreshInstalled();
        } else {
          const body = (await res.json().catch(() => null)) as { warning?: string; error?: string } | null;
          notify(`移除失败：${body?.warning ?? body?.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        notify(`移除失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [notify, refreshInstalled],
  );

  return {
    registry,
    registryError,
    loading,
    installed,
    bundledIds,
    installingIds,
    notice,
    install,
    uninstall,
    refreshRegistry,
    notify,
  };
}

function parseTerminalSseEvent(
  text: string,
): { kind: 'success' } | { kind: 'error'; message: string } | null {
  const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(dataLines[i]!.slice('data: '.length)) as {
        kind?: string;
        message?: string;
      };
      if (ev.kind === 'success') return { kind: 'success' };
      if (ev.kind === 'error') return { kind: 'error', message: ev.message ?? '未知错误' };
    } catch {
      // 跳过坏帧
    }
  }
  return null;
}

/** 拉取条目的 SKILL.md 正文（技能弹层 README 面板用） */
export async function fetchEntryReadme(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/skills-market/entries/${encodeURIComponent(id)}/readme`);
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string };
    return data.content ?? null;
  } catch {
    return null;
  }
}
