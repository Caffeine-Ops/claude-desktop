// Prompt overlay layer for HomeHero: the template-slot / `@mention`
// part model, the builders that project prompt text onto it, and the
// inline overlay widgets (mention chips, slot spans, option popover).

import type {
  ConnectorDetail,
  InputFieldSpec,
  InstalledPluginRecord,
  McpServerConfig,
} from '@open-design/contracts';
import type { SkillSummary } from '../../types';
import {
  buildInlineMentionParts,
  inlineMentionToken,
  type InlineMentionEntity,
} from '../../utils/inlineMentions';
import {
  fieldPopoverNote,
  fieldPopoverNoteTone,
  formatPromptInputValue,
  renderInlinePromptEditor,
} from './footerOptions';
import { INPUT_PLACEHOLDER_PATTERN } from './patterns';

type PromptOverlayPart =
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'slot';
      text: string;
      key?: string;
      filled?: boolean;
    }
  | {
      kind: 'mention';
      entity: InlineMentionEntity;
      text: string;
    };

interface PromptMentionRange {
  start: number;
  end: number;
}

interface PromptHighlightPart {
  kind: 'text' | 'slot';
  text: string;
  key?: string;
  filled?: boolean;
}

function buildPromptHighlightParts(
  template: string | null,
  values: Record<string, unknown>,
  prompt: string,
): PromptHighlightPart[] | null {
  if (!template) return null;
  INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
  const parts: PromptHighlightPart[] = [];
  let rendered = '';
  let lastIndex = 0;
  let slotCount = 0;
  let match: RegExpExecArray | null;
  while ((match = INPUT_PLACEHOLDER_PATTERN.exec(template)) !== null) {
    const placeholder = match[0];
    const key = match[1];
    if (!key) continue;
    const literal = template.slice(lastIndex, match.index);
    if (literal) {
      parts.push({ kind: 'text', text: literal });
      rendered += literal;
    }
    const replacement = stringifyTemplateValue(values[key], placeholder);
    parts.push({
      kind: 'slot',
      key,
      text: replacement.text,
      filled: replacement.filled,
    });
    rendered += replacement.text;
    slotCount += 1;
    lastIndex = match.index + placeholder.length;
  }
  const tail = template.slice(lastIndex);
  if (tail) {
    parts.push({ kind: 'text', text: tail });
    rendered += tail;
  }
  if (slotCount === 0 || rendered !== prompt) return null;
  return parts;
}

export function buildPromptOverlayParts(
  template: string | null,
  values: Record<string, unknown>,
  prompt: string,
  mentionEntities: InlineMentionEntity[],
): PromptOverlayPart[] | null {
  const templateParts = buildPromptHighlightParts(template, values, prompt);
  const baseParts: PromptOverlayPart[] = templateParts ?? [{ kind: 'text', text: prompt }];
  const withMentions = injectMentionParts(baseParts, mentionEntities);
  if (templateParts || withMentions.some((part) => part.kind === 'mention')) {
    return withMentions;
  }
  return null;
}

function injectMentionParts(
  parts: PromptOverlayPart[],
  mentionEntities: InlineMentionEntity[],
): PromptOverlayPart[] {
  return parts.flatMap((part) => {
    if (part.kind !== 'text') return [part];
    const mentionParts = buildInlineMentionParts(part.text, mentionEntities);
    return mentionParts
      ? mentionParts.map((mentionPart): PromptOverlayPart => {
          if (mentionPart.kind === 'mention') {
            return {
              kind: 'mention',
              entity: mentionPart.entity,
              text: mentionPart.text,
            };
          }
          return { kind: 'text', text: mentionPart.text };
        })
      : [part];
  });
}

export function buildPromptMentionRanges(parts: PromptOverlayPart[] | null): PromptMentionRange[] {
  if (!parts) return [];
  const ranges: PromptMentionRange[] = [];
  let offset = 0;
  for (const part of parts) {
    const length = part.text.length;
    if (part.kind === 'mention') {
      ranges.push({ start: offset, end: offset + length });
    }
    offset += length;
  }
  return ranges;
}

