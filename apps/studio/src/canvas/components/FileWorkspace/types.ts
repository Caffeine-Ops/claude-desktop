import type { TodoItem } from '../../runtime/todos';
import type { ProjectMetadata, ProjectFile } from '../../types';

export type TabDropEdge = 'before' | 'after';
export type DesignSystemReviewDecision =
  NonNullable<ProjectMetadata['designSystemReview']>[string]['decision'];
export type DesignSystemReviewEntry = NonNullable<ProjectMetadata['designSystemReview']>[string];
export type DesignSystemReviewAgentTask = NonNullable<DesignSystemReviewEntry['agentTask']>;
export interface DesignSystemReviewDetails {
  feedback?: string;
  files?: string[];
  agentTask?: DesignSystemReviewAgentTask;
}
export type DesignSystemSectionStatus =
  | 'missing'
  | 'planned'
  | 'running'
  | 'needs-review'
  | 'approved'
  | 'needs-work'
  | 'updated';
export type DesignSystemReviewCategory = 'Type' | 'Colors' | 'Spacing' | 'Components' | 'Brand';
export interface DesignSystemProjectSection {
  title: string;
  subtitle: string;
  files: string[];
  category: DesignSystemReviewCategory;
  requiredFile?: string;
}
export type DesignSystemSectionActivityPhase =
  | 'idle'
  | 'planned'
  | 'reading'
  | 'writing'
  | 'updated'
  | 'error';
export interface DesignSystemSectionActivity {
  running: boolean;
  mutated: boolean;
  errored: boolean;
  phase: DesignSystemSectionActivityPhase;
  touchedFiles: string[];
  todoText?: string;
  todoStatus?: TodoItem['status'];
}
export interface DesignSystemProjectSectionReview {
  section: DesignSystemProjectSection;
  previewFile: ProjectFile | null;
  reviewEntry: DesignSystemReviewEntry | undefined;
  sectionActivity: DesignSystemSectionActivity;
  changedAfterFeedback: boolean;
  sectionStatus: DesignSystemSectionStatus;
  sectionStatusLabel: string;
  reviewTimeLabel: string | null;
}
type DesignSystemGenerationStepStatus = 'pending' | 'running' | 'succeeded';
export interface DesignSystemGenerationStep {
  id: string;
  title: string;
  detail: string;
  status: DesignSystemGenerationStepStatus;
}
