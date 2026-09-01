import { useEffect, useRef, useState } from 'react';

import {
  PROPOSAL_IMAGE_API_KEY_MASK,
  type ProposalImageApiConfig,
} from '@desktop-shared/ipc-channels';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import {
  consumeSettingsOverlayAnchor,
  useSettingsOverlayStore,
} from '@/src/stores/surfaceOverlay';
import { useTt } from './settingsHelpers';

/*
 * ProposalImageApiSubsection —「写方案出图 API」。
 * ─────────────────────────────────────────────
 * 2026-08-31 从 chat 树遗留设置页（src/chat/components/settings/SettingsView.tsx
 * 的 ConfigurationSection）搬来。背景：应用里曾并存两套设置页，chat 那套 11 个
 * 分区有 7 个是「待实现」占位，真内容只剩 4 个、其中两个（主题/语言）与本设置页
 * 重复，入口也只剩「写方案」「写作」两处直达。本次统一入口后整套退役，它独有的
 * 两块（本节 + 知识库来源）搬到这里。
 *
 * 为什么挂在「媒体生成提供商」底下而不是独立开一节：用户视角两者都是「配出图」，
 * 分两个地方放就得找两次。**但数据是两套，别被位置骗了**——本节走 main 进程的
 * PROPOSAL_IMAGE_SETTINGS_GET/SET（apiKey/baseURL/model 三元组，写方案与写作的
 * 出图专用），上面那张提供商列表走 daemon 的 cfg.mediaProviders。真正合并成一套
 * 要改主进程出图逻辑 + daemon 数据流，已确认不在本次范围——所以只是显示位置挨着，
 * 实现各走各的，改任一侧都不会影响另一侧。
 *
 * 搬迁时逐字保留的两处防坑（都是 proposal-image-editing 评审查出来的真实缺陷，
 * 长得像多余的代码，删了就复发）：
 *   1. `loaded` 守卫 —— apiKey 初值是 ''，mount 时那次 GET 还没回来就点保存，
 *      会把已存的 key 静默洗成空。所以 GET 落地前保存按钮一直 disabled。
 *   2. 独立的「清除已保存的 key」按钮 —— 清空输入框再点保存是清不掉的：按钮的
 *      mousedown 先触发 input 的 blur，onBlur 把空值还原成掩码，发出去的永远是
 *      「保留原值」。不改 blur 语义（还原掩码本身是对的，防止「点一下看看就把
 *      key 丢了」），另开一个按钮走显式清除。
 *
 * UI 层按项目纪律用 shadcn 原语 + Tailwind utility 重写（原 chat 版是裸 input/
 * button）：canvas 的 CSS 未分层，裸元素会被 canvas reset 填成描边卡片，shadcn
 * 原语自带 data-slot、天然豁免那条 reset。不复用任何 .field-* / .settings-* 类。
 */

const DEFAULT_MODEL = 'gpt-image-2';

