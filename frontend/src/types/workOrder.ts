import type { Revisioned } from './persistence';

/** 天窗作业单状态 */
export type WorkOrderState = 'draft' | 'planned' | 'issued' | 'working' | 'done';

export const WORK_ORDER_STATE_LABEL: Record<WorkOrderState, string> = {
  draft: '草稿（有冲突）',
  planned: '待编排',
  issued: '已下达',
  working: '作业中',
  done: '已完成',
};

/** 作业单状态流转（draft 只能在冲突解除后由编排保存自动回到 planned） */
export const WORK_ORDER_STATE_FLOW: Record<WorkOrderState, WorkOrderState[]> = {
  draft: [],
  planned: ['issued'],
  issued: ['working'],
  working: ['done'],
  done: [],
};

/** 冲突来源类型 */
export type WorkOrderConflictKind = 'window' | 'member' | 'machine';

export const WORK_ORDER_CONFLICT_KIND_LABEL: Record<WorkOrderConflictKind, string> = {
  window: '时间窗',
  member: '人员',
  machine: '机具',
};

/** 一条冲突来源：与哪张作业单、因什么资源冲突 */
export interface WorkOrderConflictRef {
  /** 冲突作业单 id */
  orderId: string;
  /** 冲突作业单编号 */
  orderCode: string;
  /** 冲突类型 */
  kind: WorkOrderConflictKind;
  /** 冲突资源（人员姓名 / 机具名称；时间窗为空） */
  resource: string;
}

/** 天窗作业单 */
export interface WorkOrder extends Revisioned {
  id: string;
  /** 作业单编号，如 TW-20260824-01 */
  code: string;
  /** 关联病害 id 列表 */
  faultIds: string[];
  /** 天窗起 yyyy-MM-dd HH:mm */
  windowStart: string;
  /** 天窗止 yyyy-MM-dd HH:mm */
  windowEnd: string;
  /** 负责人 */
  leader: string;
  /** 机具清单 */
  machines: string[];
  /** 作业人员 */
  members: string[];
  /** 备注（多标签编辑时支持自动合并） */
  remark: string;
  /** 状态 */
  state: WorkOrderState;
  /** 退回草稿时记录的冲突来源；无冲突时为空数组 */
  conflictRefs: WorkOrderConflictRef[];
  createdAt: string;
  updatedAt: string;
}

/** 作业单表单草稿 */
export interface WorkOrderDraft {
  code: string;
  faultIds: string[];
  windowStart: string;
  windowEnd: string;
  leader: string;
  machines: string[];
  members: string[];
  remark: string;
}

/** 作业单视图：带病害明细与时间窗指标 */
export interface WorkOrderView extends WorkOrder {
  /** 关联病害的展示标签 */
  faultLabels: string[];
  /** 涉及站场 */
  yardNames: string[];
  /** 天窗时长（分钟） */
  durationMinutes: number;
  /** 是否与其它作业单时间窗冲突 */
  conflict: boolean;
  /** 冲突的作业单编号 */
  conflictCodes: string[];
  /** 人员占用冲突 */
  memberConflict: boolean;
  /** 机具占用冲突 */
  machineConflict: boolean;
  /** 实时计算的结构化冲突来源（落库的 conflictRefs 可能是退回草稿那一刻的快照） */
  liveConflictRefs: WorkOrderConflictRef[];
  /** 关联病害中仍未销号的数量 */
  pendingFaultCount: number;
}

/** 常用机具字典 */
export const MACHINE_LIBRARY: string[] = [
  '轨距尺',
  '道尺',
  '起道机',
  '捣固镐',
  '钢轨打磨机',
  '扭矩扳手',
  '辙叉吊具',
  '发电机',
  '照明灯组',
  '转辙机专用工具',
];

/** 常用作业人员 */
export const MEMBER_LIBRARY: string[] = [
  '赵铁军',
  '孙立波',
  '周振海',
  '吴长胜',
  '郑小勇',
  '韩学斌',
  '冯国栋',
];

/** 作业单编号生成 */
export function buildWorkOrderCode(date: Date, seq: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `TW-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(seq)}`;
}
