/**
 * IndexedDB 持久化层（Dexie 封装）· 铁路道岔巡检与天窗修编排台
 * - 数据结构版本号 + 升级迁移逻辑
 * - 各实体表增删改查（含级联删除）
 * - 首屏自动播种互相引用的演示数据（站场 → 道岔 → 巡检 → 病害 → 天窗作业单）
 * 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Yard } from '../types/yard';
import type { Switch } from '../types/switch';
import type { Inspection } from '../types/inspection';
import type { Fault } from '../types/fault';
import type { WorkOrder, WorkOrderKickback } from '../types/workOrder';
import { ROW_REVISION, type Revisioned } from '../types/persistence';
import { nowDateTime, shiftDate, todayDate, windowMinutes } from './window';
import { nowIso, uuid } from './format';
import { conflictSources, type OrderLike } from './orchestration';
import { atomicCommit, recoverPendingCommits } from './atomicCommit';
import {
  FaultOccupiedError,
  KickbackBlockingError,
  RevisionConflictError,
} from './concurrency';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbrailswitch';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

export { ROW_REVISION };
export type { Revisioned };

/** 业务表名（供原子提交按表恢复镜像） */
export type TableName =
  | 'yards'
  | 'switches'
  | 'inspections'
  | 'faults'
  | 'workOrders'
  | 'restrictions';

/** 未完成提交的 WAL 日志行 */
export interface PendingCommitRow {
  id: string;
  /** 提交类别（如 workOrder.complete） */
  kind: string;
  /** 提交前镜像（表名 + id + 旧整行） */
  before: Array<{
    table: TableName;
    id: string;
    row: Record<string, unknown> | null;
  }>;
  createdAt: string;
}

/** 封锁 / 慢行条件登记（/backup 页） */
export interface SpeedRestriction extends Revisioned {
  id: string;
  /** 关联站场 */
  yardId: string;
  /** 关联道岔（可空，表示站场级） */
  switchCode: string;
  /** 限速值 km/h */
  limitKmh: number;
  /** 起止时间描述 */
  period: string;
  /** 登记原因 */
  reason: string;
  createdAt: string;
}

export type YardRow = Yard;
export type SwitchRow = Switch;
export type InspectionRow = Inspection;
export type FaultRow = Fault;
export type WorkOrderRow = WorkOrder;
export type SpeedRestrictionRow = SpeedRestriction;

class RailSwitchDatabase extends Dexie {
  yards!: Table<YardRow, string>;
  switches!: Table<SwitchRow, string>;
  inspections!: Table<InspectionRow, string>;
  faults!: Table<FaultRow, string>;
  workOrders!: Table<WorkOrderRow, string>;
  restrictions!: Table<SpeedRestrictionRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;
  /** 原子提交 WAL：作业单完成（状态 + 销号）的提交前镜像 */
  pendingCommits!: Table<PendingCommitRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据）
    this.version(1).stores({
      yards: 'id, name, region',
      switches: 'id, yardId, code, frogNumber',
      inspections: 'id, switchId, date',
      faults: 'id, inspectionId, part, severity, state',
      workOrders: 'id, code, state, windowStart',
    });

    // v2：新增 revision 行修订号；道岔补充轨型索引，病害补充组合索引便于按巡检批量操作，
    //     作业单补充负责人索引，并新增封锁条件表
    this.version(2)
      .stores({
        yards: 'id, name, region, mileage',
        switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
        inspections: 'id, switchId, date, inspector, [switchId+date]',
        faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
        workOrders: 'id, code, state, windowStart, leader',
        restrictions: 'id, yardId, switchCode',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('yards'),
          tx.table('switches'),
          tx.table('inspections'),
          tx.table('faults'),
          tx.table('workOrders'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
          });
        }
        // 迁移：旧版病害字段 faultType → type，faultPart → part
        await tx.table('faults').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.type !== 'string' && typeof row.faultType === 'string') row.type = row.faultType;
          if (typeof row.part !== 'string' && typeof row.faultPart === 'string') row.part = row.faultPart;
          if (row.solvedAt === undefined) row.solvedAt = null;
          if (row.sizeMm === undefined) row.sizeMm = null;
        });
        // 迁移：旧版作业单 faultIds 为字符串时拆分为数组
        await tx.table('workOrders').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.faultIds === 'string') {
            row.faultIds = String(row.faultIds)
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
          }
          if (!Array.isArray(row.members)) row.members = [];
          if (!Array.isArray(row.machines)) row.machines = [];
        });
      });

    // v3：作业单补充备注与退回草稿记录；新增 pendingCommits 原子提交日志表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        yards: 'id, name, region, mileage',
        switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
        inspections: 'id, switchId, date, inspector, [switchId+date]',
        faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
        workOrders: 'id, code, state, windowStart, leader',
        restrictions: 'id, yardId, switchCode',
        settings: 'id',
        pendingCommits: 'id, kind, createdAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('workOrders')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.remark !== 'string') row.remark = '';
            if (row.draftKickback === undefined) row.draftKickback = null;
          });
      });
  }
}

