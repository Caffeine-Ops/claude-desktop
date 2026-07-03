import type { CSSProperties } from 'react';
import {
  liveSnapshotForComment,
  overlayBoundsFromSnapshot,
  type PreviewCommentSnapshot,
} from '../../comments';
import type { PreviewComment, PreviewCommentMember } from '../../types';
import type { BoardTool, StrokePoint } from './types';

const MAX_BRIDGE_COORDINATE = 1_000_000;

export function CommentPreviewOverlays({
  comments,
  liveTargets,
  hoveredTarget,
  hoveredPodMemberId,
  activeTarget,
  boardTool,
  scale,
  strokePoints,
  onOpenComment,
}: {
  comments: PreviewComment[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
  hoveredTarget: PreviewCommentSnapshot | null;
  hoveredPodMemberId: string | null;
  activeTarget: PreviewCommentSnapshot | null;
  boardTool: BoardTool;
  scale: number;
  strokePoints: StrokePoint[];
  onOpenComment: (comment: PreviewComment, snapshot: PreviewCommentSnapshot) => void;
}) {
  const visibleComments = comments
    .map((comment, index) => ({
      comment,
      index,
      snapshot: liveSnapshotForComment(comment, liveTargets),
    }))
    .filter((item): item is { comment: PreviewComment; index: number; snapshot: PreviewCommentSnapshot } =>
      Boolean(item.snapshot),
    );
  const targetOverlay = activeTarget ?? hoveredTarget;
  return (
    <div className="comment-overlay-layer" aria-hidden={false}>
      {visibleComments.map(({ comment, index, snapshot }) => {
        const bounds = overlayBoundsFromSnapshot(snapshot, scale);
        return (
          <div
            key={comment.id}
            className="comment-saved-marker"
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            }}
            data-testid={`comment-saved-marker-${comment.elementId}`}
          >
            <div className="comment-saved-outline" />
            <button
              type="button"
              className="comment-saved-pin"
              onClick={() => onOpenComment(comment, snapshot)}
              title={`${comment.elementId}: ${comment.note}`}
              aria-label={`Open comment for ${comment.elementId}`}
            >
              {index + 1}
            </button>
          </div>
        );
      })}
      {targetOverlay ? (
        <CommentTargetOverlay
          snapshot={targetOverlay}
          scale={scale}
          selected={Boolean(activeTarget)}
          hoveredMemberId={hoveredPodMemberId}
        />
      ) : null}
      {boardTool === 'pod' && strokePoints.length > 1 ? (
        <svg className="board-pod-stroke">
          <polyline
            points={strokePoints.map((point) => `${point.x * scale},${point.y * scale}`).join(' ')}
          />
        </svg>
      ) : null}
    </div>
  );
}

export function CommentTargetOverlay({
  snapshot,
  scale,
  selected,
  hoveredMemberId,
}: {
  snapshot: PreviewCommentSnapshot;
  scale: number;
  selected: boolean;
  hoveredMemberId?: string | null;
}) {
  const displayMembers = podDisplayMembers(snapshot);
  if (displayMembers.length > 0) {
    const overlayWeights = podOverlayWeights(displayMembers);
    return (
      <>
        {displayMembers.map((member, index) => {
          const bounds = overlayBoundsFromSnapshot(member, scale);
          const width = Math.round(member.position.width);
          const height = Math.round(member.position.height);
          const overlayWeight = overlayWeights[index] ?? {
            backgroundOpacity: 0.24,
            outlineOpacity: 0.72,
            ringOpacity: 0.18,
          };
          const overlayStyle: CSSProperties & Record<string, string | number> = {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            '--comment-overlay-bg': `rgba(22, 119, 255, ${overlayWeight.backgroundOpacity})`,
            '--comment-overlay-ring': `rgba(22, 119, 255, ${overlayWeight.ringOpacity})`,
            '--comment-overlay-border': `rgba(22, 119, 255, ${overlayWeight.outlineOpacity})`,
          };
          const isHoverFocused = hoveredMemberId === member.elementId;
          return (
            <div
              key={`${member.elementId}-${index}`}
              className={`comment-target-overlay comment-target-overlay--member${selected ? ' selected' : ''}${isHoverFocused ? ' is-hover-focused' : ''}`}
              style={overlayStyle}
              data-testid="comment-target-overlay"
            >
              <span className="comment-target-overlay-label">{snapshot.elementId}</span>
            </div>
          );
        })}
      </>
    );
  }
  // Non-member fallback: single-element snapshots have no per-member chips,
  // so the hover-focus channel never reaches this branch — no is-hover-focused
  // class needed here.
  const bounds = overlayBoundsFromSnapshot(snapshot, scale);
  return (
    <div
      className={`comment-target-overlay${selected ? ' selected' : ''}`}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }}
      data-testid="comment-target-overlay"
    >
      <span className="comment-target-overlay-label">{snapshot.elementId}</span>
    </div>
  );
}

