/**
 * 设置页「账号」面——展示/编辑真实 sub2api 账户资料，参照它自己网页端
 * 的 `/profile` 页做了范围收窄：只做「基础信息（含用户名编辑）+ 头像
 * 上传」。密码修改、TOTP 双因素认证、第三方账号绑定这次刻意不做——
 * 手机号自动注册的账户密码是系统随机生成的 32 位串、用户自己根本不
 * 知道，TOTP 身份校验（邮箱验证码 or 密码）在这条注册路径下两条腿都
 * 走不通（邮箱是伪造的 `{phone}@phone.local`，验证码发出去也收不到；
 * 密码又是那串谁也不知道的随机值）——这是 sub2api 后端本身还没补上
 * 「手机验证码验身份」这条路径，不是客户端能绕开的，2026-07-21 跟用户
 * 确认过范围。
 *
 * 数据面：main 进程持有 access token（渲染层不落地任何 token），本面
 * 只经 window.chatApi.getAccountProfile / updateAccountProfile 两个
 * IPC 读写，不直接碰网络。改用户名成功后 main 会同步广播新的
 * AuthState，rail 账户 chip 立刻跟上，本面不需要自己再通知谁。
 *
 * 技术栈：本目录已在 chat 链 @source 内——shadcn 原语 + Tailwind
 * utility，不用 .settings-* / .sv2-* legacy 类。视觉参照
 * UpdateAppSection 的「卡片 + hero/detail 分区」语言。
 */

import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, CalendarDays, Camera, Check, Copy, Layers, Loader2, Phone, UserRound, Wallet } from 'lucide-react';

import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { SettingCard, SettingGroup, SettingRow } from '../settings/SettingPrimitives';
import type { AccountProfile } from '@desktop-shared/ipc-channels';

/** 头像最终 data URI 的字节上限（跟 sub2api 网页端的约定一致，压缩到
 * webp、循环降质直到落在这个预算内）。 */
const AVATAR_MAX_BYTES = 20 * 1024;
const AVATAR_MAX_DIM = 256;

async function compressAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, AVATAR_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  // base64 比原始字节多 ~4/3，用这个比例换算 dataURL 长度预算。
  const budget = (AVATAR_MAX_BYTES * 4) / 3;
  let quality = 0.9;
  let dataUrl = canvas.toDataURL('image/webp', quality);
  while (dataUrl.length > budget && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/webp', quality);
  }
  if (dataUrl.length > budget) {
    throw new Error('图片压缩后仍然过大，换一张试试');
  }
  return dataUrl;
}

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '普通用户' };
const STATUS_LABEL: Record<string, string> = { active: '正常', disabled: '已禁用' };

