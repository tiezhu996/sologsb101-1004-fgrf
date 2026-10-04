/**
 * 原子提交（write-ahead 思路）
 *
 * 作业单完成时「作业单状态 + 涉及病害销号」必须在同一次提交里落库：
 * 1. 先在独立事务写一条 pendingCommits 日志，内含提交前的完整快照（before 镜像）；
 * 2. 再在一个读写事务里同时改作业单与全部病害 —— IndexedDB 事务本身原子，
 *    要么全部可见，要么全部回滚，不会留下半成品；
 * 3. 全部成功后删除日志。
 *
 * 若第 2 步写入失败、浏览器崩溃或异常断电导致日志残留，下次打开数据库时
 * recoverPendingCommits() 依据 before 镜像把涉及行恢复到提交前的完整状态。
 */
import { db, type PendingCommitRow, type TableName } from './db';
import { uuid } from './format';

export interface BeforeImage {
  table: TableName;
  id: string;
  /** 提交前整行；null 表示该行在提交前不存在（本事务不涉及新建，保留以扩展） */
  row: Record<string, unknown> | null;
}

export interface CommitSpec {
  /** 提交类别，便于审计与恢复日志 */
  kind: string;
  /** 提交前镜像：作业单 + 涉及病害的完整旧行 */
  before: BeforeImage[];
  /** 真正的写入动作，在一个事务内执行 */
  mutate: () => Promise<void>;
}

/** 写 WAL 日志 */
async function writePendingCommit(spec: CommitSpec): Promise<string> {
  const commitId = `pc-${uuid()}`;
  const row: PendingCommitRow = {
    id: commitId,
    kind: spec.kind,
    before: spec.before,
    createdAt: new Date().toISOString(),
  };
  await db.pendingCommits.put(row);
  return commitId;
}

/**
 * 执行一次原子提交。
 * mutate 抛错时：IndexedDB 自动回滚第 2 步事务，本函数再按 before 镜像兜底恢复，
 * 最后清掉日志，保证「有一次写入失败后，重开恢复到提交前的完整状态」。
 */
export async function atomicCommit(spec: CommitSpec): Promise<void> {
  const commitId = await writePendingCommit(spec);
  try {
    await spec.mutate();
  } catch (error) {
    // 事务大概率已自动回滚；显式按镜像再恢复一次，覆盖任何部分写入。
    await restoreBeforeImages(spec.before);
    await db.pendingCommits.delete(commitId);
    throw error;
  }
  await db.pendingCommits.delete(commitId);
}

/** 按 before 镜像恢复：旧行写回，提交前不存在的行删除 */
async function restoreBeforeImages(images: BeforeImage[]): Promise<void> {
  const grouped = new Map<TableName, BeforeImage[]>();
  for (const image of images) {
    const list = grouped.get(image.table) ?? [];
    list.push(image);
    grouped.set(image.table, list);
  }
  for (const [table, list] of grouped) {
    await db.table(table).bulkPut(list.filter((item) => item.row !== null).map((item) => item.row as object));
    const missingIds = list.filter((item) => item.row === null).map((item) => item.id);
    if (missingIds.length > 0) await db.table(table).bulkDelete(missingIds);
  }
}

/**
 * 启动期 / 导入后恢复：把所有残留的未完成提交按 before 镜像回滚。
 * 返回恢复的提交数。
 */
export async function recoverPendingCommits(): Promise<number> {
  const pending = await db.pendingCommits.toArray();
  for (const commit of pending) {
    try {
      await restoreBeforeImages(commit.before as BeforeImage[]);
    } catch {
      // 单行恢复失败不阻断其它提交；日志保留，下次再试。
      continue;
    }
    await db.pendingCommits.delete(commit.id);
  }
  return pending.length;
}
