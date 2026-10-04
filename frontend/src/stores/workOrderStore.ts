/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 *
 * 多标签并发约定：
 * - 所有保存 / 推进 / 完成都按修订号（revision）提交，基版号来自页面打开编辑时的快照；
 *   其他标签页先行保存导致修订号不一致时，提交被拦住，页面重新读取最新版本后再处理。
 * - 作业单完成走 completeWorkOrder 原子提交（作业单状态 + 病害销号同一次提交），
 *   失败可整体恢复到提交前，不留半成品。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  advanceWorkOrderState,
  completeWorkOrder,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  removeWorkOrder,
  saveWorkOrder,
  type FaultRow,
  type InspectionRow,
  type SaveWorkOrderResult,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from '../utils/db';
import {
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import { findConflictRefs, windowMinutes } from '../utils/window';
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

/**
 * 新建 / 编辑保存作业单：按修订号提交。
 * 成功返回结构化结果（本单冲突、级联退回草稿清单）；
 * 修订号过期 / 病害被占用等并发冲突由 ConcurrencyError 携带明细抛出，页面据此提示。
 */
export const saveWorkOrderThunk = createAsyncThunk<
  SaveWorkOrderResult,
  { id: string | null; baseRevision?: number; draft: WorkOrderDraft },
  {
    rejectValue: { message: string; reason?: string; details?: Record<string, unknown> };
    state: { workOrder: WorkOrderStateSlice };
  }
>('workOrder/save', async ({ id, baseRevision, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const code = draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1);
    const result = await saveWorkOrder({
      id: id ?? undefined,
      baseRevision,
      draft: { ...draft, code },
    });
    emitChange();
    return result;
  } catch (error) {
    const err = error as Error & { reason?: string; details?: Record<string, unknown> };
    return rejectWithValue({
      message: error instanceof Error ? error.message : '保存作业单失败',
      reason: err.reason,
      details: err.details,
    });
  }
});

/**
 * 推进作业单状态。
 * - 推进到「已完成」：作业单状态 + 关联病害销号在同一次原子提交写入；
 * - 其余推进：单表 CAS；修订号过期被拦住，页面重新读取后再操作。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; baseRevision: number; next: WorkOrderState },
  { rejectValue: { message: string; reason?: string; details?: Record<string, unknown> } }
>('workOrder/advance', async ({ id, baseRevision, next }, { rejectWithValue }) => {
  try {
    if (next === 'done') {
      const result = await completeWorkOrder({ id, baseRevision });
      emitChange();
      return { state: 'done' as const, solvedCount: result.solvedCount };
    }
    const updated = await advanceWorkOrderState({ id, baseRevision, next });
    emitChange();
    return { state: updated.state, solvedCount: 0 };
  } catch (error) {
    const err = error as Error & { reason?: string; details?: Record<string, unknown> };
    return rejectWithValue({
      message: error instanceof Error ? error.message : '推进作业单失败',
      reason: err.reason,
      details: err.details,
    });
  }
});

export const deleteWorkOrder = createAsyncThunk<
  void,
  { id: string; revision?: number },
  { rejectValue: string }
>('workOrder/delete', async ({ id, revision }, { rejectWithValue }) => {
  try {
    await removeWorkOrder(id, revision);
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
  }
});

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
      const others = workOrders.filter((item) => item.id !== order.id);
      const liveConflictRefs = findConflictRefs(
        {
          id: order.id,
          code: order.code,
          windowStart: order.windowStart,
          windowEnd: order.windowEnd,
          members: order.members,
          machines: order.machines,
        },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
          machines: item.machines,
        })),
      );
      const conflictCodes = [...new Set(liveConflictRefs.map((item) => item.orderCode))];
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: liveConflictRefs.some((item) => item.kind === 'member'),
        machineConflict: liveConflictRefs.some((item) => item.kind === 'machine'),
        liveConflictRefs,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
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
  draftCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
    draftCount: views.filter((item) => item.state === 'draft').length,
  };
}