function formatDate(epochMs: number): string {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function AccountSection(): React.JSX.Element {
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  // 用户名行的「编辑态」：平时只显示名字 + 编辑按钮，点了才展开输入框——
  // 一张资料卡里常驻一个输入框看起来像未完成的表单（2026-09-04 精细化）。
  const [editingName, setEditingName] = useState(false);
  const [phoneCopied, setPhoneCopied] = useState(false);

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const api = window.chatApi;
    if (!api?.getAccountProfile) {
      setLoadError('当前环境不支持账号面板');
      setLoading(false);
      return;
    }
    let alive = true;
    void api
      .getAccountProfile()
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setProfile(result.profile);
          setUsernameDraft(result.profile.username);
        } else {
          setLoadError(result.error);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoadError('获取账户信息失败，请稍后重试');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleSaveUsername = () => {
    const next = usernameDraft.trim();
    if (!profile || usernameSaving || !next || next === profile.username) return;
    const api = window.chatApi;
    if (!api?.updateAccountProfile) return;
    setUsernameSaving(true);
    setUsernameError(null);
    void api
      .updateAccountProfile({ username: next })
      .then((result) => {
        setUsernameSaving(false);
        if (result.ok) {
          setProfile(result.profile);
          setUsernameDraft(result.profile.username);
          setEditingName(false);
        } else {
          setUsernameError(result.error);
        }
      })
      .catch(() => {
        setUsernameSaving(false);
        setUsernameError('保存失败，请稍后重试');
      });
  };

  const cancelEditName = () => {
    if (profile) setUsernameDraft(profile.username);
    setUsernameError(null);
    setEditingName(false);
  };

  const copyPhone = () => {
    if (!profile) return;
    void navigator.clipboard?.writeText(profile.phone).then(() => {
      setPhoneCopied(true);
      window.setTimeout(() => setPhoneCopied(false), 1500);
    });
  };

  const handlePickAvatar = () => fileInputRef.current?.click();

  const handleAvatarFile = (file: File | undefined) => {
    if (!file || avatarUploading) return;
    const api = window.chatApi;
    if (!api?.updateAccountProfile) return;
    setAvatarUploading(true);
    setAvatarError(null);
    void compressAvatar(file)
      .then((avatarDataUrl) => api.updateAccountProfile({ avatarDataUrl }))
      .then((result) => {
        setAvatarUploading(false);
        if (result.ok) {
          setProfile(result.profile);
        } else {
          setAvatarError(result.error);
        }
      })
      .catch((err: unknown) => {
        setAvatarUploading(false);
        setAvatarError(err instanceof Error ? err.message : '头像上传失败');
      });
  };

  if (loading) {
    return (
      <section className="flex flex-col gap-6">
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          正在加载账户信息…
        </p>
      </section>
    );
  }

  if (loadError || !profile) {
    return (
      <section className="flex flex-col gap-6">
        <p className="text-[13px] text-destructive">{loadError ?? '获取账户信息失败'}</p>
      </section>
    );
  }

  const usernameDirty = usernameDraft.trim() !== '' && usernameDraft.trim() !== profile.username;

  return (
    <section className="flex flex-col gap-6">
      {/* 页面副标题（「你的 sub2api 账户资料…」）已由壳的页头统一渲染
          （useSectionHeaders），这里不再自己画一遍。 */}

      {/* ── 资料：头像行 + 用户名行 + 手机号行 ── */}
      {/* 2026-09-04 精细化第二轮：原先是「头像 + 常驻输入框」一整块，头像要悬停
          才露出相机、输入框像张没填完的表单。改成三行组卡，与下面「套餐与额度」
          同一节奏：① 头像行——44px 头像右下角常驻相机角标（一眼知道能换）+ 大字
          用户名 + 一行灰字来源；② 用户名行——平时是值 + 「编辑」，点开才是输入框
          + 保存/取消，回车保存、Esc 取消；③ 手机号行——值 + 复制钮。
          改名 / 传头像的 IPC 逻辑与错误提示一行没动。 */}
      <SettingGroup label="资料">
        <SettingCard>
          <SettingRow size="hero">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <button
                type="button"
                data-slot="avatar-picker"
                onClick={handlePickAvatar}
                disabled={avatarUploading}
                aria-label="更换头像"
                title="更换头像"
                className="group relative size-11 shrink-0 rounded-full disabled:opacity-70"
              >
                <span className="block size-full overflow-hidden rounded-full border border-border bg-muted">
                  {profile.avatarUrl ? (
                    <img src={profile.avatarUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-base font-semibold text-muted-foreground">
                      {(profile.username || profile.phone).charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                {/* 常驻相机角标：悬停时整个头像盖一层深色、角标变亮，双重提示可点。 */}
                <span className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full border-2 border-card bg-secondary text-muted-foreground transition-colors group-hover:bg-foreground group-hover:text-card">
                  {avatarUploading ? (
                    <Loader2 aria-hidden="true" className="size-2.5 animate-spin" />
                  ) : (
                    <Camera aria-hidden="true" className="size-2.5" />
                  )}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                data-slot="avatar-file-input"
                className="hidden"
                onChange={(e) => {
                  handleAvatarFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-foreground">
                  {profile.username || profile.phone}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  手机号登录 · {profile.phone}
                </p>
                {avatarError ? <p className="mt-1 text-xs text-destructive">{avatarError}</p> : null}
              </div>
            </div>
          </SettingRow>

          {editingName ? (
            <SettingRow icon={<UserRound />} title="用户名" stack>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="account-username"
                  autoFocus
                  value={usernameDraft}
                  disabled={usernameSaving}
                  aria-label="用户名"
                  onChange={(e) => setUsernameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveUsername();
                    if (e.key === 'Escape') cancelEditName();
                  }}
                  className="h-8 max-w-[240px]"
                />
                <Button
                  size="sm"
                  disabled={usernameSaving || !usernameDirty}
                  onClick={handleSaveUsername}
                  className="h-8"
                >
                  {usernameSaving ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : '保存'}
                </Button>
                <Button size="sm" variant="ghost" disabled={usernameSaving} onClick={cancelEditName} className="h-8">
                  取消
                </Button>
              </div>
              {usernameError ? <p className="text-xs text-destructive">{usernameError}</p> : null}
            </SettingRow>
          ) : (
            <SettingRow icon={<UserRound />} title="用户名" value={profile.username}>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setEditingName(true)}>
                编辑
              </Button>
            </SettingRow>
          )}

          <SettingRow icon={<Phone />} title="手机号" value={profile.phone} mono>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-muted-foreground"
              aria-label={phoneCopied ? '已复制' : '复制手机号'}
              title={phoneCopied ? '已复制' : '复制手机号'}
              onClick={copyPhone}
            >
              {phoneCopied ? (
                <Check aria-hidden="true" className="size-3.5 text-[var(--brand)]" />
              ) : (
                <Copy aria-hidden="true" className="size-3.5" />
              )}
            </Button>
          </SettingRow>
        </SettingCard>
      </SettingGroup>

      {/* ── 套餐与额度：只读信息，一行一项 ── */}
      {/* 原是一张「徽章 + 三列数据网格」的内容卡；改成组卡四行后每项有了
          自己的标题和右侧对齐的值，金额用等宽字。状态/角色徽章合到第一行。 */}
      <SettingGroup
        label="套餐与额度"
        footnote="余额与并发上限由后台管理员分配，如需调整请联系管理员。"
      >
        <SettingCard>
          <SettingRow icon={<BadgeCheck />} title="账户状态">
            <Badge variant={profile.status === 'active' ? 'secondary' : 'destructive'}>
              {STATUS_LABEL[profile.status] ?? profile.status}
            </Badge>
            <Badge variant="outline">{ROLE_LABEL[profile.role] ?? profile.role}</Badge>
          </SettingRow>
          <SettingRow icon={<Wallet />} title="账户余额" value={`$${profile.balance.toFixed(2)}`} mono />
          <SettingRow
            icon={<Layers />}
            title="并发上限"
            hint="同时运行的任务数。"
            value={String(profile.concurrency)}
          />
          <SettingRow icon={<CalendarDays />} title="注册时间" value={formatDate(profile.createdAt)} />
        </SettingCard>
      </SettingGroup>
    </section>
  );
}
