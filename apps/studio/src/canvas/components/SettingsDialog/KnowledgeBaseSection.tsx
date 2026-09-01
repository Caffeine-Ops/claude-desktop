import { useEffect, useState } from 'react';

import type { KbSyncStatus } from '@desktop-shared/kbSyncStatus';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { useTt } from './settingsHelpers';

/*
 * KnowledgeBaseSection —「知识库」分区：资料来源二选一（本地目录 / 远程服务器），
 * 供「写方案」检索。
 * ─────────────────────────────────────────────────────────────────
 * 2026-08-31 从 chat 树遗留设置页（src/chat/components/settings/KnowledgeBaseSection.tsx）
 * 整体搬来——那套设置页本次退役，搬迁背景见同目录 ProposalImageApiSubsection.tsx
 * 的头注释。这一节在原设置页里是**独一份**：本设置页此前完全没有配置知识库来源
 * 的入口，rail 上的「知识库」面只管浏览内容、不管配来源。
 *
 * 数据流：mount 拉一次 `getKbPath()`，任何写操作（切源/选目录/保存远程地址）后
 * 主动 refresh()，另外订阅 `onKbSyncStatus` 拿同步进度的实时推送（success 之后
 * 也 refresh 一次，因为 lastSync 变了）。
 *
 * `mode` 是「当前实际生效」的来源（由 state.remote 是否存在派生，来自持久化配置）；
 * `uiTab` 是「当前展开哪块面板」的纯 UI 选择。二者初始同步、之后可能短暂分叉——
 * 点「远程服务器」那行只是切到远程面板去填地址，**并不立即写配置**（不然一次误点
 * 就把正在工作的本地 kbRoot 挤掉，而 baseUrl 还是空的）；真正提交发生在填完地址点
 * 「保存并同步」那一刻。点「本地目录」没有这个空值问题——switchToLocal() 直接把
 * remote 置空，可以立即提交。
 *
 * UI 按项目纪律用 shadcn 原语 + Tailwind utility 重写（原 chat 版是裸 input/button，
 * 在 canvas 面会被未分层的裸元素 reset 填成描边卡片）。标题由 SettingsDialogV2 的
 * 壳统一画，本组件不再自带 <h1>。
 */
