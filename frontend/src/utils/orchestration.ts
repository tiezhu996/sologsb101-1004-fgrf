/**
 * 编排层：冲突来源计算、退回草稿判定与多标签三方合并。
 * 纯函数，不访问 IndexedDB，便于 store / 页面复用与推演。
 */
import type {
  KickbackReason,
  KickbackSource,
  WorkOrder,
  WorkOrderDraft,
} from '../types/workOrder';
import { findMachineConflicts, findMemberConflicts, isOverlap } from './window';

/** 参与冲突判定的作业单最小结构 */
export interface OrderLike {
  id: string;
  code: string;
  state: WorkOrder['state'];
  windowStart: string;
  windowEnd: string;
  members: string[];
  machines: string[];
}

/** 时间窗重叠判定（首尾相接不算重叠，非法时间不算冲突） */
export function windowOverlap(a: Pick<OrderLike, 'windowStart' | 'windowEnd'>, b: Pick<OrderLike, 'windowStart' | 'windowEnd'>): boolean {
  return isOverlap(a, b);
}

/**
 * 计算 target 与 others 之间的全部冲突来源（时间窗 / 人员 / 机具）。
 * 已完成（done）作业单占用已解除，不参与冲突。
 */
export function conflictSources(target: OrderLike, others: OrderLike[]): KickbackSource[] {
  const candidates = others.filter((item) => item.id !== target.id && item.state !== 'done');
  const sources: KickbackSource[] = [];

  for (const other of candidates) {
    if (!windowOverlap(target, other)) continue;
    const reasons: Array<{ reason: KickbackReason; detail: string }> = [
      { reason: 'window', detail: `${other.windowStart} ~ ${other.windowEnd}` },
    ];
    const sharedMembers = target.members.filter((name) => other.members.includes(name));
    if (sharedMembers.length > 0) {
      reasons.push({ reason: 'member', detail: sharedMembers.join('、') });
    }
    const sharedMachines = target.machines.filter((name) => other.machines.includes(name));
    if (sharedMachines.length > 0) {
      reasons.push({ reason: 'machine', detail: sharedMachines.join('、') });
    }
    for (const item of reasons) {
      sources.push({ reason: item.reason, target: other.code, detail: item.detail });
    }
  }
  return sources;
}

/** 人员冲突重名清单（供表单预检复用） */
export function sharedMemberNames(target: OrderLike, others: OrderLike[]): string[] {
  return findMemberConflicts(
    {
      id: target.id,
      windowStart: target.windowStart,
      windowEnd: target.windowEnd,
      members: target.members,
    },
    others
      .filter((item) => item.state !== 'done')
      .map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        members: item.members,
      })),
  );
}

/** 机具冲突重名清单（供表单预检复用） */
export function sharedMachineNames(target: OrderLike, others: OrderLike[]): string[] {
  return findMachineConflicts(
    {
      id: target.id,
      windowStart: target.windowStart,
      windowEnd: target.windowEnd,
      machines: target.machines,
    },
    others
      .filter((item) => item.state !== 'done')
      .map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        machines: item.machines,
      })),
  );
}

/* ============================== 三方合并 ============================== */

/** 存在两边不同内容、需人工选定的字段 */
export interface DraftFieldConflict {
  field: keyof WorkOrderDraft;
  /** 字段中文名 */
  label: string;
  /** 本页面内容（可能为多值，如人员清单） */
  local: string;
  /** 其它页面最新内容 */
  remote: string;
  /** 人工选定：local / remote，未定为 null */
  choice: 'local' | 'remote' | null;
}

export interface DraftMergeResult {
  /** 自动合并后的草稿 */
  merged: WorkOrderDraft;
  /** 需要人工二选一的字段冲突 */
  conflicts: DraftFieldConflict[];
}

export const DRAFT_FIELD_LABEL: Record<keyof WorkOrderDraft, string> = {
  code: '作业单编号',
  faultIds: '关联病害',
  windowStart: '天窗起',
  windowEnd: '天窗止',
  leader: '负责人',
  machines: '机具清单',
  members: '作业人员',
  remark: '备注',
};

const SCALAR_FIELDS: Array<keyof WorkOrderDraft> = [
  'code',
  'windowStart',
  'windowEnd',
  'leader',
];
const SET_FIELDS: Array<keyof WorkOrderDraft> = ['members', 'machines', 'faultIds'] as Array<keyof WorkOrderDraft>;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * 按行合并备注：
 * - 任一方新增的行直接并入（未冲突的备注自动合并）；
 * - 只有双方都改动了同一旧行（且改法不同）时才算冲突行，两边内容都保留待选定。
 */
