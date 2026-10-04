/**
 * 轻量变更广播：Dexie 写入后通知各 Redux slice 重新拉取，实现跨页响应式刷新。
 * - 同标签：内存监听器（页面间共享同一个 Redux store）
 * - 跨标签：BroadcastChannel 同步，再叠加 visibilitychange / focus 兜底
 *   （其他标签写入后，重新打开或切回本标签也要看到最新版本）
 * 纯前端单页应用内部的同步机制，不涉及网络。
 */
type ChangeListener = () => void;

const listeners = new Set<ChangeListener>();
const CHANNEL_NAME = 'gbrailswitch-db-change';

/** 订阅数据变更，返回取消订阅函数 */
export function subscribeChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyLocalListeners(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * 广播一次数据变更：先通知本标签，再通知其他已打开的标签页。
 * @param crossTab 是否向其他标签页广播（导入 / 恢复等场景同样需要）
 */
export function emitChange(crossTab = true): void {
  notifyLocalListeners();
  if (crossTab) {
    try {
      channel?.postMessage({ at: Date.now() });
    } catch {
      // 极端情况下 BroadcastChannel 可能被浏览器关闭，忽略即可，切回页面时还有兜底刷新
    }
  }
}

let channel: BroadcastChannel | null = null;

/**
 * 建立跨标签同步：其他标签页写入后自动刷新；
 * 页面重新可见 / 重新获得焦点时再兜底拉取一次（覆盖浏览器限制跨标签消息的环境）。
 * 返回取消函数（应用生命周期内只调用一次）。
 */
export function setupCrossTabSync(): () => void {
  let cleanup: (() => void) | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', () => {
        notifyLocalListeners();
      });
    }
  } catch {
    channel = null;
  }

  let lastRefreshAt = 0;
  const refreshOnVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    // 短时间内的 focus/visibility 抖动只刷一次
    if (now - lastRefreshAt < 800) return;
    lastRefreshAt = now;
    notifyLocalListeners();
  };
  document.addEventListener('visibilitychange', refreshOnVisible);
  window.addEventListener('focus', refreshOnVisible);

  cleanup = () => {
    document.removeEventListener('visibilitychange', refreshOnVisible);
    window.removeEventListener('focus', refreshOnVisible);
    try {
      channel?.close();
    } catch {
      // ignore
    }
    channel = null;
  };
  return cleanup;
}
