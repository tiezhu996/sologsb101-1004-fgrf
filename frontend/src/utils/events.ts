/**
 * 轻量变更广播：Dexie 写入后通知各 Redux slice 重新拉取，实现跨页响应式刷新。
 * 纯前端单页应用内部的同步机制，不涉及网络。
 *
 * 多标签页（多个浏览器 Tab 共享同一 IndexedDB）：
 * - BroadcastChannel 为主：任一标签写入后广播，其它标签收到即从 IndexedDB 重读最新版本；
 * - localStorage storage 事件兜底（个别环境无 BroadcastChannel）；
 * - 重新切回 / 重新激活页面（visibilitychange / focus）时也主动广播一次「我要刷新」，
 *   保证漏听消息的标签切回来一定拿到其它页面的最新版本。
 */
type ChangeListener = () => void;

const listeners = new Set<ChangeListener>();
const CHANNEL_NAME = 'gbrailswitch-db-change';
const STORAGE_KEY = 'gbrailswitch-db-change-at';

let channel: BroadcastChannel | null = null;

/** 订阅数据变更，返回取消订阅函数 */
export function subscribeChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyLocal(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * 广播一次数据变更。
 * @param crossTabOnly true 时只通知其它标签（收到跨标签消息后的回灌不需要再转一次）
 */
export function emitChange(crossTabOnly = false): void {
  if (!crossTabOnly) notifyLocal();
  const payload = `${Date.now()}`;
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch {
      // 通道关闭等极端情况下忽略，localStorage 兜底仍有效
    }
  }
  try {
    // storage 事件只在其它文档触发，本标签不会收到，可与 BroadcastChannel 并存
    window.localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // 隐私模式等场景 localStorage 不可用时忽略
  }
}

/** 跨标签发来变更：本标签重读，但不再向外转（避免消息环） */
function handleRemoteChange(): void {
  notifyLocal();
}

/** 主动请求一次「最新版本」（页面重新可见 / 获得焦点时） */
function requestRefresh(): void {
  if (document.visibilityState === 'hidden') return;
  notifyLocal();
}

/**
 * 初始化跨标签变更桥。幂等，重复调用安全。
 * 同时注册可见性 / 焦点监听，切回页面时强制重读其它页面写入的最新版本。
 */
export function initCrossTabBridge(): void {
  if (typeof window === 'undefined') return;
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', () => handleRemoteChange());
  }
  try {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) handleRemoteChange();
    });
  } catch {
    // localStorage 不可用时忽略
  }
  document.addEventListener('visibilitychange', requestRefresh);
  window.addEventListener('focus', requestRefresh);
}