export const db = new RailSwitchDatabase();

/* ============================== 演示数据播种 ============================== */

function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

interface SeedSwitchSpec {
  code: string;
  frogNumber: Switch['frogNumber'];
  railType: Switch['railType'];
  turnoutType: Switch['turnoutType'];
  position: string;
}

interface SeedYardSpec {
  name: string;
  mileage: string;
  trackCount: number;
  region: string;
  switches: SeedSwitchSpec[];
}

const SEED_YARDS: SeedYardSpec[] = [
  {
    name: '沙河堡站',
    mileage: 'K312+450',
    trackCount: 6,
    region: '沙河桥工务车间',
    switches: [
      { code: '1#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: 'I 道东端' },
      { code: '3#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: 'I 道西端' },
      { code: '7#', frogNumber: '18', railType: '60kg/m', turnoutType: 'single', position: 'II 道东端渡线' },
      { code: '11#', frogNumber: '9', railType: '50kg/m', turnoutType: 'double', position: 'III 道调车线' },
    ],
  },
  {
    name: '云岭线路所',
    mileage: 'K358+120',
    trackCount: 4,
    region: '云岭线路车间',
    switches: [
      { code: '2#', frogNumber: '18', railType: '60kg/m', turnoutType: 'crossing', position: '正线交分道岔' },
      { code: '4#', frogNumber: '12', railType: '60kg/m', turnoutType: 'single', position: '到发线东端' },
      { code: '6#', frogNumber: '9', railType: '50kg/m', turnoutType: 'single', position: '货物线' },
      { code: '8#', frogNumber: '12', railType: '60kg/m', turnoutType: 'double', position: '联络线' },
    ],
  },
];

const INSPECTORS = ['赵铁军', '孙立波', '周振海', '吴长胜'];
const FAULT_PARTS: Fault['part'][] = ['pointRail', 'stockRail', 'frog', 'machine'];
const FAULT_TYPES: Fault['type'][] = ['wear', 'spalling', 'crack', 'gap', 'looseBolt'];
const FAULT_SEVERITIES: Fault['severity'][] = ['light', 'medium', 'heavy'];

/**
 * 播种：2 个站场 × 各 4 组道岔 × 1~2 次巡检 × 若干病害 + 2 张天窗作业单 + 封锁条件。
 * 数据父子互相引用（yardId / switchId / inspectionId / faultIds），全部页面打开即有内容。
 */
async function seedDatabase(): Promise<void> {
  const random = makeRandom(20260824);
  const stamp = nowIso();

  const yards: YardRow[] = [];
  const switches: SwitchRow[] = [];
  const inspections: InspectionRow[] = [];
  const faults: FaultRow[] = [];
  const workOrders: WorkOrderRow[] = [];
  const restrictions: SpeedRestrictionRow[] = [];

  SEED_YARDS.forEach((yardSpec, yardIndex) => {
    const yardId = `yard-${yardIndex + 1}`;
    yards.push({
      id: yardId,
      name: yardSpec.name,
      mileage: yardSpec.mileage,
      trackCount: yardSpec.trackCount,
      region: yardSpec.region,
      createdAt: stamp,
      revision: ROW_REVISION,
    });

    yardSpec.switches.forEach((switchSpec, switchIndex) => {
      const switchId = `sw-${yardIndex + 1}-${switchIndex + 1}`;
      switches.push({
        id: switchId,
        yardId,
        code: switchSpec.code,
        frogNumber: switchSpec.frogNumber,
        railType: switchSpec.railType,
        position: switchSpec.position,
        turnoutType: switchSpec.turnoutType,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      // 每道岔 1~2 次巡检
      const inspectionCount = random() > 0.45 ? 2 : 1;
      for (let inspectionIndex = 0; inspectionIndex < inspectionCount; inspectionIndex += 1) {
        const inspectionId = `insp-${switchId}-${inspectionIndex + 1}`;
        const offsetDays = inspectionIndex === 0 ? -Math.floor(random() * 6) - 2 : -Math.floor(random() * 26) - 9;
        const date = shiftDate(offsetDays);
        inspections.push({
          id: inspectionId,
          switchId,
          date,
          inspector: INSPECTORS[Math.floor(random() * INSPECTORS.length)],
          weather: (['sunny', 'rain', 'snow', 'wind'] as Inspection['weather'][])[
            Math.floor(random() * 4)
          ],
          method: (['manual', 'car', 'ride'] as Inspection['method'][])[Math.floor(random() * 3)],
          createdAt: stamp,
          revision: ROW_REVISION,
        });

        // 每次巡检挂 0~3 条病害（首次巡检病害更多）
        const faultCount = inspectionIndex === 0 ? Math.floor(random() * 3) + 1 : Math.floor(random() * 2);
        for (let faultIndex = 0; faultIndex < faultCount; faultIndex += 1) {
          const severityRoll = random();
          const severity: Fault['severity'] =
            FAULT_SEVERITIES[severityRoll > 0.82 ? 2 : severityRoll > 0.5 ? 1 : 0];
          const part = FAULT_PARTS[Math.floor(random() * FAULT_PARTS.length)];
          const type = FAULT_TYPES[Math.floor(random() * FAULT_TYPES.length)];
          const sizeMm =
            type === 'crack' || type === 'looseBolt'
              ? null
              : Number((1 + random() * 9).toFixed(1));
          const solved = severity === 'light' && random() > 0.5;
          faults.push({
            id: `fault-${inspectionId}-${faultIndex + 1}`,
            inspectionId,
            part,
            type,
            severity,
            sizeMm,
            state: solved ? 'solved' : 'pending',
            solvedAt: solved ? `${shiftDate(offsetDays + 2)} 15:30` : null,
            createdAt: stamp,
            revision: ROW_REVISION,
          });
        }
      }
    });
  });

  // 天窗作业单：为部分待修病害编排（同一时间窗刻意留一张不冲突、一张与人员冲突）
  const pendingFaults = faults.filter((item) => item.state === 'pending');
  const today = todayDate();
  const groups: Array<{ faults: FaultRow[]; start: string; end: string; leader: string; state: WorkOrderRow['state'] }> = [
    {
      faults: pendingFaults.filter((item) => item.severity !== 'light').slice(0, 3),
      start: `${shiftDate(0)} 09:00`,
      end: `${shiftDate(0)} 11:30`,
      leader: '赵铁军',
      state: 'issued',
    },
    {
      faults: pendingFaults.filter((item) => item.severity === 'light').slice(0, 2),
      start: `${shiftDate(0)} 10:00`,
      end: `${shiftDate(0)} 12:00`,
      leader: '孙立波',
      state: 'planned',
    },
    {
      faults: pendingFaults.slice(3, 5),
      start: `${shiftDate(1)} 13:00`,
      end: `${shiftDate(1)} 15:00`,
      leader: '周振海',
      state: 'planned',
    },
  ];

  groups.forEach((group, index) => {
    if (group.faults.length === 0) return;
    workOrders.push({
      id: `wo-${index + 1}`,
      code: `TW-${today.replace(/-/g, '')}-${String(index + 1).padStart(2, '0')}`,
      faultIds: group.faults.map((item) => item.id),
      windowStart: group.start,
      windowEnd: group.end,
      leader: group.leader,
      machines: index === 0 ? ['轨距尺', '钢轨打磨机', '扭矩扳手'] : ['道尺', '捣固镐'],
      members: index === 0 ? ['赵铁军', '孙立波'] : index === 1 ? ['孙立波', '郑小勇'] : ['周振海', '冯国栋'],
      remark: '',
      state: group.state,
      draftKickback: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
  });

  restrictions.push(
    {
      id: 'restrict-1',
      yardId: 'yard-1',
      switchCode: '11#',
      limitKmh: 25,
      period: `${shiftDate(-2)} ~ ${shiftDate(5)}`,
      reason: '辙叉心磨耗超限，封锁前临时慢行',
      createdAt: stamp,
      revision: ROW_REVISION,
    },
    {
      id: 'restrict-2',
      yardId: 'yard-2',
      switchCode: '2#',
      limitKmh: 45,
      period: `${shiftDate(1)} ~ ${shiftDate(1)}`,
      reason: '交分道岔打磨作业，天窗内限速',
      createdAt: stamp,
      revision: ROW_REVISION,
    },
  );

  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions],
    async () => {
      await db.yards.bulkPut(yards);
      await db.switches.bulkPut(switches);
      await db.inspections.bulkPut(inspections);
      await db.faults.bulkPut(faults);
      await db.workOrders.bulkPut(workOrders);
      await db.restrictions.bulkPut(restrictions);
    },
  );
}

/* ============================== 初始化 ============================== */

/** 打开数据库；站场表为空时播种演示数据（幂等）；启动时回滚残留的半成品提交 */
export async function initDatabase(): Promise<void> {
  await db.open();
  // 上次作业单完成提交若在中途失败 / 崩溃，按 WAL 镜像恢复到提交前的完整状态
  await recoverPendingCommits();
  await normalizeWorkOrders();
  const count = await db.yards.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/** 补齐历史作业单行缺失的 v3 字段（remark / draftKickback） */
async function normalizeWorkOrders(): Promise<void> {
  await db.workOrders.toCollection().modify((row) => {
    if (typeof row.remark !== 'string') row.remark = '';
    if (row.draftKickback === undefined) row.draftKickback = null;
  });
}

/* ============================== 站场 ============================== */

export async function listYards(): Promise<YardRow[]> {
  const rows = await db.yards.toArray();
  return rows.sort((a, b) => a.mileage.localeCompare(b.mileage));
}

export async function putYard(row: YardRow): Promise<void> {
  await db.yards.put(row);
}

/** 删除站场并级联清理道岔 / 巡检 / 病害 / 封锁条件 */
export async function removeYard(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions],
    async () => {
      const switchRows = await db.switches.where('yardId').equals(id).toArray();
      const switchIds = switchRows.map((item) => item.id);
      const inspectionRows = switchIds.length
        ? await db.inspections.where('switchId').anyOf(switchIds).toArray()
        : [];
      const inspectionIds = inspectionRows.map((item) => item.id);
      const faultRows = inspectionIds.length
        ? await db.faults.where('inspectionId').anyOf(inspectionIds).toArray()
        : [];
      const faultIds = new Set(faultRows.map((item) => item.id));
      if (faultIds.size > 0) {
        const orders = await db.workOrders.toArray();
        for (const order of orders) {
          const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
          if (remaining.length !== order.faultIds.length) {
            if (remaining.length === 0) await db.workOrders.delete(order.id);
            else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: order.revision + 1 });
          }
        }
      }
      if (inspectionIds.length) await db.faults.where('inspectionId').anyOf(inspectionIds).delete();
      if (switchIds.length) await db.inspections.where('switchId').anyOf(switchIds).delete();
      await db.switches.where('yardId').equals(id).delete();
      await db.restrictions.where('yardId').equals(id).delete();
      await db.yards.delete(id);
    },
  );
}

/* ============================== 道岔 ============================== */

export async function listSwitches(): Promise<SwitchRow[]> {
  const rows = await db.switches.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function putSwitch(row: SwitchRow): Promise<void> {
  await db.switches.put(row);
}

export async function putSwitches(rows: SwitchRow[]): Promise<void> {
  await db.switches.bulkPut(rows);
}

export async function removeSwitch(id: string): Promise<void> {
  await db.transaction('rw', [db.switches, db.inspections, db.faults, db.workOrders], async () => {
    const inspectionRows = await db.inspections.where('switchId').equals(id).toArray();
    const inspectionIds = inspectionRows.map((item) => item.id);
    if (inspectionIds.length > 0) {
      const faultRows = await db.faults.where('inspectionId').anyOf(inspectionIds).toArray();
      const faultIds = new Set(faultRows.map((item) => item.id));
      const orders = await db.workOrders.toArray();
      for (const order of orders) {
        const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
        if (remaining.length !== order.faultIds.length) {
          if (remaining.length === 0) await db.workOrders.delete(order.id);
          else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: order.revision + 1 });
        }
      }
      await db.faults.where('inspectionId').anyOf(inspectionIds).delete();
      await db.inspections.where('switchId').equals(id).delete();
    }
    await db.switches.delete(id);
  });
}

