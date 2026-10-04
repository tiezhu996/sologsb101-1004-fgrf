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
import type { WorkOrder, WorkOrderConflictRef, WorkOrderState } from '../types/workOrder';
import { INITIAL_REVISION, ROW_REVISION, type Revisioned } from '../types/persistence';
import { findConflictRefs, type ConflictOrder } from './window';
import { ConcurrencyError, nextRevision } from './concurrency';
import { nowDateTime, shiftDate, todayDate, windowMinutes } from './window';
import { nowIso, uuid } from './format';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbrailswitch';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

export { INITIAL_REVISION, ROW_REVISION };
export type { Revisioned };

/**
 * 预提交日志（两阶段提交的回滚点）。
 * 作业单完成 = 作业单状态 + 关联病害销号必须在同一次提交里写入；
 * 写业务数据前先落「提交前完整快照」，业务数据落库成功后再删日志。
 * 任意一步失败（含浏览器崩溃后重开），initDatabase 都按日志把作业单与病害
 * 整体恢复到提交前，绝不留下"作业单已完成但销号没写"的半成品。
 */
export interface PendingCommitRow {
  id: string;
  kind: 'complete-work-order';
  createdAt: string;
  /** 提交前作业单完整快照 */
  workOrderBefore: WorkOrder;
  /** 提交前关联病害完整快照（仅提交时被回写销号的那部分） */
  faultsBefore: Fault[];
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
  /** 预提交日志（作业单完成等多表原子提交的回滚点） */
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

    // v3：乐观并发控制——作业单 / 病害的 revision 转为业务修订号（初值 1）；
    //     作业单新增 remark（备注）与 conflictRefs（退回草稿时的冲突来源快照）；
    //     state 新增 draft（草稿，有冲突待处理）；并新增 pendingCommits 预提交日志表。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        yards: 'id, name, region, mileage',
        switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
        inspections: 'id, switchId, date, inspector, [switchId+date]',
        faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
        workOrders: 'id, code, state, windowStart, leader',
        restrictions: 'id, yardId, switchCode',
        settings: 'id',
        pendingCommits: 'id, kind',
      })
      .upgrade(async (tx) => {
        await tx
          .table<WorkOrderRow, string>('workOrders')
          .toCollection()
          .modify((row) => {
            row.revision = INITIAL_REVISION;
            if (typeof row.remark !== 'string') row.remark = '';
            if (!Array.isArray(row.conflictRefs)) row.conflictRefs = [];
          });
        await tx
          .table<FaultRow, string>('faults')
          .toCollection()
          .modify((row) => {
            row.revision = INITIAL_REVISION;
          });
      });
  }
}

export const db = new RailSwitchDatabase();

