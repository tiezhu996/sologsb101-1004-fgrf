/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 *
 * 多标签并发：
 * - 保存 / 推进均带行修订号（乐观锁），过期提交被 RevisionConflictError 拦住；
 * - 保存走 saveWorkOrderAtomically：病害被占用即拒，受影响的未下达单退回草稿并记录冲突来源；
 * - 完成走 advanceWorkOrderAtomically：作业单状态与病害销号同一原子提交，失败按 WAL 恢复。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  advanceWorkOrderAtomically,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  removeWorkOrder,
  saveWorkOrderAtomically,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type WorkOrderSaveResult,
  type YardRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import { findMachineConflicts, findMemberConflicts, windowMinutes } from '../utils/window';
import { emitChange } from '../utils/events';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  inspections: [],
  switches: [],
  yards: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, inspections, switches, yards] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
    ]);
    return { workOrders, faults, inspections, switches, yards };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 保存作业单入参：草稿 + 页面依据的修订号（新建为 null） */
export interface SaveWorkOrderArg {
  draft: WorkOrderDraft;
  id: string | null;
  expectedRevision: number | null;
}

/** 保存 / 推进被拒绝时的结构化原因（页面据此引导合并或提示冲突来源） */
export interface ConcurrencyReject {
  message: string;
  /** RevisionConflictError / FaultOccupiedError / KickbackBlockingError / Error */
  name: string;
}

/**
 * 新建 / 更新作业单（修订号提交）。
 * 冲突不阻断 planned 保存，但返回被退回草稿的作业单与冲突来源供页面列出。
 */
export const saveWorkOrder = createAsyncThunk<
  WorkOrderSaveResult,
  SaveWorkOrderArg,
  { rejectValue: ConcurrencyReject }
>('workOrder/save', async ({ draft, id, expectedRevision }, { rejectWithValue }) => {
  try {
    const result = await saveWorkOrderAtomically({
      id,
      code: draft.code,
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader,
      machines: draft.machines,
      members: draft.members,
      remark: draft.remark,
      expectedRevision,
    });
    emitChange();
    return result;
  } catch (error) {
    return rejectWithValue({
      message: error instanceof Error ? error.message : '保存作业单失败',
      name: error instanceof Error ? error.name : 'Error',
    });
  }
});

/**
 * 推进作业单状态（修订号提交）。
 * 推进到「已完成」时，作业单状态与关联病害销号在同一原子事务内提交。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; next: WorkOrderState; expectedRevision: number },
  { rejectValue: ConcurrencyReject }
>('workOrder/advance', async ({ id, next, expectedRevision }, { rejectWithValue }) => {
  try {
    const result = await advanceWorkOrderAtomically(id, next, expectedRevision);
    emitChange();
    return { state: result.order.state, solvedCount: result.solvedCount };
  } catch (error) {
    return rejectWithValue({
      message: error instanceof Error ? error.message : '推进作业单失败',
      name: error instanceof Error ? error.name : 'Error',
    });
  }
});

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突与未销号数量 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter((item) => item.id !== order.id && item.state !== 'done');
      const conflictCodes = others
        .filter((item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd)
        .map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        kickbackSources: order.draftKickback?.sources ?? [],
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未被未完成作业单编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(
    workOrders.filter((item) => item.state !== 'done').flatMap((item) => item.faultIds),
  );
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
  kickedBackCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
    kickedBackCount: views.filter((item) => item.draftKickback !== null).length,
  };
}

/** 流转规则导出，页面据此渲染推进按钮 */
export { WORK_ORDER_STATE_FLOW };