/* ============================== 巡检 ============================== */

export async function listInspections(): Promise<InspectionRow[]> {
  const rows = await db.inspections.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putInspection(row: InspectionRow): Promise<void> {
  await db.inspections.put(row);
}

/** 删除巡检并级联删除病害，同时从作业单中摘除对应病害 */
export async function removeInspection(id: string): Promise<void> {
  await db.transaction('rw', [db.inspections, db.faults, db.workOrders], async () => {
    const faultRows = await db.faults.where('inspectionId').equals(id).toArray();
    const faultIds = new Set(faultRows.map((item) => item.id));
    const orders = await db.workOrders.toArray();
    for (const order of orders) {
      const remaining = order.faultIds.filter((faultId) => !faultIds.has(faultId));
      if (remaining.length !== order.faultIds.length) {
        if (remaining.length === 0) await db.workOrders.delete(order.id);
        else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: order.revision + 1 });
      }
    }
    await db.faults.where('inspectionId').equals(id).delete();
    await db.inspections.delete(id);
  });
}

/* ============================== 病害 ============================== */

export async function listFaults(): Promise<FaultRow[]> {
  return db.faults.toArray();
}

export async function putFault(row: FaultRow): Promise<void> {
  await db.faults.put(row);
}

export async function putFaults(rows: FaultRow[]): Promise<void> {
  await db.faults.bulkPut(rows);
}