export function mentionSafeSelection(
  selectionStart: number,
  selectionEnd: number,
  ranges: PromptMentionRange[],
): PromptMentionRange | null {
  if (ranges.length === 0) return null;
  if (selectionStart === selectionEnd) {
    for (const range of ranges) {
      if (selectionStart > range.start && selectionStart < range.end) {
        const before = selectionStart - range.start;
        const after = range.end - selectionStart;
        const caret = before < after ? range.start : range.end;
        return { start: caret, end: caret };
      }
    }
    return null;
  }

  let start = selectionStart;
  let end = selectionEnd;
  for (const range of ranges) {
    const intersects = end > range.start && start < range.end;
    if (!intersects) continue;
    if (start > range.start && start < range.end) start = range.start;
    if (end > range.start && end < range.end) end = range.end;
  }
  return start === selectionStart && end === selectionEnd ? null : { start, end };
}

function pluginMentionText(record: InstalledPluginRecord): string {
  return inlineMentionToken(record.title);
}

function stringifyTemplateValue(
  value: unknown,
  placeholder: string,
): { text: string; filled: boolean } {
  if (value === undefined || value === null || value === '') {
    return { text: placeholder, filled: false };
  }
  return { text: String(value), filled: true };
}

export function buildHomeMentionEntities({
  activePluginRecord,
  activeSkillId,
  activeSkillTitle,
  connectorOptions,
  mcpOptions,
  pluginOptions,
  selectedPluginContexts,
  skillOptions,
}: {
  activePluginRecord: InstalledPluginRecord | null;
  activeSkillId: string | null;
  activeSkillTitle: string | null;
  connectorOptions: ConnectorDetail[];
  mcpOptions: McpServerConfig[];
  pluginOptions: InstalledPluginRecord[];
  selectedPluginContexts: InstalledPluginRecord[];
  skillOptions: SkillSummary[];
}): InlineMentionEntity[] {
  const entities: InlineMentionEntity[] = [];
  const pluginSeen = new Set<string>();
  for (const plugin of [...selectedPluginContexts, ...pluginOptions]) {
    if (pluginSeen.has(plugin.id)) continue;
    pluginSeen.add(plugin.id);
    entities.push({
      id: plugin.id,
      kind: 'plugin',
      label: plugin.title,
      token: pluginMentionText(plugin),
      title: `Plugin: ${plugin.title}`,
    });
  }
  if (activePluginRecord && !pluginSeen.has(activePluginRecord.id)) {
    entities.push({
      id: activePluginRecord.id,
      kind: 'plugin',
      label: activePluginRecord.title,
      token: pluginMentionText(activePluginRecord),
      title: `Plugin: ${activePluginRecord.title}`,
    });
  }
  const skillSeen = new Set<string>();
  for (const skill of skillOptions) {
    if (skillSeen.has(skill.id)) continue;
    skillSeen.add(skill.id);
    entities.push({
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      token: inlineMentionToken(skill.name),
      title: `Skill: ${skill.name}`,
    });
    if (skill.id !== skill.name) {
      entities.push({
        id: skill.id,
        kind: 'skill',
        label: skill.id,
        token: inlineMentionToken(skill.id),
        title: `Skill: ${skill.name}`,
      });
    }
  }
  if (activeSkillId && activeSkillTitle && !skillSeen.has(activeSkillId)) {
    entities.push({
      id: activeSkillId,
      kind: 'skill',
      label: activeSkillTitle,
      token: inlineMentionToken(activeSkillTitle),
      title: `Skill: ${activeSkillTitle}`,
    });
  }
  for (const server of mcpOptions) {
    const label = server.label || server.id;
    entities.push({
      id: server.id,
      kind: 'mcp',
      label,
      token: inlineMentionToken(label),
      title: `MCP: ${label}`,
    });
    if (server.id !== label) {
      entities.push({
        id: server.id,
        kind: 'mcp',
        label: server.id,
        token: inlineMentionToken(server.id),
        title: `MCP: ${label}`,
      });
    }
  }
  for (const connector of connectorOptions) {
    entities.push({
      id: connector.id,
      kind: 'connector',
      label: connector.name,
      token: inlineMentionToken(connector.name),
      title: `Connector: ${connector.name}`,
    });
    if (connector.id !== connector.name) {
      entities.push({
        id: connector.id,
        kind: 'connector',
        label: connector.id,
        token: inlineMentionToken(connector.id),
        title: `Connector: ${connector.name}`,
      });
    }
  }
  return entities;
}

