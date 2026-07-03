import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 视口惰性挂载：children（预览 iframe 等重资产）在容器进入视口前不渲染，
 * 进过一次后**永久保持挂载**（滚出视口不销毁——反复挂卸会让滚动抖动且
 * 重新加载 iframe 文档，比不卸载更贵）。
 *
 * 为什么不用 iframe 原生 loading="lazy"：Chromium 对 iframe 的 lazy
 * 距离阈值是几千像素，首页网格的上百个预览几乎全部命中「即将进入视口」
 * 而立刻加载（实测切到画布瞬间挂 145 个 iframe，主线程冻结 1.5s）；
 * 且 ExamplesTab 用 srcDoc，根本不受 loading=lazy 约束。IO 的
 * rootMargin 收敛到 256px，视口外的预览真正不加载。
 *
 * 包装 div 撑满父容器（调用方的缩略图容器都有固定尺寸），不改变布局。
 */
export function LazyMount({
  children,
  rootMargin = '256px',
}: {
  children: ReactNode;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (show) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setShow(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [show, rootMargin]);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {show ? children : null}
    </div>
  );
}
