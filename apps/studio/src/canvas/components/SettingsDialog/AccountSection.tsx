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
import { Camera, Loader2 } from 'lucide-react';

import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { cn } from '@/src/lib/utils';
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

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-[13px] font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function AccountSection(): React.JSX.Element {
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

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
        } else {
          setUsernameError(result.error);
        }
      })
      .catch(() => {
        setUsernameSaving(false);
        setUsernameError('保存失败，请稍后重试');
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
      <p className="-mt-3 text-sm leading-relaxed text-muted-foreground">
        你的 sub2api 账户资料，数据来自后端接口。
      </p>

      {/* ── 头像 + 用户名卡 ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-4">
          <button
            type="button"
            data-slot="avatar-picker"
            onClick={handlePickAvatar}
            disabled={avatarUploading}
            aria-label="更换头像"
            className="group relative size-16 shrink-0 overflow-hidden rounded-full border border-border bg-muted disabled:opacity-70"
          >
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-xl font-semibold text-muted-foreground">
                {(profile.username || profile.phone).charAt(0).toUpperCase()}
              </span>
            )}
            <span className="absolute inset-0 hidden items-center justify-center bg-black/45 group-hover:flex">
              {avatarUploading ? (
                <Loader2 aria-hidden="true" className="size-5 animate-spin text-white" />
              ) : (
                <Camera aria-hidden="true" className="size-5 text-white" />
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
            <Label htmlFor="account-username" className="text-xs text-muted-foreground">
              用户名
            </Label>
            <div className="mt-1.5 flex items-center gap-2">
              <Input
                id="account-username"
                value={usernameDraft}
                disabled={usernameSaving}
                onChange={(e) => setUsernameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveUsername();
                }}
                className="h-8 max-w-[220px]"
              />
              {usernameDirty ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={usernameSaving}
                  onClick={handleSaveUsername}
                  className="h-8 shrink-0"
                >
                  {usernameSaving ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : '保存'}
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{profile.phone}</p>
          </div>
        </div>
        {usernameError ? <p className="mt-2 text-xs text-destructive">{usernameError}</p> : null}
        {avatarError ? <p className="mt-2 text-xs text-destructive">{avatarError}</p> : null}
      </div>

      {/* ── 账户信息只读卡 ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <Badge variant={profile.status === 'active' ? 'secondary' : 'destructive'}>
            {STATUS_LABEL[profile.status] ?? profile.status}
          </Badge>
          <Badge variant="outline">{ROLE_LABEL[profile.role] ?? profile.role}</Badge>
        </div>
        <div className={cn('grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3')}>
          <InfoTile label="账户余额" value={`$${profile.balance.toFixed(2)}`} />
          <InfoTile label="并发上限" value={String(profile.concurrency)} />
          <InfoTile label="注册时间" value={formatDate(profile.createdAt)} />
        </div>
      </div>
    </section>
  );
}
