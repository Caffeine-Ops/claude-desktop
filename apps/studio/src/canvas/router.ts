// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useEffect, useState } from 'react';

import { stripSurfaceOverlayParams } from '@/src/stores/surfaceOverlay';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

export type Route =
  | { kind: 'home'; view: EntryHomeView }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string };

// 注：曾有 `/market` + `/market/:id` 两条路由（Gitee 技能市场的画布面宿主，
// 2026-07-17 上午）。同日下午市场改成 SurfaceHost 的第三个面（?market=1，
// rail 常驻 + 右侧换成市场）后这两条被删——**故意不保留**：market 占 pathname
// 就会让 SurfaceHost 翻到画布面（它只认 pathname 二分），正是「在智能助手点
// 插件被踢去工作画布」那个 bug 的成因，留着等于留一个能复现该行为的入口。
// 面开关（market / kb）见 src/stores/surfaceOverlay.ts。老 od 插件体系的
// /marketplace 不受影响，仍可达（只是撤了 rail 入口）。
//
// 知识库同理**从来没有过路由**（?kb=1）：它 2026-07-17 从「canvas 内部全屏
// overlay」改造成 SurfaceHost 的第四个面时，直接沿用了 market 的 query 机制，
// 没走一遍「先加路由再删」的弯路。

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home', view: 'home' };
  if (parts[0] === 'onboarding') {
    return { kind: 'home', view: 'onboarding' };
  }
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeURIComponent(parts[1]);
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeURIComponent(parts[3]);
        if (parts[4] === 'files' && parts[5]) {
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName: decodeURIComponent(parts.slice(5).join('/')),
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(3).join('/')),
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'design-systems') {
    if (parts[1] === 'create') {
      return { kind: 'design-system-create' };
    }
    if (parts[1]) {
      return { kind: 'design-system-detail', designSystemId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'plugins' && !parts[1]) {
    return { kind: 'home', view: 'plugins' };
  }
  if (parts[0] === 'integrations') {
    return { kind: 'home', view: 'integrations' };
  }
  // Phase 2B / spec §11.6 — marketplace deep UI routes. Two paths:
  //   /marketplace            → catalog grid (MarketplaceView)
  //   /marketplace/<pluginId> → detail page (PluginDetailView)
  // Aliases to /plugins remain reserved for the public site (spec §13);
  // in-app we keep /marketplace canonical.
  if (parts[0] === 'marketplace' || parts[0] === 'plugins') {
    if (parts[1]) {
      return { kind: 'marketplace-detail', pluginId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'marketplace' };
  }
  return { kind: 'home', view: 'home' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'onboarding') return '/onboarding';
    if (route.view === 'projects') return '/projects';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'plugins') return '/plugins';
    if (route.view === 'design-systems') return '/design-systems';
    if (route.view === 'integrations') return '/integrations';
    return '/';
  }
  if (route.kind === 'marketplace') return '/marketplace';
  if (route.kind === 'marketplace-detail') return `/marketplace/${encodeURIComponent(route.pluginId)}`;
  if (route.kind === 'design-system-create') return '/design-systems/create';
  if (route.kind === 'design-system-detail') {
    return `/design-systems/${encodeURIComponent(route.designSystemId)}`;
  }
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName.split('/').map((s) => encodeURIComponent(s)).join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  // Preserve the existing query string across in-app view switches. Routes
  // only carry pathname info, but boot-time flags like `?host=desktop`
  // (set by the Electron shell so the embedded web tab can hide its
  // duplicate settings cog) and `?settings=1` must survive navigation —
  // otherwise pushState would drop them and the flag-gated UI would flip
  // back on the first nav.
  //
  // **面开关**（`?market=1` 插件市场 / `?kb=1` 知识库）是**例外，必须剥掉**
  // （2026-07-17）：上面那些参数是「跟着画布面走的状态」（host flag、canvas
  // 自己的设置 overlay），而面开关是 SurfaceHost 层**盖在画布面之上的另一个
  // 面**——语义相反。不剥的话：rail 的项目列表点一个项目 → navigate →
  // market=1 被带到 /projects/xxx 上 → 那个面继续盖着，用户以为「点了没反应」。
  // 在这里剥而不是让每个调用方各自 close：canvas 导航的入口很多（rail 项目
  // 列表、面包屑、卡片、返回按钮…），逐个打补丁必漏——「我要去画布的某个视图」
  // 这个意图本身就蕴含「面让位」，收在唯一出口最稳。剥哪些参数由
  // stores/surfaceOverlay.ts 的 PARAM_BY_KIND 单点决定，加面不用改这里。
  const search = stripSurfaceOverlayParams(window.location.search);
  // early return 的条件同时看 pathname 与 query：pathname 没变但面开关要剥
  // 时（画布面开着市场、点当前项目）仍须走下去把参数剥掉，否则又是一条死路。
  if (target === current && search === window.location.search) return;
  const targetWithQuery = target + search;
  if (opts.replace) {
    window.history.replaceState(null, '', targetWithQuery);
  } else {
    window.history.pushState(null, '', targetWithQuery);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    // 等价保引用：parseRoute 每次返回新对象，若无条件 setRoute，「语义上没变」
    // 的 popstate 也会触发订阅者全树 re-render。这不是理论洁癖——chat ↔ 画布
    // 切面时 AppRail 的 navigate() 必派发一次 popstate（此刻 URL 是 '/chat'，
    // 同路径早退永远不命中），而 keep-alive 的 canvas 树多半就停在目标视图上：
    // CDP 实测这次「视图零变化」的 setRoute 让 App.tsx（巨型根组件）+
    // EntryShell 白渲染 ~220ms/次（2026-07-16，dev 模式）。等价判定用
    // buildPath 序列化对比（Route 的规范形式，顺带抹平 conversationId 的
    // undefined/null 差异）；等价则返回 prev 保引用，React 对更新直接 bailout。
    // 真实的 back/forward 与视图切换 path 必不同，不受影响。
    const onPop = () => {
      setRoute((prev) => {
        const next = parseRoute(window.location.pathname);
        return buildPath(prev) === buildPath(next) ? prev : next;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