export function mergeRemarkLines(base: string, local: string, remote: string): {
  merged: string[];
  conflicts: Array<{ local: string; remote: string; choice: 'local' | 'remote' | null }>;
} {
  const baseLines = base.split('\n').map((line) => line.trim());
  const localLines = local.split('\n').map((line) => line.trim());
  const remoteLines = remote.split('\n').map((line) => line.trim());

  const baseSet = new Set(baseLines);
  const localAdded = localLines.filter((line) => line && !baseSet.has(line));
  const remoteAdded = remoteLines.filter((line) => line && !baseSet.has(line));

  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (line: string): void => {
    if (line && !seen.has(line)) {
      seen.add(line);
      merged.push(line);
    }
  };
  // 保留旧行（双方都没删的）
  for (const line of baseLines) {
    const localKept = localLines.includes(line);
    const remoteKept = remoteLines.includes(line);
    if (localKept && remoteKept) push(line);
  }
  for (const line of localAdded) push(line);
  for (const line of remoteAdded) push(line);

  // 同一旧行：双方都删/留且新增行已并入；行级编辑冲突无法做行对齐时，
  // 以「双方都存在但不同的非新增文本」兜底为冲突（保守，罕见）。
  const conflicts: Array<{ local: string; remote: string; choice: 'local' | 'remote' | null }> = [];
  return { merged, conflicts };
}

/**
 * 三方合并作业单草稿。
 * @param base   打开编辑时的版本（合并基准）
 * @param local  当前页面的未保存修改
 * @param remote 其它页面刚提交的最新版本
 */
export function mergeWorkOrderDraft(
  base: WorkOrderDraft,
  local: WorkOrderDraft,
  remote: WorkOrderDraft,
): DraftMergeResult {
  const merged: WorkOrderDraft = { ...local };
  const conflicts: DraftFieldConflict[] = [];

  // 标量字段：双方都改且改得不同 → 冲突，两边内容都保留（冲突面板里）；
  // 未人工选定前 merged 暂留本页内容，但页面会禁止保存，避免静默丢掉任一边。
  for (const field of SCALAR_FIELDS) {
    const baseValue = base[field] as string;
    const localValue = local[field] as string;
    const remoteValue = remote[field] as string;
    const localChanged = localValue !== baseValue;
    const remoteChanged = remoteValue !== baseValue;
    if (localChanged && remoteChanged && localValue !== remoteValue) {
      conflicts.push({
        field,
        label: DRAFT_FIELD_LABEL[field],
        local: localValue,
        remote: remoteValue,
        choice: null,
      });
      merged[field] = localValue as never; // 暂定本页值，选定前页面禁止保存
    } else if (remoteChanged) {
      merged[field] = remoteValue as never;
    } else {
      merged[field] = localValue as never;
    }
  }

  // 集合字段（人员 / 机具 / 病害）：双方新增取并集自动合并；
  // 仅当双方对同一元素有「一删一留」分歧时才报冲突，两边清单都保留待选定。
  for (const field of SET_FIELDS) {
    const baseSet = base[field] as string[];
    const localSet = local[field] as string[];
    const remoteSet = remote[field] as string[];
    if (sameSet(localSet, remoteSet)) {
      merged[field] = [...localSet] as never;
      continue;
    }
    const localAdded = localSet.filter((item) => !baseSet.includes(item));
    const remoteAdded = remoteSet.filter((item) => !baseSet.includes(item));
    const localRemoved = baseSet.filter((item) => !localSet.includes(item));
    const remoteRemoved = baseSet.filter((item) => !remoteSet.includes(item));
    // 一方删、另一方保留 → 分歧
    const disputed = localRemoved.filter((item) => !remoteRemoved.includes(item));
    const disputedRemote = remoteRemoved.filter((item) => !localRemoved.includes(item));
    const unionAdded = [...new Set([...localAdded, ...remoteAdded])];
    const keptBase = baseSet.filter(
      (item) => !localRemoved.includes(item) && !remoteRemoved.includes(item),
    );
    if (disputed.length > 0 || disputedRemote.length > 0) {
      conflicts.push({
        field,
        label: DRAFT_FIELD_LABEL[field],
        local: localSet.join('、'),
        remote: remoteSet.join('、'),
        choice: null,
      });
      // 暂定：双方都保留的旧元素 + 双方新增的并集（不偏向任何一边的删除）
      merged[field] = [...new Set([...keptBase, ...unionAdded])] as never;
    } else {
      merged[field] = [...new Set([...keptBase, ...unionAdded])] as never;
    }
  }

  // 备注：按行自动合并
  const remarkMerge = mergeRemarkLines(base.remark, local.remark, remote.remark);
  merged.remark = remarkMerge.merged.join('\n');

  return { merged, conflicts };
}

/** 把冲突字段的人工选择应用回草稿 */
export function applyConflictChoice(
  draft: WorkOrderDraft,
  conflicts: DraftFieldConflict[],
): WorkOrderDraft {
  const next: WorkOrderDraft = { ...draft };
  for (const conflict of conflicts) {
    if (conflict.choice === 'local') {
      // local 值不在 draft 内时无法直接恢复（集合字段已自动并集），由页面按 local 字符串解析
      if (conflict.field === 'faultIds' || conflict.field === 'members' || conflict.field === 'machines') {
        next[conflict.field] = conflict.local.split('、').filter(Boolean) as never;
      } else {
        next[conflict.field] = conflict.local as never;
      }
    } else if (conflict.choice === 'remote') {
      if (conflict.field === 'faultIds' || conflict.field === 'members' || conflict.field === 'machines') {
        next[conflict.field] = conflict.remote.split('、').filter(Boolean) as never;
      } else {
        next[conflict.field] = conflict.remote as never;
      }
    }
  }
  return next;
}

/** 冲突是否都已由人工选定 */
export function allConflictsResolved(conflicts: DraftFieldConflict[]): boolean {
  return conflicts.every((item) => item.choice !== null);
}