function podDisplayMembers(snapshot: PreviewCommentSnapshot): PreviewCommentSnapshot[] {
  if (snapshot.selectionKind !== 'pod' || !Array.isArray(snapshot.podMembers)) return [];
  const memberSnapshots = snapshot.podMembers.map((member) => ({
    filePath: snapshot.filePath,
    elementId: member.elementId,
    selector: member.selector,
    label: member.label,
    text: member.text,
    position: member.position,
    htmlHint: member.htmlHint,
    selectionKind: 'element' as const,
  }));
  const refined = pruneContainerSelections(memberSnapshots);
  return refined.length > 0 ? refined : memberSnapshots;
}

function podOverlayWeights(
  members: PreviewCommentSnapshot[],
): Array<{ backgroundOpacity: number; outlineOpacity: number; ringOpacity: number }> {
  const areas = members.map((member) =>
    Math.max(1, member.position.width * member.position.height),
  );
  const maxArea = Math.max(...areas);
  const minArea = Math.min(...areas);
  return areas.map((area) => {
    const normalized =
      maxArea === minArea ? 1 : 1 - (area - minArea) / (maxArea - minArea);
    const emphasis = Math.pow(normalized, 0.9);
    return {
      backgroundOpacity: roundOverlayOpacity(0.1 + emphasis * 0.6),
      outlineOpacity: roundOverlayOpacity(0.34 + emphasis * 0.36),
      ringOpacity: roundOverlayOpacity(0.08 + emphasis * 0.18),
    };
  });
}