export function KnowledgeBaseSection(): React.JSX.Element {
  const tt = useTt();
  const [state, setState] = useState<KbPathState | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [sync, setSync] = useState<KbSyncStatus>({ state: 'idle' });
  const [uiTab, setUiTab] = useState<'local' | 'remote'>('local');

  // 三个独立 busy 标记而非共用一个：选目录、切本地、保存远程地址是三个互斥但各自
  // 独立触发的动作，共用一个 busy 会让点 A 按钮时 B 按钮的 disabled 态失真
  // （明明没在跑却灰着，或者反过来）。
  const [picking, setPicking] = useState(false);
  const [switchingLocal, setSwitchingLocal] = useState(false);
  const [applyingRemote, setApplyingRemote] = useState(false);
  const [syncNowBusy, setSyncNowBusy] = useState(false);

  /**
   * 拉一次最新配置。
   *
   * `syncDraft` 决定要不要把地址输入框也重置成持久化的值：
   *   · true —— mount 与用户自己的写操作之后（切源/选目录/保存地址）。此时输入
   *     框本就该反映刚落盘的结果。
   *   · false —— **后台同步推送触发的刷新**。这是 2026-08-31 搬迁时修掉的一个
   *     真实缺陷：原代码在这里无条件 `setUrlDraft(...)`，而原注释断言「用户敲
   *     地址期间没有 refresh 被触发」——这句是错的。kbSyncScheduler（主进程）
   *     启动 30 秒后跑一次、之后每 6 小时一次，成功时推 onKbSyncStatus，下面的
   *     订阅收到 success 就调 refresh()。于是「已配了远程 KB 的用户正在改服务
   *     器地址，后台定时同步刚好完成」→ 输入框被静默重置回旧地址，用户敲到一半
   *     的内容消失且毫无提示。推送路径改为不动草稿即可，其余状态照常刷新。
   */
  const refresh = (opts?: { syncDraft?: boolean }): void => {
    const syncDraft = opts?.syncDraft ?? true;
    const api = window.chatApi;
    if (!api?.getKbPath) return;
    void api.getKbPath().then((s) => {
      setState(s);
      if (syncDraft) setUrlDraft(s.remote?.baseUrl ?? '');
      // 面板选择跟实际生效来源对齐。同样只在「本人写操作 / mount」时才纠正——
      // 后台推送不该把用户刚点开的远程面板收回去（uiTab 与 mode 允许短暂分叉，
      // 见组件头注释）。
      if (syncDraft) setUiTab(s.remote ? 'remote' : 'local');
    });
  };

  useEffect(() => {
    refresh();
    // 守卫理由同 ProposalImageApiSubsection 的 mount effect：canvas 面用
    // `bun dev:next` 时跑在真浏览器里，没有 preload，window.chatApi 是 undefined。
    const api = typeof window !== 'undefined' ? window.chatApi : undefined;
    if (!api?.onKbSyncStatus) return;
    const off = api.onKbSyncStatus((s) => {
      setSync(s);
      // 成功后 lastSync 变了，重拉一次——但**不碰地址草稿**，见 refresh 头注释。
      if (s.state === 'success') refresh({ syncDraft: false });
    });
    return off;
  }, []);

  const mode: 'local' | 'remote' = state?.remote ? 'remote' : 'local';

  const applyRemote = async (): Promise<void> => {
    const baseUrl = urlDraft.trim();
    if (!baseUrl || applyingRemote) return;
    const api = window.chatApi;
    if (!api?.setKbRemote) return;
    setApplyingRemote(true);
    try {
      await api.setKbRemote({ baseUrl, kbId: 'default' }); // kbId 口子：UI 本期不暴露
      refresh();
    } catch (err) {
      console.error('[settings] setKbRemote failed', err);
    } finally {
      setApplyingRemote(false);
    }
  };

  const switchToLocal = async (): Promise<void> => {
    if (switchingLocal) return;
    setUiTab('local'); // 乐观切面板，refresh() 落地后会再确认一次
    // 已生效来源就是本地时短路（含「远程面板只是预览、从未提交」的情形）：点已
    // 选中项只收回面板，不重发 setKbRemote(null)+写盘+refresh——对齐远程那行纯
    // setUiTab 的零副作用行为。
    if (mode === 'local') return;
    const api = window.chatApi;
    if (!api?.setKbRemote) return;
    setSwitchingLocal(true);
    try {
      await api.setKbRemote(null);
      refresh();
    } catch (err) {
      console.error('[settings] setKbRemote(null) failed', err);
    } finally {
      setSwitchingLocal(false);
    }
  };

  const pickLocal = async (): Promise<void> => {
    if (picking) return;
    const api = window.chatApi;
    if (!api?.pickKbRoot) return;
    setPicking(true);
    try {
      const { path } = await api.pickKbRoot();
      if (path) {
        await api.setKbPath(path);
        refresh();
      }
    } catch (err) {
      console.error('[settings] pickKbRoot/setKbPath failed', err);
    } finally {
      setPicking(false);
    }
  };

  const syncNow = async (): Promise<void> => {
    if (syncNowBusy) return;
    const api = window.chatApi;
    if (!api?.kbSyncNow) return;
    setSyncNowBusy(true);
    try {
      // 返回值（started/alreadyRunning/noRemote）只是「请求是否受理」，真正的
      // 进度/成败走 onKbSyncStatus 推送渲染，这里不用管。
      await api.kbSyncNow();
    } catch (err) {
      console.error('[settings] kbSyncNow failed', err);
    } finally {
      setSyncNowBusy(false);
    }
  };

  const isSyncing = sync.state === 'syncing';
  const localDesc = tt(
    'settings.kb.sourceLocalDesc',
    '从本机的一个文件夹读取资料，改了文件即时生效。',
  );

  return (
    <section>
      {/* 管理页入口在聊天框底栏的「知识库」chip（Composer.tsx），与「选择工作
          目录」并排——比藏在设置里更好找，这里不重复放按钮。 */}
      <h2 className="text-[15px] font-semibold text-foreground">
        {tt('settings.kb.sourceTitle', '资料来源')}
      </h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {tt('settings.kb.sourceDesc', '「写方案」检索资料的地方，两种来源二选一。')}
      </p>

      <div className="mt-4 space-y-2">
        <SourceOption
          active={uiTab === 'local'}
          disabled={switchingLocal}
          onClick={() => void switchToLocal()}
          label={tt('settings.kb.sourceLocal', '本地目录')}
          description={localDesc}
        />
        <SourceOption
          active={uiTab === 'remote'}
          disabled={false}
          onClick={() => setUiTab('remote')}
          label={tt('settings.kb.sourceRemote', '远程服务器')}
          description={tt(
            'settings.kb.sourceRemoteDesc',
            '从团队共享的知识库服务器同步一份镜像到本机。',
          )}
        />
      </div>

      {uiTab === 'local' ? (
        <div className="mt-4 space-y-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[11.5px] text-foreground/90">
              {state?.kbRoot ?? '—'}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pickLocal()}
              disabled={picking}
              className="shrink-0"
            >
              {tt('settings.kb.pickFolder', '选择文件夹')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">{localDesc}</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
          <label className="block">
            <span className="mb-1.5 block text-[11px] text-muted-foreground">
              {tt('settings.kb.remoteUrl', '服务器地址')}
            </span>
            <div className="flex items-center gap-3">
              <Input
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="http://10.0.0.5:8080"
                className="flex-1"
              />
              <Button
                size="sm"
                onClick={() => void applyRemote()}
                disabled={applyingRemote || !urlDraft.trim()}
                className="shrink-0"
              >
                {tt('settings.kb.remoteApply', '保存并同步')}
              </Button>
            </div>
          </label>

          {/* 状态行只在远程真正生效（mode === 'remote'）时才有意义：用户在本地
              模式下点开这个面板只是预览着填地址，还没有可汇报的同步状态。 */}
          {mode === 'remote' ? (
            <>
              <SyncStatusRow sync={sync} lastSync={state?.lastSync ?? null} />
              <div className="flex items-center gap-3 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void syncNow()}
                  disabled={syncNowBusy || isSyncing}
                >
                  {isSyncing
                    ? tt('settings.kb.syncing', '同步中')
                    : tt('settings.kb.syncNow', '立即同步')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

type KbPathState = Awaited<ReturnType<typeof window.chatApi.getKbPath>>;

function SourceOption({
  active,
  disabled,
  onClick,
  label,
  description,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  description: string;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      /* 不用 shadcn 的 outline variant：这是一行「单选卡」，要的是左侧圆点 +
         两行文案的自定义排版，高度也不固定。ghost 只借它的 data-slot（豁免
         canvas 裸元素 reset）与 disabled 处理，视觉全部由下面的 utility 画。 */
      className={
        'group relative flex h-auto w-full flex-col items-start gap-1 whitespace-normal rounded-xl border px-4 py-3 text-left font-normal transition-all ' +
        (active
          ? 'border-accent/50 bg-accent/8 shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.15)] hover:bg-accent/8'
          : 'border-border/60 bg-card/40 hover:border-accent/30 hover:bg-card/60')
      }
    >
      <div className="flex w-full items-center gap-2">
        <span
          className={
            'flex size-4 shrink-0 items-center justify-center rounded-full border ' +
            (active
              ? 'border-accent bg-accent text-accent-foreground'
              : 'border-border bg-background')
          }
        >
          {active ? (
            <span className="block size-1.5 rounded-full bg-accent-foreground" />
          ) : null}
        </span>
        <span className="text-[13px] font-medium text-foreground">{label}</span>
      </div>
      <p className="pl-6 text-[11.5px] text-muted-foreground/80">{description}</p>
    </Button>
  );
}

function SyncStatusRow({
  sync,
  lastSync,
}: {
  sync: KbSyncStatus;
  lastSync: { atMs: number; builtAtMs: number } | null;
}): React.JSX.Element {
  const tt = useTt();

  if (sync.state === 'syncing') {
    return (
      <p className="text-[11.5px] text-muted-foreground/80">
        {tt('settings.kb.syncing', '同步中')} {sync.done}/{sync.total}
      </p>
    );
  }

  // idle / success / error 都落到下面统一的 lastSync 渲染——error 态额外在前面
  // 插一行失败原因，但不 return，让用户紧接着看到「上次同步时间」：手里镜像的
  // 内容还是那次同步落下的，用户需要知道现在数据有多旧才能判断能不能先将就用。
  const errorBanner =
    sync.state === 'error' ? (
      <p className="text-[11.5px] text-destructive">
        {tt('settings.kb.syncFailed', '同步失败')}: {sync.message}
      </p>
    ) : null;

  // idle / success（success 已经触发过 refresh，lastSync 反映的是最新一次）——
  // 静息态统一走 lastSync，避免和 sync push 里的字段名对不上（success 变体没有
  // failedCount 之类，直接复用 getKbPath 的 lastSync 更省心）。
  if (!lastSync) {
    if (errorBanner) return errorBanner;
    return (
      <p className="text-[11.5px] text-muted-foreground/70">
        {tt('settings.kb.neverSynced', '还没有同步过')}
      </p>
    );
  }

  return (
    <div className="space-y-0.5 text-[11.5px] text-muted-foreground/80">
      {errorBanner}
      <p>
        {tt('settings.kb.lastSync', '上次同步')}: {new Date(lastSync.atMs).toLocaleString()}
      </p>
      <p>
        {tt('settings.kb.version', '资料版本')}:{' '}
        {new Date(lastSync.builtAtMs).toLocaleString()}
      </p>
    </div>
  );
}
