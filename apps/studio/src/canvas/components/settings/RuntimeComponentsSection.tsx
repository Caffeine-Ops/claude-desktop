/**
 * 设置页「运行时组件」分区（2026-09-24）。
 *
 * 为什么存在
 * ------------------------------------------------------------
 * AI 引擎（CLI 二进制）与 Python 运行环境自 2026-07-29 起不随安装包发布，改为
 * 首次启动按需下载（componentInstaller.ts + docs/runtime-components-deploy.md）。
 * 但此前**装完之后就没有任何入口**了：`ComponentGate` 只是首启的一道全屏门，
 * 组件齐了它就永不出现，于是「装了哪个版本 / 现在什么状态 / 坏了怎么重下 /
 * 装到哪个目录了」全都无处可查，出问题只能让用户翻日志。
 *
 * 这个分区就是补那个出口。注意 componentInstaller 里的 `runtimeComponentsRoot()`
 * 与 `runtimeComponentDir()` 两个函数，注释原文写的是「诊断用：组件根目录
 * （设置页 / 日志里显示）」——位是当初就留的，只是页没做，本分区是它们的第一个
 * 消费者（同样也是 shared 里 `isRuntimeComponentsBusy` 的第一个消费者）。
 *
 * 数据从哪来
 * ------------------------------------------------------------
 * 状态**不自己拉**：`useRuntimeComponentsStore` 在模块加载时就 hydrate 过并订阅了
 * main 的推送（唯一真相在 main，前台只做镜像），所以这里订阅 store 即可，下载
 * 进度会自动流进来。只有安装路径要单独取一次——它是进程生命周期内的常量，刻意
 * 没塞进那张高频推送的状态表（见 RUNTIME_COMPONENTS_GET_PATHS 的注释）。
 *
 * 关于「重新下载」的三条纪律
 * ------------------------------------------------------------
 * 1. **忙碌时全部置灰**（`isRuntimeComponentsBusy`）。installer 的单飞是全局的：
 *    已有一轮在跑时再调 ensure 会复用那个 promise、不会另起一轮——两个 worker
 *    同时装同一个组件会在 staging→rename 那步打架。置灰是为了别让用户点了没反应
 *    还以为是坏了。
 * 2. **必须先确认**。自建源出口带宽约 1.1MB/s 且所有用户共享，AI 引擎压缩后
 *    ~80MB，一次重下是几分钟且没有取消按钮。确认框里如实写清代价与副作用。
 * 3. **副作用要说明**：mac 上 staging→rename 能在文件正被使用时成功（旧 inode
 *    还活着），所以正在进行的对话会继续用旧二进制，要**重启应用**才会用上新的；
 *    Windows 上文件被占用会导致替换失败，worker 已有现成文案「无法替换正在使用
 *    的组件——请结束正在运行的任务后重试」，照原样显示即可。
 *
 * 样式纪律（CLAUDE.md）
 * ------------------------------------------------------------
 * 只用 shadcn 原语 + Tailwind utility + SettingPrimitives，不碰 legacy 的
 * `.settings-*` / `.sv2-*` 类（canvas CSS 未分层，同名属性会压过 utility）。
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Loader2 } from 'lucide-react';

import {
  componentStatusText,
  describeComponent,
  formatBytes,
  formatEta,
  isRuntimeComponentsBusy,
  type ComponentId,
  type ComponentStatus,
} from '@desktop-shared/runtimeComponents';
import { useRuntimeComponentsStore } from '@/src/stores/runtimeComponents';
import { Button } from '@/src/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/src/components/ui/alert-dialog';

import { SettingCard, SettingGroup, SettingRow } from './SettingPrimitives';

/** 每行左侧的状态图标。忙碌态用转圈，让「在动」这件事不依赖读文字。 */
function PhaseGlyph({ phase }: { phase: ComponentStatus['phase'] }): React.JSX.Element {
  if (phase === 'error') return <AlertTriangle className="size-4 text-destructive" />;
  if (phase === 'ready') return <CheckCircle2 className="size-4 text-brand" />;
  if (phase === 'idle') return <Download className="size-4 text-muted-foreground" />;
  return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
}

/**
 * 下载/安装中的第二行：进度条 + 「已传 / 总量（速率，剩余时间）」。
 *
 * 速率与剩余时间是刚需不是装饰——共享 1.1MB/s 的源上一次首装动辄一两分钟，
 * 用户最想知道的就是「还要多久」（同 ComponentStatus.bytesPerSecond 的注释）。
 */
