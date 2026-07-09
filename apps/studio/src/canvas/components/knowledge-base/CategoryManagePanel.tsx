/*
 * CategoryManagePanel —— 知识库页「分类管理」内容区：维护「文档识别」与
 * 「图片识别」两个域各自的自定义类别集合（增 / 重命名 / 删除 / 排序）。
 * 持久化在 ~/.cowork/KB-CATEGORIES.json（文档）与 KB-IMAGE-CATEGORIES.json
 * （图片）（main 侧 kbCatalogService），对话里的 local-kb skill 与两个域的
 * 「更新知识库」AI 归类都读同一份集合。
 *
 * 交互契约（两段共用同一个 CategorySection，只差 domain）：
 *  - 「其他」是系统兜底类别：恒在末尾、不可删改不可移动（行上标「默认」）。
 *  - 重命名/删除会立即迁移该域索引里的存量条目（删除 → 归「其他」），操作后
 *    带回 migrated 条数提示；新增分类要回对应识别页点「更新知识库」重新归类
 *    才会有文件进去——页头说明讲清这两种时效差异。
 *  - 删除走两态按钮（点一次武装成「确认删除」，3s 未确认自动复位）——canvas
 *    树里不能用阻塞式 confirm 弹窗。
 *
 * 样式纪律同 AllFilesPanel 头注释（纯 shadcn + utility；头部行 no-drag）。
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  FolderKanban,
  Images,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { cn } from '@/src/lib/utils';
import type { KbCategoriesUpdatePayload } from '@desktop-shared/ipc-channels';
import {
  KB_FALLBACK_CATEGORY,
  KB_CATEGORY_NAME_MAX,
  type KbCatalogDomain,
} from '@desktop-shared/kbCatalog';

/** 单个域的分类编辑器。文档 / 图片两段各渲染一份。 */
function CategorySection({
  domain,
  heading,
  icon: Icon,
  rebuildHint,
}: {
  domain: KbCatalogDomain;
  heading: string;
  icon: typeof FolderKanban;
  rebuildHint: string;
}): React.JSX.Element {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  /** 操作反馈条：错误（红）或迁移提示（中性），下一次操作前常驻。 */
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addValue, setAddValue] = useState('');

  /** 每类文件计数——从该域索引统计，纯展示（帮用户判断删这个类影响多少文件）。 */
  const refreshCounts = useCallback(async (): Promise<void> => {
    try {
      const r = await window.chatApi?.getKbCatalog({ domain });
      const m = new Map<string, number>();
      for (const e of r?.catalog?.entries ?? []) {
        m.set(e.category, (m.get(e.category) ?? 0) + 1);
      }
      setCounts(m);
    } catch (err) {
      console.warn('[kb-categories] counts load failed:', err);
    }
  }, [domain]);

  useEffect(() => {
    void window.chatApi
      ?.getKbCategories({ domain })
      .then((r) => setCategories(r.categories))
      .catch((err) => console.warn('[kb-categories] load failed:', err));
    void refreshCounts();
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [domain, refreshCounts]);

  const doUpdate = async (payload: KbCategoriesUpdatePayload): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await window.chatApi?.updateKbCategories({ ...payload, domain });
      if (!r) return false;
      setCategories(r.categories);
      if (r.error) {
        setNotice({ kind: 'error', text: r.error });
        return false;
      }
      if (r.migrated > 0) {
        setNotice({
          kind: 'info',
          text:
            payload.action === 'remove'
              ? `已删除，${r.migrated} 个文件移入「${KB_FALLBACK_CATEGORY}」`
              : `已重命名，${r.migrated} 个文件随之更新`,
        });
        void refreshCounts();
      }
      return true;
    } catch (err) {
      console.warn('[kb-categories] update failed:', err);
      setNotice({ kind: 'error', text: '操作失败，请重试' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (name: string): void => {
    setEditing(name);
    setEditValue(name);
    setConfirmRemove(null);
  };

  const commitEdit = async (): Promise<void> => {
    const from = editing;
    if (!from) return;
    const to = editValue.trim();
    if (!to || to === from) {
      setEditing(null);
      return;
    }
    if (await doUpdate({ action: 'rename', from, to })) setEditing(null);
  };

  const armRemove = (name: string): void => {
    setConfirmRemove(name);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    // 3s 未确认自动复位——武装态不能永久停留（误触后忘了，下次点击就是事故）。
    confirmTimer.current = setTimeout(() => setConfirmRemove(null), 3000);
  };

  const submitAdd = async (): Promise<void> => {
    const name = addValue.trim();
    if (!name) return;
    if (await doUpdate({ action: 'add', name })) setAddValue('');
  };

  /** 可编辑区 = 「其他」之外的前缀段（main 侧 sanitize 保证「其他」恒末尾）。 */
  const editable = useMemo(() => (categories ?? []).slice(0, -1), [categories]);

  return (
    <section className="max-w-[560px]">
      <div className="mb-1 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-[16px] font-semibold text-foreground">{heading}</h2>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{rebuildHint}</p>

      {notice && (
        <div
          className={cn(
            'mb-3 rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed',
            notice.kind === 'error'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border/60 bg-secondary/50 text-foreground/80',
          )}
        >
          {notice.text}
        </div>
      )}

      {categories === null ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="flex flex-col rounded-2xl border border-border/60">
            {editable.map((name, idx) => (
              <div
                key={name}
                className="group flex h-12 items-center gap-2 border-b border-border/50 px-4 last:border-b-0"
              >
                {editing === name ? (
                  <>
                    <Input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      maxLength={KB_CATEGORY_NAME_MAX}
                      autoFocus
                      className="h-8 w-44 text-[13px]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitEdit();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      title="确认"
                      aria-label="确认重命名"
                      disabled={busy}
                      onClick={() => void commitEdit()}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      title="取消"
                      aria-label="取消重命名"
                      onClick={() => setEditing(null)}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-[14px] text-foreground">{name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {counts.get(name) ?? 0}
                    </span>
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="上移"
                        aria-label={`上移${name}`}
                        disabled={busy || idx === 0}
                        onClick={() => void doUpdate({ action: 'move', name, dir: 'up' })}
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="下移"
                        aria-label={`下移${name}`}
                        disabled={busy || idx === editable.length - 1}
                        onClick={() => void doUpdate({ action: 'move', name, dir: 'down' })}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="重命名"
                        aria-label={`重命名${name}`}
                        disabled={busy}
                        onClick={() => startEdit(name)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      {confirmRemove === name ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={busy}
                          onClick={() => {
                            setConfirmRemove(null);
                            void doUpdate({ action: 'remove', name });
                          }}
                        >
                          确认删除
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          title="删除（文件将归入「其他」）"
                          aria-label={`删除${name}`}
                          disabled={busy}
                          onClick={() => armRemove(name)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* 「其他」：系统兜底，只读展示。 */}
            <div className="flex h-12 items-center gap-2 border-t border-border/50 bg-secondary/30 px-4">
              <span className="text-[14px] text-foreground/80">{KB_FALLBACK_CATEGORY}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {counts.get(KB_FALLBACK_CATEGORY) ?? 0}
              </span>
              <span className="ml-auto rounded bg-secondary px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                默认·不可修改
              </span>
            </div>
          </div>

          {/* 添加分类。 */}
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              maxLength={KB_CATEGORY_NAME_MAX}
              placeholder={`新分类名（最长 ${KB_CATEGORY_NAME_MAX} 字）`}
              className="h-9 w-64 text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitAdd();
              }}
            />
            <Button
              size="sm"
              className="gap-1"
              disabled={busy || addValue.trim() === ''}
              onClick={() => void submitAdd()}
            >
              <Plus className="size-4" />
              添加分类
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function CategoryManagePanel({ title }: { title: string }): React.JSX.Element {
  return (
    <div>
      {/* 头部行落在 46px 拖拽带下缘，交互元素统一 no-drag 挖洞。 */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3 [-webkit-app-region:no-drag]">
        <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-foreground">{title}</h1>
      </div>
      <p className="mb-7 max-w-[560px] text-[13px] leading-relaxed text-muted-foreground">
        这些分类决定「更新知识库」时 AI 怎么归类。重命名/删除会立即更新已归类的文件；
        <span className="text-foreground/80">新增的分类要回对应识别页再点一次「更新知识库」</span>，
        才会有文件归进去。
      </p>

      <div className="flex flex-col gap-10">
        <CategorySection
          domain="docs"
          heading="文档分类"
          icon={FolderKanban}
          rebuildHint="作用于「文档识别」页。"
        />
        <CategorySection
          domain="images"
          heading="图片分类"
          icon={Images}
          rebuildHint="作用于「图片识别」页。"
        />
      </div>
    </div>
  );
}