/** 作业单行 → 冲突计算所需的最小结构 */
export function toConflictOrder(order: WorkOrderRow): ConflictOrder {
  return {
    id: order.id,
    code: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    members: order.members,
    machines: order.machines,
  };
}

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
            revision: INITIAL_REVISION,
          });
        }
      }
    });
  });

  // 天窗作业单：为部分待修病害编排（同一时间窗刻意留一张不冲突、一张与人员冲突）
  // 第 2 张与第 1 张时间窗重叠且人员孙立波重复排班 → 按规则保留为「草稿（有冲突）」
  // 三个分组的病害必须互斥（一处病害只能属于一张作业单），因此从待修池里顺序取
  const pendingPool = faults.filter((item) => item.state === 'pending');
  const groupFaults: FaultRow[][] = [[], [], []];
  for (const fault of pendingPool) {
    if (groupFaults[0].length < 3 && fault.severity !== 'light') groupFaults[0].push(fault);
    else if (groupFaults[1].length < 2 && fault.severity === 'light') groupFaults[1].push(fault);
    else if (groupFaults[2].length < 2) groupFaults[2].push(fault);
  }
  const today = todayDate();
  const groups: Array<{
    faults: FaultRow[];
    start: string;
    end: string;
    leader: string;
    state: WorkOrderRow['state'];
    members: string[];
    machines: string[];
    remark: string;
  }> = [
    {
      faults: groupFaults[0],
      start: `${shiftDate(0)} 09:00`,
      end: `${shiftDate(0)} 11:30`,
      leader: '赵铁军',
      state: 'issued',
      members: ['赵铁军', '孙立波'],
      machines: ['轨距尺', '钢轨打磨机', '扭矩扳手'],
      remark: '已下达，班前会已交底',
    },
    {
      faults: groupFaults[1],
      start: `${shiftDate(0)} 10:00`,
      end: `${shiftDate(0)} 12:00`,
      leader: '孙立波',
      state: 'draft',
      members: ['孙立波', '郑小勇'],
      machines: ['道尺', '捣固镐'],
      remark: '与 01 单人员时间窗冲突，待改期后重新保存',
    },
    {
      faults: groupFaults[2],
      start: `${shiftDate(1)} 13:00`,
      end: `${shiftDate(1)} 15:00`,
      leader: '周振海',
      state: 'planned',
      members: ['周振海', '冯国栋'],
      machines: ['道尺', '捣固镐'],
      remark: '',
    },
  ];

  groups.forEach((group, index) => {
    if (group.faults.length === 0) return;
    const orderId = `wo-${index + 1}`;
    const order: WorkOrderRow = {
      id: orderId,
      code: `TW-${today.replace(/-/g, '')}-${String(index + 1).padStart(2, '0')}`,
      faultIds: group.faults.map((item) => item.id),
      windowStart: group.start,
      windowEnd: group.end,
      leader: group.leader,
      machines: group.machines,
      members: group.members,
      remark: group.remark,
      state: group.state,
      conflictRefs: [],
      createdAt: stamp,
      updatedAt: stamp,
      revision: INITIAL_REVISION,
    };
    // 与已构造的作业单做一次结构化冲突计算，作为草稿冲突来源快照
    order.conflictRefs = findConflictRefs(
      toConflictOrder(order),
      workOrders.map((item) => toConflictOrder(item)),
    );
    workOrders.push(order);
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

/** 打开数据库；先恢复未完成的预提交，再在站场表为空时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  await recoverPendingCommits();
  const count = await db.yards.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/**
 * 恢复未完成的预提交：只要 pendingCommits 里留有日志，说明上次会话在
 * "写作业单状态 + 回写病害销号"的原子提交中途退出（崩溃 / 断电 / 写入失败）。
 * 一律按日志中的提交前快照整体还原，再删除日志，恢复到提交前的完整状态。
 */
export async function recoverPendingCommits(): Promise<{ recovered: number }> {
  const pending = await db.pendingCommits.toArray();
  if (pending.length === 0) return { recovered: 0 };
  await db.transaction('rw', [db.workOrders, db.faults, db.pendingCommits], async () => {
    for (const entry of pending) {
      await db.workOrders.put(entry.workOrderBefore);
      if (entry.faultsBefore.length > 0) await db.faults.bulkPut(entry.faultsBefore);
    }
    await db.pendingCommits.clear();
  });
  return { recovered: pending.length };
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
            else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: nextRevision(order.revision) });
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
          else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: nextRevision(order.revision) });
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
        else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: nextRevision(order.revision) });
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
      else await db.workOrders.put({ ...order, faultIds: remaining, updatedAt: nowIso(), revision: nextRevision(order.revision) });
    }
    await db.faults.delete(id);
  });
}

/* ============================ 天窗作业单 ============================ */