export async function removeFault(id: string): Promise<void> {
  await db.transaction('rw', [db.faults, db.workOrders], async () => {
    const orders = await db.workOrders.toArray();
    for (const order of orders) {
      if (!order.faultIds.includes(id)) continue;
      const remaining = order.faultIds.filter((faultId) => faultId !== id);
      if (remaining.length === 0) await db.workOrders.delete(order.id);
      else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: order.revision + 1 });
    }
    await db.faults.delete(id);
  });
}

/* ============================ 天窗作业单 ============================ */

export async function listWorkOrders(): Promise<WorkOrderRow[]> {
  const rows = await db.workOrders.toArray();
  return rows.sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

export async function putWorkOrder(row: WorkOrderRow): Promise<void> {
  await db.workOrders.put(row);
}

export async function removeWorkOrder(id: string): Promise<void> {
  await db.transaction('rw', db.workOrders, async () => {
    await db.workOrders.delete(id);
    // 冲突来源被删除后，重算剩余「待编排」作业单的退回草稿标记：冲突已消失的自动解除
    const remaining = await db.workOrders.toArray();
    const stamp = nowDateTime();
    for (const order of remaining) {
      if (order.state !== 'planned' || !order.draftKickback) continue;
      const sources = conflictSources(
        toOrderLike(order),
        remaining.filter((item) => item.id !== order.id).map(toOrderLike),
      );
      if (sources.length === 0) {
        await db.workOrders.put({ ...order, draftKickback: null, updatedAt: stamp, revision: order.revision + 1 });
      }
    }
  });
}

/* ===================== 作业单原子编排保存（修订号提交） ===================== */

/** 作业单保存入参：表单内容 + 页面依据的修订号（新建时为 null） */
export interface WorkOrderSaveInput {
  id: string | null;
  code: string;
  faultIds: string[];
  windowStart: string;
  windowEnd: string;
  leader: string;
  machines: string[];
  members: string[];
  remark: string;
  /** 打开编辑时读到的作业单修订号；与库内不一致即拒绝写入（乐观锁） */
  expectedRevision: number | null;
}

/** 保存成功结果：最新行 + 本次计算出的冲突来源（供页面提示，但不阻断 planned 保存） */
export interface WorkOrderSaveResult {
  order: WorkOrderRow;
  /** 本次表单对其它未下达作业单造成的新冲突（时间窗 / 人员 / 机具） */
  kickedBack: Array<{ id: string; code: string; sources: WorkOrderKickback['sources'] }>;
}

/** 把 WorkOrder 转成冲突计算结构 */
function toOrderLike(order: WorkOrderRow): OrderLike {
  return {
    id: order.id,
    code: order.code,
    state: order.state,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    members: order.members,
    machines: order.machines,
  };
}

/**
 * 原子保存作业单（新建 / 编辑）。
 * 同一个 IndexedDB 读写事务内完成：
 * 1. 修订号核对：编辑提交必须与最新行修订号一致，否则抛 RevisionConflictError；
 * 2. 病害占用校验：待修病害已被其它作业单（含已下达 / 作业中 / 已完成未销号）占用则拦截；
 * 3. 写入目标作业单（修订号 +1）；
 * 4. 受本次时间窗 / 人员 / 机具变化影响、且状态为 planned 的其它作业单退回草稿，
 *    并在 draftKickback 记录冲突来源（编号 + 原因 + 明细）。
 */
export async function saveWorkOrderAtomically(input: WorkOrderSaveInput): Promise<WorkOrderSaveResult> {
  const result = await db.transaction('rw', [db.workOrders, db.faults], async () => {
    const allOrders = await db.workOrders.toArray();
    const targetId = input.id ?? undefined;
    const existing = targetId ? allOrders.find((item) => item.id === targetId) ?? null : null;

    // 1) 修订号乐观锁
    if (existing && input.expectedRevision !== null && existing.revision !== input.expectedRevision) {
      throw new RevisionConflictError(
        'workOrders',
        existing.id,
        input.expectedRevision,
        existing.revision,
      );
    }

    // 2) 病害占用：一个病害只能编进一张未完成作业单
    if (input.faultIds.length > 0) {
      const occupant = allOrders.find(
        (order) =>
          order.id !== targetId &&
          order.state !== 'done' &&
          input.faultIds.some((faultId) => order.faultIds.includes(faultId)),
      );
      if (occupant) {
        const occupiedId = input.faultIds.find((faultId) => occupant.faultIds.includes(faultId));
        throw new FaultOccupiedError(occupiedId ?? input.faultIds[0], occupant.code);
      }
    }

    const stamp = nowDateTime();
    const nextOrder: WorkOrderRow = existing
      ? {
          ...existing,
          code: input.code.trim() || existing.code,
          faultIds: input.faultIds,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          leader: input.leader.trim(),
          machines: input.machines,
          members: input.members,
          remark: input.remark,
          updatedAt: stamp,
          revision: existing.revision + 1,
          // 本次保存重新计算冲突；仍有冲突时更新来源，无冲突则清除退回标记
          draftKickback: existing.draftKickback,
        }
      : {
          id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          code: input.code.trim(),
          faultIds: input.faultIds,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          leader: input.leader.trim(),
          machines: input.machines,
          members: input.members,
          remark: input.remark,
          state: 'planned',
          draftKickback: null,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
        };

    // 3) 用「保存后」的全量视图计算冲突，先落目标单再评估其它单
    const prospective = existing
      ? allOrders.map((item) => (item.id === existing.id ? nextOrder : item))
      : [...allOrders, nextOrder];

    const targetLike = toOrderLike(nextOrder);

    // 目标单自身的冲突：仍冲突则挂来源（保持在草稿，等人工处理）；不冲突则清标记
    const selfSources = conflictSources(
      targetLike,
      prospective.filter((item) => item.id !== nextOrder.id).map(toOrderLike),
    );
    nextOrder.draftKickback = selfSources.length > 0 ? { sources: selfSources, at: stamp } : null;

    // 4) 其它「待编排（未下达）」作业单：本次保存给其引入了与目标单的新冲突 → 退回草稿并记录来源；
    //    本次保存反而消除了冲突 → 清掉退回标记。
    const kickedBack: WorkOrderSaveResult['kickedBack'] = [];
    const ordersToPut: WorkOrderRow[] = [];
    for (const order of allOrders) {
      if (order.id === nextOrder.id || order.state !== 'planned') continue;
      // 保存前该单与其它单（不含目标单的新内容）的冲突来源
      const beforeView = allOrders.filter((item) => item.id !== order.id && item.id !== nextOrder.id);
      const beforeSources = conflictSources(toOrderLike(order), beforeView.map(toOrderLike));
      const beforeKeys = new Set(beforeSources.map((source) => `${source.reason}@${source.target}@${source.detail}`));
      // 保存后该单在全量视图下的冲突来源
      const afterPeers = prospective.filter((item) => item.id !== order.id).map(toOrderLike);
      const afterSources = conflictSources(toOrderLike({ ...order, draftKickback: null }), afterPeers);
      const afterKeys = new Set(afterSources.map((source) => `${source.reason}@${source.target}@${source.detail}`));
      const introduced = afterSources.filter(
        (source) => source.target === nextOrder.code && !beforeKeys.has(`${source.reason}@${source.target}@${source.detail}`),
      );
      const hadKickback = order.draftKickback !== null;

      if (introduced.length > 0) {
        // 受本次时间窗 / 人员 / 机具变化影响：退回草稿，列出全部现存冲突来源
        ordersToPut.push({
          ...order,
          draftKickback: { sources: afterSources, at: stamp },
          updatedAt: stamp,
          revision: order.revision + 1,
        });
        kickedBack.push({ id: order.id, code: order.code, sources: afterSources });
      } else if (afterSources.length === 0 && hadKickback) {
        // 冲突已全部消除：自动清除退回标记
        ordersToPut.push({
          ...order,
          draftKickback: null,
          updatedAt: stamp,
          revision: order.revision + 1,
        });
      } else if (hadKickback && beforeKeys.size !== afterKeys.size) {
        // 冲突集合有增减但与本单无关：仅刷新来源，不计入本次退回清单
        ordersToPut.push({
          ...order,
          draftKickback: { sources: afterSources, at: stamp },
          updatedAt: stamp,
          revision: order.revision + 1,
        });
      }
    }

    for (const order of ordersToPut) {
      await db.workOrders.put(order);
    }
    await db.workOrders.put(nextOrder);

    return { order: nextOrder, kickedBack };
  });

  return result;
}

/** 读取单张作业单最新版本（重开 / 切回页面时合并用） */
export async function getWorkOrder(id: string): Promise<WorkOrderRow | null> {
  return (await db.workOrders.get(id)) ?? null;
}

/**
 * 推进作业单状态（修订号提交）。
 * - 带未处理退回草稿冲突的 planned 单不能下达（抛 KickbackBlockingError）；
 * - 修订号不一致抛 RevisionConflictError；
 * - 推进到「已完成」时，作业单状态与涉及病害销号在同一个原子事务里写入，
 *   任一步失败都按提交前镜像完整回滚（见 atomicCommit），不留半成品。
 */
export async function advanceWorkOrderAtomically(
  id: string,
  next: WorkOrderRow['state'],
  expectedRevision: number,
): Promise<{ order: WorkOrderRow; solvedCount: number }> {
  // 先读最新行做规则校验（在原子事务内再核对一次，防止读后被改）
  const beforeOrder = await db.workOrders.get(id);
  if (!beforeOrder) throw new Error('作业单不存在或已被其它页面删除');
  if (beforeOrder.revision !== expectedRevision) {
    throw new RevisionConflictError('workOrders', id, expectedRevision, beforeOrder.revision);
  }
  if (next === 'issued' && beforeOrder.state === 'planned' && beforeOrder.draftKickback) {
    throw new KickbackBlockingError();
  }

  const stamp = nowDateTime();

  if (next !== 'done') {
    return await db.transaction('rw', db.workOrders, async () => {
      const current = await db.workOrders.get(id);
      if (!current) throw new Error('作业单不存在或已被其它页面删除');
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError('workOrders', id, expectedRevision, current.revision);
      }
      if (next === 'issued' && current.state === 'planned' && current.draftKickback) {
        throw new KickbackBlockingError();
      }
      const updated: WorkOrderRow = {
        ...current,
        state: next,
        updatedAt: stamp,
        revision: current.revision + 1,
      };
      await db.workOrders.put(updated);
      return { order: updated, solvedCount: 0 };
    });
  }

  // 完成：作业单状态 + 病害销号在同一次提交里落库，WAL 保证崩溃后恢复提交前状态
  const relatedFaults = await db.faults.where('id').anyOf(beforeOrder.faultIds).toArray();
  const pendingFaults = relatedFaults.filter((item) => item.state === 'pending');
  const beforeImages = [
    { table: 'workOrders' as const, id: beforeOrder.id, row: { ...beforeOrder } as unknown as Record<string, unknown> },
    ...pendingFaults.map((fault) => ({
      table: 'faults' as const,
      id: fault.id,
      row: { ...fault } as unknown as Record<string, unknown>,
    })),
  ];

  let solvedCount = 0;
  await atomicCommit({
    kind: 'workOrder.complete',
    before: beforeImages,
    mutate: async () => {
      await db.transaction('rw', [db.workOrders, db.faults], async () => {
        const current = await db.workOrders.get(id);
        if (!current) throw new Error('作业单不存在或已被其它页面删除');
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError('workOrders', id, expectedRevision, current.revision);
        }
        // 关联病害可能在别的页面已销号 / 变化：只把仍是待修的置为已销号
        const latestFaults = await db.faults.where('id').anyOf(current.faultIds).toArray();
        const toSolve = latestFaults.filter((item) => item.state === 'pending');
        for (const fault of toSolve) {
          await db.faults.put({
            ...fault,
            state: 'solved',
            solvedAt: stamp,
            revision: fault.revision + 1,
          });
        }
        solvedCount = toSolve.length;
        const doneOrder: WorkOrderRow = {
          ...current,
          state: 'done',
          updatedAt: stamp,
          revision: current.revision + 1,
        };
        await db.workOrders.put(doneOrder);
      });
    },
  });

  const finalOrder = await db.workOrders.get(id);
  if (!finalOrder) throw new Error('提交后作业单丢失');
  return { order: finalOrder, solvedCount };
}

