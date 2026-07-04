import { useEffect, useState } from 'react';
import type { ConnectorDetail, InstalledPluginRecord } from '@open-design/contracts';

import { fetchConnectors } from '../../providers/registry';
import type { DesignSystemSummary, Project, SkillSummary } from '../../types';
import { DesignsTab } from '../home/DesignsTab';
import { PluginsView } from '../plugins/PluginsView';
import type { PluginUseAction } from '../plugins-home/useActions';
import type { PluginShareAction, PluginShareProjectOutcome } from '../../state/projects';
import { TasksView } from '../automations/TasksView';

/*
 * 设置页的「工作区」sections（2026-07-04 首页 rail 迁移）。
 *
 * 首页 EntryNavRail 的 项目/自动化/插件 三个入口迁进设置页后，这里做宿主：
 * 内容组件（DesignsTab / TasksView / PluginsView）原样复用（它们在 settings
 * 目录之外，保留自己的 legacy 类不受 settings 迁移新规约束），本文件只提供
 * 数据与动作的接线。
 *
 * 数据/动作来源分两类：
 * - `SettingsWorkspaceHost`：App.tsx 在渲染 SettingsDialog 时打包传入的
 *   数据快照 + 现成 handler。跳转型动作（打开项目等）直接复用 App 的
 *   handler——它们内部 navigate() 改 URL，?settings=1 随之消失，设置
 *   overlay 自动关闭，无需手动 close。
 * - 连接器列表：设置 overlay 模式下 EntryView 未挂载（App 提前 return），
 *   没人喂 connectors，所以 AutomationsSection 像 EntryView 一样自取
 *   （fetchConnectors）。
 */
export interface SettingsWorkspaceHost {
  projects: Project[];
  skills: SkillSummary[];
  designTemplates: SkillSummary[];
  designSystems: DesignSystemSummary[];
  onOpenProject: (id: string) => void;
  onOpenLiveArtifact: (projectId: string, artifactId: string) => void;
  onDeleteProject: (id: string) => Promise<boolean | void> | boolean | void;
  onRenameProject: (id: string, name: string) => void;
  /* 插件流：stash handoff + navigate 回首页 prompt loop（见
     state/homePromptHandoff.ts 的机制注释）。 */
  onCreatePlugin: (goal?: string) => void;
  onUsePlugin: (record: InstalledPluginRecord, action: PluginUseAction) => void;
  onCreatePluginShareProject: (
    pluginId: string,
    action: PluginShareAction,
    locale?: string,
  ) => Promise<PluginShareProjectOutcome>;
}

export function WorkspaceProjectsSection({ host }: { host: SettingsWorkspaceHost }) {
  return (
    <DesignsTab
      projects={host.projects}
      skills={host.skills}
      designSystems={host.designSystems}
      onOpen={host.onOpenProject}
      onOpenLiveArtifact={host.onOpenLiveArtifact}
      onDelete={host.onDeleteProject}
      onRename={host.onRenameProject}
    />
  );
}

export function WorkspaceAutomationsSection({ host }: { host: SettingsWorkspaceHost }) {
  const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchConnectors()
      .then((list) => {
        if (!cancelled) setConnectors(list);
      })
      .catch(() => {
        /* 拉不到连接器时 TasksView 以空列表渲染，不阻塞本节 */
      })
      .finally(() => {
        if (!cancelled) setConnectorsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TasksView
      skills={host.skills}
      designTemplates={host.designTemplates}
      connectors={connectors}
      connectorsLoading={connectorsLoading}
    />
  );
}

export function WorkspacePluginsSection({ host }: { host: SettingsWorkspaceHost }) {
  return (
    <PluginsView
      onCreatePlugin={host.onCreatePlugin}
      onUsePlugin={host.onUsePlugin}
      onCreatePluginShareProject={host.onCreatePluginShareProject}
    />
  );
}