export function InlineMentionToken({
  entity,
  pluginRecord,
  text,
  onOpenPluginDetails,
}: {
  entity: InlineMentionEntity;
  pluginRecord: InstalledPluginRecord | null;
  text: string;
  onOpenPluginDetails: (record: InstalledPluginRecord) => void;
}) {
  if (entity.kind === 'plugin' && pluginRecord) {
    return (
      <button
        type="button"
        className="home-hero__prompt-mention"
        data-plugin-id={pluginRecord.id}
        data-testid={`home-hero-prompt-plugin-${pluginRecord.id}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpenPluginDetails(pluginRecord)}
        title={entity.title ?? `Plugin: ${pluginRecord.title}`}
      >
        {text}
      </button>
    );
  }
  return (
    <span
      className="home-hero__prompt-mention home-hero__prompt-mention--static"
      data-mention-kind={entity.kind}
      title={entity.title ?? text}
    >
      {text}
    </span>
  );
}

interface InlinePromptInputProps {
  field: InputFieldSpec | null;
  name: string;
  value: unknown;
  fallbackText: string;
  filled: boolean;
  editable?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Render plugin-input placeholders as read-only styled spans. Earlier
// revisions used <input>/<select> here, but their CSS widths (min 8ch,
// `displayValue.length + 1` in ch units, select dropdown padding) did
// not match the proportional-font width of the corresponding substring
// in the underlying textarea — so clicking on prose text in the overlay
// landed the caret several characters off, and the misalignment grew
// with every slot on the line. A span renders the exact same glyphs as
// the textarea segment it sits on top of, so the two layouts stay in
// lock-step and clicks land where the user expects. Editing happens in
// the PluginInputsForm below.
export function InlinePromptInput({
  field,
  name,
  value,
  fallbackText,
  filled,
  editable = false,
  open = false,
  onOpenChange = () => undefined,
}: InlinePromptInputProps) {
  const label = field?.label ?? name;
  const displayValue = formatPromptInputValue(field, value, fallbackText);
  // No aria-label here: the editable control with this label lives in
  // the PluginInputsForm below, and findByLabelText must resolve to one
  // element. The span is decorative — it just highlights where the
  // substituted value appears in the prompt the textarea already reads
  // out.
  const hint = filled ? `${label}: ${displayValue}` : label;
  if (editable && field) {
    return (
      <span className="home-hero__prompt-option-shell">
        <button
          type="button"
          className="home-hero__prompt-slot home-hero__prompt-slot--button"
          data-field-name={name}
          data-filled={filled ? 'true' : 'false'}
          data-testid={`home-hero-prompt-slot-${name}`}
          title={hint}
          aria-label={`${label}: ${displayValue}`}
          aria-expanded={open}
          onPointerDown={(event) => {
            event.preventDefault();
            onOpenChange(!open);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.detail === 0) onOpenChange(!open);
          }}
        >
          {displayValue}
        </button>
      </span>
    );
  }
  return (
    <span
      className="home-hero__prompt-slot"
      data-field-name={name}
      data-filled={filled ? 'true' : 'false'}
      data-testid={`home-hero-prompt-slot-${name}`}
      title={hint}
      aria-hidden
    >
      {displayValue}
    </span>
  );
}

export function InlinePromptOptionPopover({
  field,
  value,
  onChange,
}: {
  field: InputFieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div
      className="home-hero__prompt-option-popover"
      data-testid={`home-hero-prompt-option-${field.name}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <span className="home-hero__prompt-option-label">{field.label ?? field.name}</span>
      {renderInlinePromptEditor(field, value, onChange)}
      {fieldPopoverNote(field) ? (
        <span
          className="home-hero__prompt-option-note"
          data-tone={fieldPopoverNoteTone(field)}
          data-testid={`home-hero-prompt-option-${field.name}-note`}
        >
          {fieldPopoverNote(field)}
        </span>
      ) : null}
    </div>
  );
}