function roundOverlayOpacity(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildPodSnapshot(input: {
  filePath: string;
  strokePoints: StrokePoint[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
}): PreviewCommentSnapshot | null {
  if (input.strokePoints.length < 2) return null;
  const closedLoop = isClosedLoop(input.strokePoints);
  const intersected = Array.from(input.liveTargets.values()).filter((snapshot) =>
    selectionHitsSnapshot({
      points: input.strokePoints,
      snapshot,
      closedLoop,
    }),
  );
  const refined = pruneContainerSelections(intersected);
  const selected = refined.length > 0 ? refined : intersected;
  if (selected.length === 0) return null;
  const bounds = selected.reduce(
    (acc, snapshot) => {
      const rect = snapshot.position;
      return {
        left: Math.min(acc.left, rect.x),
        top: Math.min(acc.top, rect.y),
        right: Math.max(acc.right, rect.x + rect.width),
        bottom: Math.max(acc.bottom, rect.y + rect.height),
      };
    },
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const podMembers: PreviewCommentMember[] = selected.map((snapshot) => ({
    elementId: snapshot.elementId,
    selector: snapshot.selector,
    label: snapshot.label,
    text: snapshot.text,
    position: snapshot.position,
    htmlHint: snapshot.htmlHint,
  }));
  const summary = selected
    .slice(0, 3)
    .map((snapshot) => summarizeSnapshot(snapshot))
    .join(' · ');
  const htmlHint = selected
    .slice(0, 4)
    .map((snapshot) => snapshot.htmlHint)
    .filter(Boolean)
    .join(' ');
  const combinedSelector = selected
    .slice(0, 8)
    .map((snapshot) => snapshot.selector)
    .filter(Boolean)
    .join(', ');
  return {
    filePath: input.filePath,
    elementId: `pod-${Date.now()}`,
    selector: combinedSelector || 'body *',
    label: summary || `Pod of ${intersected.length} items`,
    text: intersected
      .slice(0, 4)
      .map((snapshot) => snapshot.text)
      .filter(Boolean)
      .join(' · '),
    position: {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.max(1, Math.round(bounds.right - bounds.left)),
      height: Math.max(1, Math.round(bounds.bottom - bounds.top)),
    },
    htmlHint: htmlHint.slice(0, 180),
    selectionKind: 'pod',
    memberCount: selected.length,
    podMembers,
  };
}

function pruneContainerSelections(
  snapshots: PreviewCommentSnapshot[],
): PreviewCommentSnapshot[] {
  if (snapshots.length < 2) return snapshots;
  return snapshots.filter((candidate) => {
    const candidateArea = Math.max(1, candidate.position.width * candidate.position.height);
    const contained = snapshots.filter(
      (other) =>
        other.elementId !== candidate.elementId &&
        rectContains(candidate.position, other.position),
    );
    if (contained.length === 0) return true;
    const union = contained.reduce(
      (acc, other) => ({
        left: Math.min(acc.left, other.position.x),
        top: Math.min(acc.top, other.position.y),
        right: Math.max(acc.right, other.position.x + other.position.width),
        bottom: Math.max(acc.bottom, other.position.y + other.position.height),
      }),
      {
        left: Number.POSITIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY,
      },
    );
    const unionArea = Math.max(1, (union.right - union.left) * (union.bottom - union.top));
    return !(contained.length >= 2 && candidateArea > unionArea * 2.4);
  });
}

function summarizeSnapshot(snapshot: PreviewCommentSnapshot): string {
  const text = snapshot.text.trim();
  if (text) {
    const trimmed = text.length > 28 ? `${text.slice(0, 25)}...` : text;
    return `${snapshot.label || snapshot.elementId} · ${trimmed}`;
  }
  return snapshot.label || snapshot.elementId;
}

function selectionHitsSnapshot(input: {
  points: StrokePoint[];
  snapshot: PreviewCommentSnapshot;
  closedLoop: boolean;
}): boolean {
  const bounds = {
    left: input.snapshot.position.x,
    top: input.snapshot.position.y,
    width: input.snapshot.position.width,
    height: input.snapshot.position.height,
  };
  if (pathIntersectsRect(input.points, bounds)) return true;
  if (!input.closedLoop) return false;
  const center = {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
  if (pointInPolygon(center, input.points)) return true;
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top + bounds.height },
    { x: bounds.left, y: bounds.top + bounds.height },
  ];
  return corners.some((corner) => pointInPolygon(corner, input.points));
}

function isClosedLoop(points: StrokePoint[]): boolean {
  if (points.length < 4) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(first.x - last.x, first.y - last.y) <= 28;
}

function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function pathIntersectsRect(
  points: StrokePoint[],
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  if (points.length === 0) return false;
  const x1 = rect.left;
  const y1 = rect.top;
  const x2 = rect.left + rect.width;
  const y2 = rect.top + rect.height;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return true;
    }
    const next = points[index + 1];
    if (!next) continue;
    if (
      lineIntersectsLine(point, next, { x: x1, y: y1 }, { x: x2, y: y1 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y1 }, { x: x2, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y2 }, { x: x1, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x1, y: y2 }, { x: x1, y: y1 })
    ) {
      return true;
    }
  }
  return false;
}

function pointInPolygon(point: StrokePoint, polygon: StrokePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x <
        ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineIntersectsLine(a1: StrokePoint, a2: StrokePoint, b1: StrokePoint, b2: StrokePoint): boolean {
  const denominator =
    (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (denominator === 0) return false;
  const ua =
    ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub =
    ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

export function finiteBridgeInteger(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return clampBridgeCoordinate(value);
}

export function clampBridgeCoordinate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-MAX_BRIDGE_COORDINATE, Math.min(MAX_BRIDGE_COORDINATE, Math.round(numeric)));
}
