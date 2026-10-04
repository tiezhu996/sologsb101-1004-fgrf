/**
 * 乐观并发控制与多标签三方合并。
 * - 修订号（revision）：参与并发控制的行每次写入 +1；提交时必须携带读取时的基版号，
 *   落库事务内比对，不一致说明已被别的标签页先保存，本次提交被拦住（CAS）。
 * - 三方合并：重新打开 / 切回页面读到其他标签保存的新版本时，
 *   以「打开编辑时的基线 base、本页草稿 local、最新版本 remote」做字段级合并——
 *   只有一方改动的字段自动收下；两边都改的字段两边内容都保留，交人工选定。
 */
import type { WorkOrderDraft } from '../types/workOrder';

/** 修订号前进一步 */
export function nextRevision(revision: number | undefined): number {
  return typeof revision === 'number' && revision > 0 ? revision + 1 : 1;
}

/** 乐观锁冲突的业务分类（页面据此给出针对性提示） */
export type ConcurrencyReason = 'stale-work-order' | 'fault-occupied' | 'stale-fault' | 'not-found';

/** 并发 / 占用冲突：提交被拦住时抛出，携带结构化明细供页面展示 */
export class ConcurrencyError extends Error {
  readonly reason: ConcurrencyReason;
  readonly details: Record<string, unknown>;

  constructor(reason: ConcurrencyReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConcurrencyError';
    this.reason = reason;
    this.details = details;
  }
}

/* ============================== 三方合并 ============================== */

/** 参与三方合并的字段及中文名（冲突面板按此渲染） */
export const WORK_ORDER_FIELD_LABEL: Record<keyof WorkOrderDraft, string> = {
  code: '作业单编号',
  faultIds: '关联病害',
  windowStart: '天窗起',
  windowEnd: '天窗止',
  leader: '负责人',
  machines: '机具清单',
  members: '作业人员',
  remark: '备注',
};

/** 一个需要人工选定的冲突字段：本页与他页的内容都保留 */
export interface FieldConflict {
  field: keyof WorkOrderDraft;
  /** 打开编辑时的基线内容 */
  base: string | string[];
  /** 本页编辑内容 */
  local: string | string[];
  /** 其他标签保存的最新内容 */
  remote: string | string[];
  /** 人工选定结果；未选定前为 null */
  resolution: 'local' | 'remote' | null;
}

export interface MergeWorkOrderResult {
  /** 自动合并 + 人工选定后的草稿 */
  merged: WorkOrderDraft;
  /** 尚未解决的字段冲突（两边都改了） */
  conflicts: FieldConflict[];
  /** 最新版本相对打开时基线是否发生过变化 */
  changedRemotely: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const setB = new Set(b);
    return a.every((item) => setB.has(item));
  }
  return a === b;
}

/**
 * 作业单草稿三方合并。
 * @param base   打开编辑对话框时的作业单内容
 * @param local  本页尚未保存的编辑内容
 * @param remote 刚从库里读到的其他标签最新版本
 */
export function mergeWorkOrderDraft(
  base: WorkOrderDraft,
  local: WorkOrderDraft,
  remote: WorkOrderDraft,
): MergeWorkOrderResult {
  const fields = Object.keys(WORK_ORDER_FIELD_LABEL) as Array<keyof WorkOrderDraft>;
  const changedRemotely = fields.some((field) => !sameValue(base[field], remote[field]));
  // WorkOrderDraft 的字段值统一为 string | string[]，用宽松记录承接三方合并结果
  const mergedRecord: Record<string, string | string[]> = { ...local };
  const conflicts: FieldConflict[] = [];

  for (const field of fields) {
    const baseValue = base[field];
    const localValue = local[field];
    const remoteValue = remote[field];
    const localChanged = !sameValue(baseValue, localValue);
    const remoteChanged = !sameValue(baseValue, remoteValue);

    if (!remoteChanged) {
      // 他页没动：保留本页内容
      mergedRecord[field] = localValue;
    } else if (!localChanged) {
      // 只有他页改了：自动收下最新内容（含备注自动合并）
      mergedRecord[field] = remoteValue;
    } else if (sameValue(localValue, remoteValue)) {
      // 两边改成一样：直接收
      mergedRecord[field] = remoteValue;
    } else {
      // 两边都改且不一样：两边都保留，先展示他页最新值，等待人工选定
      mergedRecord[field] = remoteValue;
      conflicts.push({
        field,
        base: baseValue as string | string[],
        local: localValue as string | string[],
        remote: remoteValue as string | string[],
        resolution: null,
      });
    }
  }

  const merged = mergedRecord as unknown as WorkOrderDraft;
  return { merged, conflicts, changedRemotely };
}

/** 按人工选定结果把冲突字段落到草稿里 */
export function resolveConflict(
  draft: WorkOrderDraft,
  conflict: FieldConflict,
  resolution: 'local' | 'remote',
): WorkOrderDraft {
  const value = resolution === 'local' ? conflict.local : conflict.remote;
  return { ...draft, [conflict.field]: value };
}