function ProgressLine({ c }: { c: ComponentStatus }): React.JSX.Element | null {
  const active = c.phase === 'downloading' || c.phase === 'verifying' || c.phase === 'installing';
  if (!active || c.total <= 0) return null;

  const pct = Math.min(100, Math.round((c.done / c.total) * 100));
  const speed = c.bytesPerSecond > 0 ? `${formatBytes(c.bytesPerSecond)}/s` : '';
  const eta = c.phase === 'downloading' ? formatEta(c.total - c.done, c.bytesPerSecond) : '';
  const tail = [speed, eta].filter(Boolean).join('，');

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11.5px] tabular-nums text-muted-foreground">
        {formatBytes(c.done)} / {formatBytes(c.total)}
        {tail ? `（${tail}）` : ''}
        {c.attempt > 0 ? ` · 第 ${c.attempt + 1} 次尝试` : ''}
      </span>
    </div>
  );
}

export function RuntimeComponentsSection(): React.JSX.Element {
  const state = useRuntimeComponentsStore((s) => s.state);
  const [paths, setPaths] = useState<{ root: string; dirs: Record<ComponentId, string> } | null>(
    null,
  );
  /** 待确认的重下目标；非 null 时确认框打开。 */
  const [pending, setPending] = useState<ComponentId | null>(null);

  useEffect(() => {
    // 路径是常量，取一次就够。取不到就不显示那个脚注（诊断信息缺失不该让整页报错）。
    void window.chatApi?.getRuntimeComponentPaths?.().then(setPaths).catch(() => undefined);
  }, []);

  const busy = state ? isRuntimeComponentsBusy(state) : false;

  const confirmRedownload = (): void => {
    if (!pending) return;
    // force:true + only:id —— 只重装这一个。ensure 不 throw，失败会收敛成状态表里的
    // phase:'error'，经推送自动流回本页面，所以这里不用 catch 出错分支。
    void window.chatApi?.ensureRuntimeComponents?.(true, pending);
    setPending(null);
  };

  return (
    <>
      <SettingGroup
        label="组件"
        footnote={
          state && !state.manifestOk
            ? // manifestOk=false 的含义是「没拉到清单」＝网络问题，不是下载失败。
              // 这个区分在契约里有明确注释，UI 必须照着说，否则用户会去反复点重下。
              '没能连上下载服务器，无法检查更新。已装好的组件不受影响，可正常使用。'
            : paths
              ? `安装位置：${paths.root}`
              : undefined
        }
      >
        <SettingCard>
          {state?.components.length
            ? state.components.map((c) => (
                <SettingRow
                  key={c.id}
                  icon={<PhaseGlyph phase={c.phase} />}
                  title={
                    <span className="flex items-center gap-2">
                      {describeComponent(c.id)}
                      {c.required ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                          必需
                        </span>
                      ) : null}
                    </span>
                  }
                  hint={
                    <>
                      <span className={c.phase === 'error' ? 'text-destructive' : undefined}>
                        {componentStatusText(c)}
                      </span>
                      <ProgressLine c={c} />
                    </>
                  }
                  value={c.installedVersion ?? '未安装'}
                  mono
                >
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => setPending(c.id)}
                  >
                    重新下载
                  </Button>
                </SettingRow>
              ))
            : // state 为 null＝还没问过 main（store 的 hydrate 还在路上）。
              // 空数组＝main 侧还没注册组件（当前平台不在受支持三平台内也会这样）。
              <SettingRow
                title="暂无组件信息"
                hint={
                  state
                    ? '当前系统平台没有需要单独下载的运行时组件。'
                    : '正在读取组件状态…'
                }
              />}
        </SettingCard>
      </SettingGroup>

      {paths ? (
        <SettingGroup label="诊断">
          <SettingCard>
            <SettingRow
              title="组件安装目录"
              hint="排查问题时可以把这个目录的内容提供给技术支持。"
              value={paths.root}
              mono
              stack
            >
              <Button
                variant="outline"
                size="xs"
                onClick={() => void window.chatApi?.revealPath?.({ absPath: paths.root })}
              >
                <FolderOpen className="size-3.5" />
                在文件管理器中显示
              </Button>
            </SettingRow>
          </SettingCard>
        </SettingGroup>
      ) : null}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending ? `重新下载 ${describeComponent(pending)}？` : '重新下载？'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              {/* 中文文案一律写成字符串字面量，不用 JSX 多行文本：JSX 会把换行 +
                  缩进折叠成一个空格，英文里正合适，中文里就凭空多出一个空隙
                  （「可能需要 几分钟」）。<strong> 前后的空格同理，用相邻字符串控制。 */}
              <div className="space-y-2">
                <p>
                  {'会重新下载并替换这个组件。下载服务器是共享带宽，视网络情况可能需要几分钟，中途没有取消按钮。'}
                </p>
                <p>
                  {'如果此刻有正在进行的对话，它会继续使用旧版本，'}
                  <strong className="font-medium text-foreground">重启应用后</strong>
                  {'才会用上新下载的组件；Windows 上如果文件正被占用，替换会失败并提示你先结束正在运行的任务。'}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRedownload}>开始下载</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
