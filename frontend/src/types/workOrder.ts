import type { Revisioned } from './persistence';

/** 天窗作业单状态 */
export type WorkOrderState = 'planned' | 'issued' | 'working' | 'done';

export const WORK_ORDER_STATE_LABEL: Record<WorkOrderState, string> = {
  planned: '待编排',
  issued: '已下达',
  working: '作业中',
  done: '已完成',
};

/** 作业单状态流转 */
export const WORK_ORDER_STATE_FLOW: Record<WorkOrderState, WorkOrderState[]> = {
  planned: ['issued'],
  issued: ['working'],
  working: ['done'],
  done: [],
};

/** 退回草稿的冲突类别 */
export type KickbackReason = 'window' | 'member' | 'machine';

export const KICKBACK_REASON_LABEL: Record<KickbackReason, string> = {
  window: '时间窗重叠',
  member: '人员占用',
  machine: '机具占用',
};

/** 单条冲突来源：与哪张作业单（target 编号）因何原因冲突 */
export interface KickbackSource {
  reason: KickbackReason;
  /** 冲突来源作业单编号 */
  target: string;
  /** 冲突明细（重叠时段 / 重名人员 / 重名机具） */
  detail: string;
}

/** 未下达作业单被退回草稿的记录 */
export interface WorkOrderKickback {
  /** 冲突来源清单 */
  sources: KickbackSource[];
  /** 退回时间 yyyy-MM-dd HH:mm */
  at: string;
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
  /** 备注（多标签按行自动合并） */
  remark: string;
  /** 状态 */
  state: WorkOrderState;
  /** 被其它作业单的时间窗 / 人员 / 机具变化退回草稿的记录；处理完冲突后清空 */
  draftKickback: WorkOrderKickback | null;
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
  /** 退回草稿的冲突来源（draftKickback 的视图镜像） */
  kickbackSources: KickbackSource[];
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
