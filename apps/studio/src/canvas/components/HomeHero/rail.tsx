// The type rail under the HomeHero input: chip tab groups, the active
// type chip, and the "more shortcuts" overflow menu.

import { useMemo } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Icon } from '../shared/Icon';
import {
  chipsForGroup,
  type ChipGroup,
  type HomeHeroChip,
} from '../home-hero/chips';
import { useT } from '../../i18n';

interface RailGroupProps {
  group: ChipGroup;
  activeChipId: string | null;
  pendingChipId: string | null;
  pendingPluginId: string | null;
  pluginsLoading: boolean;
  onPickChip: (chip: HomeHeroChip) => void;
  variant?: 'rail' | 'tabs';
  children?: ReactNode;
}

export function RailGroup({
  group,
  activeChipId,
  pendingChipId,
  pendingPluginId,
  pluginsLoading,
  onPickChip,
  variant = 'rail',
  children,
}: RailGroupProps) {
  const t = useT();
  const chips = useMemo(() => chipsForGroup(group), [group]);
  const isTabs = variant === 'tabs';
  return (
    <div
      className={
        isTabs
          ? `home-hero__type-tabs home-hero__type-tabs--${group}`
          : `home-hero__rail-group home-hero__rail-group--${group}`
      }
      data-testid={isTabs ? 'home-hero-type-tabs' : undefined}
      data-rail-group={group}
      role={isTabs ? 'tablist' : undefined}
      aria-label={isTabs ? t('homeHero.railAria') : undefined}
    >
      {chips.map((chip) => {
        const isActive = activeChipId === chip.id;
        const isPending = pendingChipId === chip.id;
        const cls = isTabs
          ? ['home-hero__type-tab', `home-hero__type-tab--${group}`]
          : ['home-hero__rail-chip', `home-hero__rail-chip--${group}`];
        if (isActive) cls.push('is-active');
        if (isPending) cls.push('is-pending');
        return (
          <button
            key={chip.id}
            type="button"
            className={cls.join(' ')}
            data-chip-id={chip.id}
            data-testid={`home-hero-rail-${chip.id}`}
            onClick={() => onPickChip(chip)}
            disabled={pluginsLoading || isPending || pendingPluginId !== null}
            role={isTabs ? 'tab' : undefined}
            aria-selected={isTabs ? isActive : undefined}
            aria-pressed={isTabs ? undefined : isActive}
            title={homeHeroChipTitle(chip, t)}
          >
            <Icon
              name={chip.icon}
              size={14}
              className={isTabs ? 'home-hero__type-tab-icon' : 'home-hero__rail-chip-icon'}
            />
            <span className={isTabs ? 'home-hero__type-tab-label' : 'home-hero__rail-chip-label'}>
              {homeHeroChipLabel(chip.id, t)}
            </span>
          </button>
        );
      })}
      {children}
    </div>
  );
}

export function ActiveTypeChip({ chip, onClear }: { chip: HomeHeroChip; onClear: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="home-hero__active-type-chip"
      data-testid="home-hero-active-type-chip"
      data-chip-id={chip.id}
      title={homeHeroChipTitle(chip, t)}
      aria-label={`${homeHeroChipLabel(chip.id, t)} ${t('common.delete')}`}
      onClick={onClear}
    >
      <span className="home-hero__active-type-chip-icon" aria-hidden>
        <Icon name={chip.icon} size={13} />
      </span>
      <span>{homeHeroChipLabel(chip.id, t)}</span>
      <Icon name="close" size={12} className="home-hero__active-type-chip-close" />
    </button>
  );
}

interface ShortcutsMenuProps {
  activeChipId: string | null;
  pendingChipId: string | null;
  pendingPluginId: string | null;
  pluginsLoading: boolean;
  open: boolean;
  refNode: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onPickChip: (chip: HomeHeroChip) => void;
}

export function ShortcutsMenu({
  activeChipId,
  pendingChipId,
  pendingPluginId,
  pluginsLoading,
  open,
  refNode,
  onOpenChange,
  onPickChip,
}: ShortcutsMenuProps) {
  const t = useT();
  const shortcuts = useMemo(() => chipsForGroup('migrate'), []);
  const disabled = pluginsLoading || pendingPluginId !== null;
  const hasActiveShortcut = shortcuts.some((chip) => chip.id === activeChipId);
  const hasPendingShortcut = shortcuts.some((chip) => chip.id === pendingChipId);
  const triggerClass = [
    'home-hero__type-tab',
    'home-hero__type-tab--more',
    hasActiveShortcut ? 'is-active' : '',
    hasPendingShortcut ? 'is-pending' : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      ref={refNode}
      className="home-hero__shortcut-menu"
      data-testid="home-hero-shortcuts"
      data-rail-group="migrate"
    >
      <button
        type="button"
        className={triggerClass}
        data-testid="home-hero-shortcuts-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('homeHero.moreShortcuts')}
        title={t('homeHero.moreShortcuts')}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="more-horizontal" size={16} className="home-hero__type-tab-icon" />
      </button>
      {open ? (
        <div
          className="home-hero__shortcut-menu-panel"
          role="menu"
          aria-label={t('homeHero.moreShortcuts')}
          data-testid="home-hero-shortcuts-menu"
        >
          {shortcuts.map((chip) => {
            const isActive = activeChipId === chip.id;
            const isPending = pendingChipId === chip.id;
            const cls = ['home-hero__shortcut-menu-item'];
            if (isActive) cls.push('is-active');
            if (isPending) cls.push('is-pending');
            return (
              <button
                key={chip.id}
                type="button"
                role="menuitem"
                className={cls.join(' ')}
                data-chip-id={chip.id}
                data-testid={`home-hero-rail-${chip.id}`}
                disabled={pluginsLoading || isPending || pendingPluginId !== null}
                title={homeHeroChipTitle(chip, t)}
                onClick={() => onPickChip(chip)}
              >
                <Icon name={chip.icon} size={14} className="home-hero__shortcut-menu-icon" />
                <span>{homeHeroChipLabel(chip.id, t)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function homeHeroChipLabel(chipId: string, t: ReturnType<typeof useT>): string {
  switch (chipId) {
    case 'prototype': return t('homeHero.chip.prototype');
    case 'live-artifact': return t('homeHero.chip.liveArtifact');
    case 'deck': return t('homeHero.chip.deck');
    case 'image': return t('homeHero.chip.image');
    case 'video': return t('homeHero.chip.video');
    case 'hyperframes': return t('homeHero.chip.hyperframes');
    case 'audio': return t('homeHero.chip.audio');
    case 'create-plugin': return t('homeHero.chip.createPlugin');
    case 'figma': return t('homeHero.chip.figma');
    case 'template': return t('homeHero.chip.template');
    default: return chipId;
  }
}

function homeHeroChipTitle(chip: HomeHeroChip, t: ReturnType<typeof useT>): string {
  switch (chip.id) {
    case 'live-artifact': return t('homeHero.chip.liveArtifactHint');
    case 'hyperframes': return t('homeHero.chip.hyperframesHint');
    case 'create-plugin': return t('homeHero.chip.createPluginHint');
    case 'figma': return t('homeHero.chip.figmaHint');
    case 'template': return t('homeHero.chip.templateHint');
    default: return homeHeroChipLabel(chip.id, t);
  }
}