export function ProposalImageApiSubsection(): React.JSX.Element {
  const tt = useTt();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // 见头注释防坑 1：保存必须等这次 GET 落地。
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // chatApi 守卫：本目录其它 section（AccountSection / AppearanceSection /
    // CliBackendCard / UpdateAppSection）都是这个写法。搬来的 chat 版没有守卫是
    // 因为 chat 树只在 Electron 里渲染，而 canvas 面用 `bun dev:next` 时会跑在
    // **真浏览器**里（localhost:3100，preload 不存在 → window.chatApi 是
    // undefined）。裸调会从 mount effect 抛 TypeError——而本组件现在嵌在
    // 「媒体生成提供商」里，那一下会把整节连坐拖挂（此前那一节在无 chatApi
    // 时渲染正常）。守卫后退化为「表单在，但读不到已存配置」，不影响同页
    // 其它内容。
    const api = typeof window !== 'undefined' ? window.chatApi : undefined;
    if (!api?.proposalImageSettingsGet) {
      setLoaded(true); // 不留在「加载中」态，否则保存按钮永远灰着且没人解释为什么
      return;
    }
    api
      .proposalImageSettingsGet()
      .then((cfg) => {
        if (cancelled) return;
        if (!cfg) {
          setLoaded(true);
          return;
        }
        setApiKey(cfg.apiKey);
        setBaseURL(cfg.baseURL);
        setModel(cfg.model || DEFAULT_MODEL);
        setConfigured(cfg.apiKey === PROPOSAL_IMAGE_API_KEY_MASK);
        setLoaded(true);
      })
      .catch((err) => {
        console.error('[settings] proposalImageSettingsGet failed', err);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 「去设置」直达：本小节挂在「媒体生成提供商」底部，上面排着 8 个提供商卡片，
  // 落到分区顶部时它在视口下方约 1892px（视口高 800）——不滚过去的话用户点完
  // 「去设置」还得自己找两屏半。锚点用掉即焚，理由见 store 里 anchor 的注释。
  useEffect(() => {
    if (useSettingsOverlayStore.getState().anchor !== 'proposalImageApi') return;
    // rAF：mount 时同节的 8 张提供商卡片还在布局，立刻滚会按旧高度算错位置。
    const id = requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // ⚠️ 消费 anchor 必须在 rAF 回调**内部**、滚动之后——不能提到 effect 开头。
      // React 开发模式会把每个组件 mount → unmount → mount 一遍（用来暴露副作用
      // 清理写得对不对）。放在开头的话时序是：
      //   ① mount1 读到 anchor → 清空 → 注册 rAF
      //   ② 立刻 unmount → cleanup 里 cancelAnimationFrame，**滚动被取消**
      //   ③ mount2 读 anchor → 已经是空 → 直接 return，永远不滚
      // 实测就是这样（日志里 effect 跑两次、第二次 anchor 已空，页面纹丝不动）。
      // 放进回调后，被取消的那次不算「用掉」，第二次挂载仍能读到 anchor 并真的
      // 滚过去。原则：一次性令牌要在**动作真正完成时**核销，不是在打算做的时候。
      consumeSettingsOverlayAnchor();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    const api = window.chatApi;
    if (!api?.proposalImageSettingsSet) return; // 同 mount 守卫：浏览器下无 preload
    setSaving(true);
    setJustSaved(false);
    try {
      const cfg: ProposalImageApiConfig = { apiKey, baseURL, model };
      await api.proposalImageSettingsSet(cfg);
      // 手里这份 key 现在可能已经过期（用户刚敲了新的，或它本来就是掩码）。
      // 无论哪种都在本地重新打掩码，让明文在 state 里存活不超过这一个来回。
      // 但 apiKey 为 '' 时（用户只动了 baseURL/model、从没填过 key）main 存的
      // 就是 ''，没有东西可掩——这时强行打掩码 + configured=true 会显示一个
      // 假的「已配置」态，直到组件重新挂载才消失。
      if (apiKey) {
        setApiKey(PROPOSAL_IMAGE_API_KEY_MASK);
        setConfigured(true);
      }
      setJustSaved(true);
    } catch (err) {
      console.error('[settings] proposalImageSettingsSet failed', err);
    } finally {
      setSaving(false);
    }
  };

  // 见头注释防坑 2。
  const handleClearKey = async (): Promise<void> => {
    if (saving) return;
    const api = window.chatApi;
    if (!api?.proposalImageSettingsSet) return;
    setSaving(true);
    setJustSaved(false);
    try {
      await api.proposalImageSettingsSet({ apiKey: '', baseURL, model });
      setApiKey('');
      setConfigured(false);
    } catch (err) {
      console.error('[settings] proposalImageSettingsSet(clear) failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={rootRef} className="mt-8 border-t border-border/50 pt-6">
      <h2 className="text-[15px] font-semibold text-foreground">
        {tt('settings.proposalImageApi.title', '写方案出图 API')}
      </h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {tt(
          'settings.proposalImageApi.desc',
          '「写方案」「写作」里生成配图用的接口。与上面的提供商列表是两套独立配置。',
        )}
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[11px] text-muted-foreground">
            {tt('settings.proposalImageApi.keyLabel', 'API Key')}
          </span>
          <Input
            type="password"
            value={apiKey}
            onFocus={() => {
              // 还显示着掩码时聚焦即清空，省得用户先手动删掉那几个点才能敲新
              // key。不敲直接失焦 = 「保留原 key」，由下面的 onBlur 还原。
              if (apiKey === PROPOSAL_IMAGE_API_KEY_MASK) setApiKey('');
            }}
            onBlur={() => {
              if (apiKey === '' && configured) setApiKey(PROPOSAL_IMAGE_API_KEY_MASK);
            }}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              configured
                ? tt('settings.proposalImageApi.keyPlaceholderConfigured', '已配置')
                : tt('settings.proposalImageApi.keyPlaceholderEmpty', 'sk-…')
            }
          />
          {configured ? (
            <Button
              variant="link"
              onClick={() => void handleClearKey()}
              disabled={saving || !loaded}
              className="mt-1 h-auto p-0 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              {tt('settings.proposalImageApi.keyClear', '清除已保存的 key')}
            </Button>
          ) : null}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-muted-foreground">
            {tt('settings.proposalImageApi.baseUrlLabel', '接口地址')}
          </span>
          <Input
            type="text"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-muted-foreground">
            {tt('settings.proposalImageApi.modelLabel', '模型')}
          </span>
          <Input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
          />
        </label>

        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !loaded}
            size="sm"
          >
            {saving
              ? tt('settings.proposalImageApi.saving', '保存中…')
              : tt('settings.proposalImageApi.save', '保存')}
          </Button>
          {justSaved && !saving ? (
            <span className="text-[11px] text-muted-foreground/70">
              {tt('settings.proposalImageApi.saved', '已保存')}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