/* =========================== 封锁 / 慢行条件 =========================== */

export async function listRestrictions(): Promise<SpeedRestrictionRow[]> {
  const rows = await db.restrictions.toArray();
  return rows.sort((a, b) => a.yardId.localeCompare(b.yardId));
}

export async function putRestriction(row: SpeedRestrictionRow): Promise<void> {
  await db.restrictions.put(row);
}

export async function removeRestriction(id: string): Promise<void> {
  await db.restrictions.delete(id);
}

/* ========================== 整库导入导出 ========================== */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
  restrictions: SpeedRestriction[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [yards, switches, inspections, faults, workOrders, restrictions] = await Promise.all([
    listYards(),
    listSwitches(),
    listInspections(),
    listFaults(),
    listWorkOrders(),
    listRestrictions(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowDateTime(),
    yards,
    switches,
    inspections,
    faults,
    workOrders,
    restrictions,
  };
}

/** 导入快照中的作业单补齐 v3 字段，避免旧备份缺字段 */
function normalizeImportedWorkOrder(order: WorkOrderRow): WorkOrderRow {
  return {
    ...order,
    remark: typeof order.remark === 'string' ? order.remark : '',
    draftKickback: order.draftKickback ?? null,
    revision: typeof order.revision === 'number' ? order.revision : 1,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions, db.pendingCommits],
    async () => {
      await Promise.all([
        db.yards.clear(),
        db.switches.clear(),
        db.inspections.clear(),
        db.faults.clear(),
        db.workOrders.clear(),
        db.restrictions.clear(),
        db.pendingCommits.clear(),
      ]);
      await db.yards.bulkPut(snapshot.yards ?? []);
      await db.switches.bulkPut(snapshot.switches ?? []);
      await db.inspections.bulkPut(snapshot.inspections ?? []);
      await db.faults.bulkPut(snapshot.faults ?? []);
      await db.workOrders.bulkPut((snapshot.workOrders ?? []).map(normalizeImportedWorkOrder));
      await db.restrictions.bulkPut(snapshot.restrictions ?? []);
    },
  );
}

/** 清空并重新播种 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions, db.pendingCommits],
    async () => {
      await Promise.all([
        db.yards.clear(),
        db.switches.clear(),
        db.inspections.clear(),
        db.faults.clear(),
        db.workOrders.clear(),
        db.restrictions.clear(),
        db.pendingCommits.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [yards, switches, inspections, faults, workOrders, restrictions] = await Promise.all([
    db.yards.count(),
    db.switches.count(),
    db.inspections.count(),
    db.faults.count(),
    db.workOrders.count(),
    db.restrictions.count(),
  ]);
  return { yards, switches, inspections, faults, workOrders, restrictions };
}

/** 结构版本信息 */
export interface SchemaInfo {
  dbName: string;
  schemaVersion: number;
  rowRevision: number;
  today: string;
}

export function schemaInfo(): SchemaInfo {
  return {
    dbName: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    rowRevision: ROW_REVISION,
    today: todayDate(),
  };
}

/** 新建行的通用字段（供各 slice 组装新记录） */
export function rowMeta(): { createdAt: string; revision: number } {
  return { createdAt: nowIso(), revision: ROW_REVISION };
}

/** 新建 id */
export function newId(prefix: string): string {
  return `${prefix}-${uuid()}`;
}

/** 天窗时长（分钟）：统一走 utils/window 的口径，避免页面重复实现 */
export function durationOf(windowStart: string, windowEnd: string): number {
  return windowMinutes({ windowStart, windowEnd });
}
