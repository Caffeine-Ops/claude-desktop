// Plugin preset cards + prompt example copy for the active type chip:
// picking example plugins for a chip, turning a plugin's use-case query
// into a human prompt preview, and the static per-chip prompt examples.

import { useMemo } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { Icon } from '../shared/Icon';
import { useI18n } from '../../i18n';
import type { Locale } from '../../i18n/types';
import { PreviewSurface } from '../plugins-home/cards/PreviewSurface';
import { inferPluginPreview } from '../plugins-home/preview';
import { INPUT_PLACEHOLDER_PATTERN } from './patterns';

export function PluginPromptPresets({
  activePluginId,
  chipId,
  locale,
  onPick,
  pendingPluginId,
  plugins,
}: {
  activePluginId: string | null;
  chipId: string;
  locale: Locale;
  onPick: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  pendingPluginId: string | null;
  plugins: InstalledPluginRecord[];
}) {
  const { t } = useI18n();
  return (
    <div
      className="home-hero__prompt-examples home-hero__plugin-presets-wrap"
      data-testid="home-hero-plugin-presets"
    >
      <div className="home-hero__prompt-examples-title">
        {t('homeHero.promptExamples')}
      </div>
      <div className="home-hero__plugin-presets" role="list">
        {plugins.map((record) => (
          <PluginPromptPresetCard
            key={record.id}
            chipId={chipId}
            locale={locale}
            record={record}
            active={activePluginId === record.id}
            pending={pendingPluginId === record.id}
            disabled={pendingPluginId !== null}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

function PluginPromptPresetCard({
  active,
  chipId,
  disabled,
  locale,
  onPick,
  pending,
  record,
}: {
  active: boolean;
  chipId: string;
  disabled: boolean;
  locale: Locale;
  onPick: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  pending: boolean;
  record: InstalledPluginRecord;
}) {
  const preview = useMemo(() => inferPluginPreview(record), [record]);
  const promptPreview = pluginPresetPromptPreview(record, locale, chipId);
  return (
    <button
      type="button"
      className={`home-hero__plugin-preset${active ? ' is-active' : ''}${pending ? ' is-pending' : ''}`}
      data-testid="home-hero-plugin-preset"
      data-plugin-id={record.id}
      role="listitem"
      disabled={disabled}
      onClick={() => onPick(record, chipId, promptPreview)}
    >
      <span className="home-hero__plugin-preset-preview" aria-hidden>
        <PreviewSurface
          pluginId={record.id}
          pluginTitle={record.title}
          preview={preview}
        />
      </span>
      <span className="home-hero__plugin-preset-body">
        <span className="home-hero__plugin-preset-title">
          {record.title}
        </span>
        <span className="home-hero__plugin-preset-prompt">
          {promptPreview}
        </span>
      </span>
      <Icon name={active ? 'check' : 'external-link'} size={13} aria-hidden />
    </button>
  );
}

export function homeHeroExamplePluginsForChip(
  chipId: string,
  plugins: InstalledPluginRecord[],
  locale: Locale,
): InstalledPluginRecord[] {
  return plugins
    .filter((plugin) => pluginMatchesExampleChip(plugin, chipId))
    .filter((plugin) => Boolean(pluginPresetQuery(plugin, locale)))
    .sort((a, b) => pluginPresetRank(b, chipId) - pluginPresetRank(a, chipId))
    .slice(0, 18);
}

function pluginMatchesExampleChip(record: InstalledPluginRecord, chipId: string): boolean {
  const slugs = pluginRecordSlugs(record);
  const has = (...values: string[]) => values.some((value) => slugs.has(value));
  const hasPart = (...values: string[]) => {
    const all = [...slugs];
    return values.some((value) =>
      all.some((slug) => slug === value || slug.includes(value) || slug.split('-').includes(value)),
    );
  };
  switch (chipId) {
    case 'prototype':
      return has('prototype') || hasPart('web-prototype');
    case 'deck':
      return has('deck', 'slides', 'slide-deck') || hasPart('slide', 'deck');
    case 'hyperframes':
      return hasPart('hyperframes', 'hyperframe');
    case 'image':
      return (has('image') || hasPart('image-template')) && !hasPart('video', 'audio');
    case 'video':
      return (has('video') || hasPart('video-template')) && !hasPart('hyperframes', 'audio');
    case 'audio':
      return has('audio') || hasPart('audio');
    default:
      return false;
  }
}

function pluginPresetRank(record: InstalledPluginRecord, chipId: string): number {
  const slugs = pluginRecordSlugs(record);
  let score = 0;
  if (record.sourceKind === 'bundled') score += 20;
  if (record.id.startsWith('example-')) score += 12;
  if (record.id.includes('template')) score += 8;
  if (inferPluginPreview(record).kind !== 'text') score += 6;
  if (slugs.has(chipId)) score += 4;
  if (record.manifest?.od?.preview) score += 3;
  return score;
}

function pluginRecordSlugs(record: InstalledPluginRecord): Set<string> {
  const od = record.manifest?.od ?? {};
  const rawValues = [
    record.id,
    record.title,
    record.manifest?.name,
    record.manifest?.title,
    fieldString(od, 'mode'),
    fieldString(od, 'surface'),
    fieldString(od, 'scenario'),
    fieldString(od, 'taskKind'),
    ...(record.manifest?.tags ?? []),
  ];
  return new Set(rawValues.map((value) => slugifyHomeValue(value ?? '')).filter(Boolean));
}

function fieldString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function slugifyHomeValue(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function pluginPresetPromptPreview(
  record: InstalledPluginRecord,
  locale: Locale,
  chipId: string,
): string {
  const query = pluginPresetQuery(record, locale);
  const rendered = query ? renderPluginPresetQuery(record, query) : record.manifest?.description ?? '';
  return textPromptForPluginPreset(record, rendered, chipId, locale);
}

function pluginPresetQuery(record: InstalledPluginRecord, locale: Locale): string | null {
  const query = record.manifest?.od?.useCase?.query;
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object') {
    const localized = query as Record<string, unknown>;
    const exact = localized[locale];
    if (typeof exact === 'string') return exact;
    const language = locale.split('-')[0];
    const languageMatch = Object.entries(localized).find(([key, value]) => (
      key.toLowerCase().startsWith(`${language}-`) && typeof value === 'string'
    ));
    if (typeof languageMatch?.[1] === 'string') return languageMatch[1];
    for (const key of ['zh-CN', 'en', 'default']) {
      if (typeof localized[key] === 'string') return localized[key];
    }
    const first = Object.values(localized).find((value) => typeof value === 'string');
    if (typeof first === 'string') return first;
  }
  return null;
}

function renderPluginPresetQuery(record: InstalledPluginRecord, query: string): string {
  const fields = record.manifest?.od?.inputs ?? [];
  const valueByName = new Map<string, string>();
  for (const field of fields) {
    const value = field.default ?? field.placeholder ?? field.label ?? field.name;
    valueByName.set(field.name, String(value));
  }
  return query
    .replace(
      HOME_ESCAPED_ARGUMENT_PLACEHOLDER_PATTERN,
      (_placeholder, _name: string | undefined, defaultValue: string | undefined) => defaultValue ?? '',
    )
    .replace(
      HOME_ARGUMENT_PLACEHOLDER_PATTERN,
      (
        _placeholder,
        _doubleName: string | undefined,
        _singleName: string | undefined,
        doubleDefault: string | undefined,
        singleDefault: string | undefined,
      ) => doubleDefault ?? singleDefault ?? '',
    )
    .replace(INPUT_PLACEHOLDER_PATTERN, (_placeholder, key: string) => (
      valueByName.get(key) ?? key
    ));
}

function textPromptForPluginPreset(
  record: InstalledPluginRecord,
  prompt: string,
  chipId: string,
  locale: Locale,
): string {
  const cleaned = prompt.trim();
  const structured = parseStructuredPresetPrompt(cleaned);
  if (structured !== null) {
    return describeStructuredPresetPrompt(record, structured, chipId, locale);
  }
  if (cleaned.length > 0) return cleaned;
  return fallbackPluginPresetPrompt(record, chipId, locale);
}

function parseStructuredPresetPrompt(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function describeStructuredPresetPrompt(
  record: InstalledPluginRecord,
  structured: unknown,
  chipId: string,
  locale: Locale,
): string {
  const zh = isChineseLocale(locale);
  const artifact = pluginPresetArtifactLabel(chipId, zh);
  const title = record.title.trim();
  const strings = collectStructuredPromptStrings(structured);
  const main =
    strings.find((item) => isMainPromptField(item.key) && item.value.length >= 8)?.value ??
    strings.find((item) => item.value.length >= 16)?.value ??
    record.manifest?.description ??
    title;
  const detailValues = uniquePromptStrings(
    strings
      .filter((item) => item.value !== main)
      .filter((item) => isUsefulPromptDetail(item.value))
      .map((item) => item.value),
  ).slice(0, 4);
  if (zh) {
    const details = detailValues.length > 0
      ? `重点包含：${detailValues.join('；')}。`
      : '';
    return `使用「${title}」插件生成${artifact}。${main}${sentenceEnd(main)}${details}`;
  }
  const details = detailValues.length > 0
    ? ` Include ${detailValues.join('; ')}.`
    : '';
  return `Create ${englishArticle(artifact)} ${artifact} with the "${title}" preset. ${main}${englishSentenceEnd(main)}${details}`;
}

function collectStructuredPromptStrings(
  value: unknown,
  path: string[] = [],
): Array<{ key: string; value: string }> {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    return [{ key: path[path.length - 1] ?? '', value: text }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStructuredPromptStrings(item, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectStructuredPromptStrings(child, [...path, key]),
    );
  }
  return [];
}

function isMainPromptField(key: string): boolean {
  return [
    'instruction',
    'prompt',
    'description',
    'subject',
    'brief',
    'goal',
  ].includes(key.toLowerCase());
}

function isUsefulPromptDetail(value: string): boolean {
  if (value.length < 8) return false;
  if (/^l\d+:/iu.test(value)) return false;
  return true;
}

function uniquePromptStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function sentenceEnd(value: string): string {
  return /[.!?。！？]$/u.test(value.trim()) ? '' : '。';
}

function englishSentenceEnd(value: string): string {
  return /[.!?。！？]$/u.test(value.trim()) ? '' : '.';
}

function pluginPresetArtifactLabel(chipId: string, zh: boolean): string {
  if (zh) {
    switch (chipId) {
      case 'prototype': return '一个交互原型';
      case 'deck': return '一套 PPT slide';
      case 'image': return '一张图片';
      case 'video': return '一段视频';
      case 'hyperframes': return '一段 HyperFrames 动效视频';
      case 'audio': return '一段音频';
      default: return '一个设计产物';
    }
  }
  switch (chipId) {
    case 'prototype': return 'interactive prototype';
    case 'deck': return 'PPT slide deck';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'hyperframes': return 'HyperFrames motion video';
    case 'audio': return 'audio clip';
    default: return 'design artifact';
  }
}

function englishArticle(noun: string): 'a' | 'an' {
  return /^[aeiou]/iu.test(noun) ? 'an' : 'a';
}

function fallbackPluginPresetPrompt(
  record: InstalledPluginRecord,
  chipId: string,
  locale: Locale,
): string {
  const zh = isChineseLocale(locale);
  const artifact = pluginPresetArtifactLabel(chipId, zh);
  const description = record.manifest?.description?.trim();
  if (zh) {
    return `使用「${record.title}」插件生成${artifact}${description ? `，方向是：${description}` : ''}。`;
  }
  return `Create ${englishArticle(artifact)} ${artifact} with the "${record.title}" preset${description ? `: ${description}` : '.'}`;
}

const HOME_ESCAPED_ARGUMENT_PLACEHOLDER_PATTERN =
  /\{argument\s+name=\\"([^"]+)\\"\s+default=\\"([^"]*)\\"[^}]*\}/g;

const HOME_ARGUMENT_PLACEHOLDER_PATTERN =
  /\{argument\s+name=(?:"([^"]+)"|'([^']+)')\s+default=(?:"([^"]*)"|'([^']*)')[^}]*\}/g;

export function homeHeroChipPromptExamples(chipId: string, locale: Locale): string[] {
  const zh = isChineseLocale(locale);
  switch (chipId) {
    case 'prototype':
      return zh
        ? [
            '为 AI CRM 设计一个高转化官网，包含首屏、功能卖点、客户案例和清晰的试用入口',
            '为团队知识库做一个桌面端仪表盘，突出搜索、最近更新、权限状态和协作入口',
            '重构金融 SaaS 的 onboarding 流程，让新用户能快速完成开户、连接数据和看到首个洞察',
            '设计一个移动端健身教练 App 原型，覆盖目标设定、训练计划、打卡反馈和进度复盘',
          ]
        : [
            'Design a high-converting website for an AI CRM with a clear hero, feature story, proof points, and trial CTA',
            'Create a desktop dashboard for a team knowledge base with search, recent updates, permissions, and collaboration entry points',
            'Redesign onboarding for a financial SaaS product so new users can connect data, finish setup, and see first value fast',
            'Prototype a mobile fitness coaching app covering goal setup, weekly plans, workout check-ins, and progress review',
          ];
    case 'deck':
      return zh
        ? [
            '研究一个新产品发布的市场机会，输出竞品格局、目标用户、定价假设和上市叙事',
            '生成每周团队状态报告，汇总进展、风险、关键指标变化和下周优先级',
            '设计一份投资者推介材料，包含市场规模、增长模型、产品优势和三年预测数据',
            '创建战略业务复盘演示文稿，讲清本季度表现、问题原因、机会判断和下一步行动',
          ]
        : [
            'Research the market opportunity for a product launch, including competitors, target users, pricing hypotheses, and launch narrative',
            'Generate a weekly team status report with progress, risks, metric changes, and next-week priorities',
            'Design an investor pitch with market sizing, growth model, product advantage, and three-year forecast data',
            'Create a strategic business review deck covering quarterly performance, root causes, opportunities, and next actions',
          ];
    case 'image':
      return zh
        ? [
            '生成一张玻璃质感 AI 工作台海报，画面包含多屏协作、柔和光影和高级产品发布氛围',
            '为新款无线耳机做一张电商首屏主图，突出材质细节、佩戴场景和核心卖点',
            '设计一张极简科技发布会 KV，用干净构图、强主视觉和少量文字表达新品发布',
            '做一套社媒新品预热视觉，包含倒计时、局部特写、卖点揭示和发布日主图',
          ]
        : [
            'Generate a glassmorphism AI workspace poster with multi-screen collaboration, soft lighting, and a premium launch mood',
            'Create an ecommerce hero image for new wireless headphones that highlights material detail, lifestyle context, and core benefits',
            'Design a minimalist tech launch key visual with a clean composition, strong product focus, and restrained launch copy',
            'Make a social teaser set for a product drop, including countdown, close-up detail, benefit reveal, and launch-day visual',
          ];
    case 'video':
      return zh
        ? [
            '做一个 8 秒产品 reveal 短片，从暗场轮廓推进到完整产品特写，结尾出现品牌标识',
            '生成一段 App 功能演示视频，按用户操作路径展示核心流程、关键状态和结果反馈',
            '制作竖屏品牌开场动画，用节奏化文字、产品局部和 logo 收束，适合短视频开头',
            '把一个网站转成 15 秒社媒广告，提炼首屏卖点、交互亮点和明确行动号召',
          ]
        : [
            'Make an 8-second product reveal film that moves from silhouette to close-up detail and ends on the brand mark',
            'Generate an app feature demo video that follows the user journey, key states, and final outcome',
            'Create a vertical brand opener with rhythmic typography, product close-ups, and a clean logo ending for short-form video',
            'Turn a website into a 15-second social ad by extracting the hero claim, interaction highlights, and a clear CTA',
          ];
    case 'hyperframes':
      return zh
        ? [
            '做一个带字幕的产品发布短片，包含标题卡、功能镜头、节奏转场和结尾 CTA',
            '生成一段音频响应数据可视化，让柱状图、粒子和标题随旁白节奏变化',
            '制作 logo outro 动效，用线条收束、轻微弹性和品牌色完成 3 秒结尾动画',
            '做一个航线地图动态演示，展示城市节点、路径增长、里程数据和最终汇总画面',
          ]
        : [
            'Build a captioned product launch short with title cards, feature shots, rhythmic transitions, and an ending CTA',
            'Generate an audio-reactive data visualization where bars, particles, and titles respond to narration beats',
            'Create a 3-second logo outro using line convergence, subtle elasticity, and the brand color system',
            'Make an animated flight-route map showing city nodes, route growth, mileage data, and a final summary frame',
          ];
    case 'audio':
      return zh
        ? [
            '生成一段产品启动音效，听起来轻盈、可信、带一点未来感，适合桌面 App 打开时播放',
            '制作 20 秒播客片头音乐，包含温暖前奏、清晰节拍和适合人声进入的收尾',
            '做一个冥想 App 的环境音循环，使用柔和自然声、低频铺底和无缝循环结构',
            '生成一组品牌通知提示音，区分成功、提醒和错误状态，但保持同一声音识别度',
          ]
        : [
            'Generate a product startup sound that feels light, trustworthy, slightly futuristic, and suitable for a desktop app launch',
            'Create a 20-second podcast intro bed with a warm opening, clear pulse, and a clean handoff into voiceover',
            'Make a seamless ambient loop for a meditation app using soft nature textures, low-frequency warmth, and calm pacing',
            'Generate a branded notification sound set for success, reminder, and error states while keeping one sonic identity',
          ];
    default:
      return [];
  }
}

function isChineseLocale(locale: Locale): boolean {
  return locale === 'zh-CN' || locale === 'zh-TW';
}