export async function listWorkOrders(): Promise<WorkOrderRow[]> {
  const rows = await db.workOrders.toArray();
  return rows.sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 无并发保护的整行写入（仅供批量导入 / 恢复等内部场景） */
export async function putWorkOrder(row: WorkOrderRow): Promise<void> {
  await db.workOrders.put(row);
}

/** 参与冲突计算的作业单字段 */
export type WorkOrderDraftInput = Pick<
  WorkOrderRow,
  'code' | 'faultIds' | 'windowStart' | 'windowEnd' | 'leader' | 'machines' | 'members' | 'remark'
>;

/** 已被别的作业单占用的病害 */
export interface OccupiedFault {
  faultId: string;
  orderId: string;
  orderCode: string;
}

/** 保存作业单的结果：级联退回草稿清单 + 本单冲突明细 */
export interface SaveWorkOrderResult {
  /** 保存后的作业单 */
  order: WorkOrderRow;
  /** 是否新建 */
  created: boolean;
  /** 本单当前的全部冲突来源 */
  selfConflictRefs: WorkOrderConflictRef[];
  /** 因本单保存而被退回草稿的其他未下达作业单 */
  cascaded: Array<{ id: string; code: string; conflictRefs: WorkOrderConflictRef[] }>;
}

/** 未下达（会因冲突被退回草稿）的状态 */
const FLEXIBLE_STATES: ReadonlySet<WorkOrderState> = new Set(['draft', 'planned']);

function checkFaultOccupation(
  faultIds: string[],
  allOrders: WorkOrderRow[],
  excludeOrderId: string,
): { occupied: OccupiedFault[]; missing: string[] } {
  const occupied: OccupiedFault[] = [];
  const seen = new Set<string>();
  for (const order of allOrders) {
    if (order.id === excludeOrderId) continue;
    for (const faultId of order.faultIds) {
      if (faultIds.includes(faultId) && !seen.has(faultId)) {
        seen.add(faultId);
        occupied.push({ faultId, orderId: order.id, orderCode: order.code });
      }
    }
  }
  return { occupied, missing: [] };
}

/**
 * 按修订号提交作业单（新建 / 编辑保存），一个 IndexedDB 事务内完成：
 * 1. 编辑保存按基版号做 CAS：已被其他标签页改过则拦住，不允许覆盖；
 * 2. 关联病害已被别的作业单占用 → 硬拦截，当前页面提交不生效；
 * 3. 时间窗 / 人员 / 机具一有冲突：本单落为草稿，受影响的其他未下达作业单
 *    一并退回草稿并写入结构化冲突来源；冲突解除后再保存自动回到待编排。
 * 已下达及以后的作业单不被退回。
 */
export async function saveWorkOrder(input: {
  id?: string;
  baseRevision?: number;
  draft: WorkOrderDraftInput;
  now?: string;
}): Promise<SaveWorkOrderResult> {
  const { id, baseRevision, draft, now = nowDateTime() } = input;
  const result = await db.transaction('rw', [db.workOrders, db.faults], async () => {
    const allOrdersRaw = await db.workOrders.toArray();
    // 旧版导入快照可能缺 remark / conflictRefs，统一兜底后再参与计算
    const allOrders = allOrdersRaw.map((row) => ({
      ...row,
      remark: typeof row.remark === 'string' ? row.remark : '',
      conflictRefs: Array.isArray(row.conflictRefs) ? row.conflictRefs : [],
      machines: Array.isArray(row.machines) ? row.machines : [],
      members: Array.isArray(row.members) ? row.members : [],
      faultIds: Array.isArray(row.faultIds) ? row.faultIds : [],
    }));
    const existing = id ? allOrders.find((item) => item.id === id) : undefined;
    if (id && !existing) {
      throw new ConcurrencyError('not-found', '作业单不存在或已被其他页面删除', { orderId: id });
    }
    if (existing && typeof baseRevision === 'number' && existing.revision !== baseRevision) {
      throw new ConcurrencyError('stale-work-order', '该作业单已被其他标签页修改，请读取最新版本后重新编辑', {
        orderId: existing.id,
        orderCode: existing.code,
        baseRevision,
        latestRevision: existing.revision,
      });
    }

    // 病害占用硬拦截（已完成 / 已销号也仍归属作业单，一处病害只能编排进一张作业单）
    const { occupied } = checkFaultOccupation(draft.faultIds, allOrders, existing?.id ?? '__new__');
    if (occupied.length > 0) {
      throw new ConcurrencyError('fault-occupied', '关联病害已被其他作业单占用，请先解除占用', {
        occupied,
      });
    }

    const savedId = existing?.id ?? `wo-${uuid()}`;
    const saved: WorkOrderRow = {
      id: savedId,
      code: draft.code.trim(),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      remark: draft.remark,
      state: existing?.state ?? 'planned',
      conflictRefs: existing?.conflictRefs ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: nextRevision(existing?.revision),
    };

    // 本单与其他作业单的结构化冲突来源
    const others = allOrders.filter((item) => item.id !== savedId).map((item) => toConflictOrder(item));
    const selfConflictRefs = findConflictRefs(toConflictOrder(saved), others);
    saved.conflictRefs = selfConflictRefs;
    if (selfConflictRefs.length > 0) {
      // 有冲突：新建与未下达单落为草稿；已下达及以后的单保持状态（冲突只提示）
      if (!existing || FLEXIBLE_STATES.has(existing.state)) {
        saved.state = 'draft';
      }
    } else if (existing?.state === 'draft') {
      // 冲突解除：草稿重新保存后自动回到待编排
      saved.state = 'planned';
    }

    // 级联：受本单影响的其他未下达作业单
    const cascaded: SaveWorkOrderResult['cascaded'] = [];
    const otherOrders = await Promise.all(
      allOrders
        .filter((item) => item.id !== savedId && FLEXIBLE_STATES.has(item.state))
        .map(async (other) => {
          // 其他单与"本单 + 除本单外的单子"重新计算冲突
          const peers = allOrders
            .filter((item) => item.id !== other.id && item.id !== savedId)
            .map((item) => toConflictOrder(item));
          const refs = findConflictRefs(toConflictOrder(other), [toConflictOrder(saved), ...peers]);
          return { other, refs };
        }),
    );
    for (const { other, refs } of otherOrders) {
      if (other.state === 'draft') {
        // 已是草稿：刷新冲突来源快照；冲突全部解除则自动回到待编排
        const next: WorkOrderRow = {
          ...other,
          conflictRefs: refs,
          state: refs.length === 0 ? 'planned' : 'draft',
          updatedAt: now,
          revision: refs.length === other.conflictRefs.length && sameRefs(refs, other.conflictRefs)
            ? other.revision
            : nextRevision(other.revision),
        };
        if (next.revision !== other.revision || next.state !== other.state) {
          await db.workOrders.put(next);
          cascaded.push({ id: next.id, code: next.code, conflictRefs: refs });
        }
      } else if (refs.length > 0) {
        // 待编排单新产生冲突 → 退回草稿
        const next: WorkOrderRow = {
          ...other,
          state: 'draft',
          conflictRefs: refs,
          updatedAt: now,
          revision: nextRevision(other.revision),
        };
        await db.workOrders.put(next);
        cascaded.push({ id: next.id, code: next.code, conflictRefs: refs });
      }
    }

    await db.workOrders.put(saved);
    return { order: saved, created: !existing, selfConflictRefs, cascaded };
  });
  return result;
}

function sameRefs(a: WorkOrderConflictRef[], b: WorkOrderConflictRef[]): boolean {
  if (a.length !== b.length) return false;
  const key = (ref: WorkOrderConflictRef): string => `${ref.orderId}|${ref.kind}|${ref.resource}`;
  const setB = new Set(b.map(key));
  return a.every((ref) => setB.has(key(ref)));
}

export async function removeWorkOrder(id: string, expectedRevision?: number): Promise<void> {
  await db.transaction('rw', [db.workOrders], async () => {
    if (typeof expectedRevision === 'number') {
      const existing = await db.workOrders.get(id);
      if (existing && existing.revision !== expectedRevision) {
        throw new ConcurrencyError('stale-work-order', '该作业单已被其他标签页修改或删除，请刷新后重试', {
          orderId: id,
          baseRevision: expectedRevision,
          latestRevision: existing.revision,
        });
      }
    }
    await db.workOrders.delete(id);
  });
}

/**
 * 病害销号 / 撤销的 CAS 写入：携带读取时修订号，被其他标签页改过则拦住。
 * 供病害页手工销号使用（作业单完成回写走 completeWorkOrder 的原子事务）。
 */
export async function setFaultStateCAS(input: {
  faultId: string;
  baseRevision: number;
  state: FaultRow['state'];
  solvedAt: string | null;
}): Promise<void> {
  await db.transaction('rw', [db.faults], async () => {
    const existing = await db.faults.get(input.faultId);
    if (!existing) {
      throw new ConcurrencyError('not-found', '病害不存在或已被删除', { faultId: input.faultId });
    }
    if (existing.revision !== input.baseRevision) {
      throw new ConcurrencyError('stale-fault', '该病害已被其他标签页修改，请刷新后重试', {
        faultId: input.faultId,
        baseRevision: input.baseRevision,
        latestRevision: existing.revision,
      });
    }
    await db.faults.put({
      ...existing,
      state: input.state,
      solvedAt: input.solvedAt,
      revision: nextRevision(existing.revision),
    });
  });
}

/**
 * 作业单完成的原子提交（作业单状态 + 关联病害销号在同一次提交里写入）。
 * 两阶段：先落预提交日志（提交前完整快照）→ 再在一个业务事务里写作业单与病害 →
 * 成功后删除日志。任一步失败：
 * - 业务事务失败：IndexedDB 自动回滚，日志仍在，重开时恢复到提交前；
 * - 删日志前崩溃：重开时 initDatabase 按日志把作业单与病害整体恢复到提交前。
 * @param expectedFaultRevisions 仅对修订号匹配的待修病害回写销号；
 *        任一病害已被其他页面改动（如手工销号 / 撤销）则拦住整次提交。
 */
export async function completeWorkOrder(input: {
  id: string;
  baseRevision: number;
  solvedAt?: string;
}): Promise<{ order: WorkOrderRow; solvedCount: number }> {
  const { id, baseRevision, solvedAt = nowDateTime() } = input;

  // 阶段一：在独立事务里抓取提交前完整快照并落预提交日志
  const commitId = `commit-${uuid()}`;
  const before = await db.transaction<{ order: WorkOrderRow; faultsBefore: FaultRow[] }>(
    'r',
    [db.workOrders, db.faults],
    async () => {
      const order = await db.workOrders.get(id);
      if (!order) {
        throw new ConcurrencyError('not-found', '作业单不存在或已被其他页面删除', { orderId: id });
      }
      if (order.revision !== baseRevision) {
        throw new ConcurrencyError('stale-work-order', '该作业单已被其他标签页修改，请刷新后再完成', {
          orderId: order.id,
          orderCode: order.code,
          baseRevision,
          latestRevision: order.revision,
        });
      }
      if (order.state !== 'working') {
        throw new ConcurrencyError('not-found', `当前状态不允许完成：${order.state}`, { orderId: id });
      }
      const related = await db.faults.where('id').anyOf(order.faultIds).toArray();
      const pending = related.filter((item) => item.state === 'pending');
      return { order, faultsBefore: pending };
    },
  );

  const journal: PendingCommitRow = {
    id: commitId,
    kind: 'complete-work-order',
    createdAt: nowIso(),
    workOrderBefore: before.order,
    faultsBefore: before.faultsBefore,
  };
  await db.pendingCommits.put(journal);

  // 阶段二：业务事务——作业单置完成 + 待修病害置已销号（CAS 比对修订号）
  try {
    const result = await db.transaction('rw', [db.workOrders, db.faults], async () => {
      const order = await db.workOrders.get(id);
      if (!order) {
        throw new ConcurrencyError('not-found', '作业单不存在或已被其他页面删除', { orderId: id });
      }
      if (order.revision !== baseRevision) {
        throw new ConcurrencyError('stale-work-order', '该作业单已被其他标签页修改，请刷新后再完成', {
          orderId: order.id,
          orderCode: order.code,
          baseRevision,
          latestRevision: order.revision,
        });
      }
      const related = await db.faults.where('id').anyOf(order.faultIds).toArray();
      const staleFaults = related.filter(
        (item) =>
          item.state === 'pending' &&
          !before.faultsBefore.some((snapshot) => snapshot.id === item.id && snapshot.revision === item.revision),
      );
      if (staleFaults.length > 0) {
        throw new ConcurrencyError('stale-fault', '关联病害已被其他页面改动，请刷新后再完成', {
          orderId: order.id,
          orderCode: order.code,
          faultIds: staleFaults.map((item) => item.id),
        });
      }
      const pending = related.filter((item) => item.state === 'pending');
      for (const fault of pending) {
        await db.faults.put({ ...fault, state: 'solved' as const, solvedAt, revision: nextRevision(fault.revision) });
      }
      const completed: WorkOrderRow = {
        ...order,
        state: 'done',
        updatedAt: solvedAt,
        revision: nextRevision(order.revision),
      };
      await db.workOrders.put(completed);
      return { order: completed, solvedCount: pending.length };
    });

    // 阶段三：业务数据已全部落库，删除预提交日志（提交完成）
    await db.pendingCommits.delete(commitId);
    return result;
  } catch (error) {
    // 业务事务失败时 IndexedDB 已回滚；日志保留，重开恢复。此处直接把失败抛给调用方。
    throw error;
  }
}

/**
 * 普通状态推进（已下达 / 作业中）：按修订号 CAS，单表写入。
 * 不做跨表回写，不需要预提交日志。
 */
export async function advanceWorkOrderState(input: {
  id: string;
  baseRevision: number;
  next: WorkOrderState;
  now?: string;
}): Promise<WorkOrderRow> {
  const { id, baseRevision, next, now = nowDateTime() } = input;
  return db.transaction('rw', [db.workOrders], async () => {
    const existing = await db.workOrders.get(id);
    if (!existing) {
      throw new ConcurrencyError('not-found', '作业单不存在或已被其他页面删除', { orderId: id });
    }
    if (existing.revision !== baseRevision) {
      throw new ConcurrencyError('stale-work-order', '该作业单已被其他标签页修改，请刷新后再推进', {
        orderId: existing.id,
        orderCode: existing.code,
        baseRevision,
        latestRevision: existing.revision,
      });
    }
    const updated: WorkOrderRow = {
      ...existing,
      state: next,
      updatedAt: now,
      revision: nextRevision(existing.revision),
    };
    await db.workOrders.put(updated);
    return updated;
  });
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
      await db.workOrders.bulkPut(snapshot.workOrders ?? []);
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
  const [yards, switches, inspections, faults, workOrders, restrictions, pendingCommits] = await Promise.all([
    db.yards.count(),
    db.switches.count(),
    db.inspections.count(),
    db.faults.count(),
    db.workOrders.count(),
    db.restrictions.count(),
    db.pendingCommits.count(),
  ]);
  return { yards, switches, inspections, faults, workOrders, restrictions, pendingCommits };
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
