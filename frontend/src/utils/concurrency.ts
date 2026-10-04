/**
 * 修订号乐观锁错误
 * 提交时带上「我打开页面时看到的修订号」，落库前核对当前行：
 * 修订号不一致说明别的标签页已经先改过，本次提交被拒绝，由页面引导合并。
 */
export class RevisionConflictError extends Error {
  /** 冲突实体表名（workOrders / faults） */
  readonly table: string;
  /** 冲突行 id */
  readonly rowId: string;
  /** 页面依据的旧修订号 */
  readonly expected: number;
  /** 库里的最新修订号 */
  readonly actual: number;

  constructor(table: string, rowId: string, expected: number, actual: number) {
    super(`${table}#${rowId} 修订号已过期（页面依据 ${expected}，最新 ${actual}），请先合并其它页面的修改`);
    this.name = 'RevisionConflictError';
    this.table = table;
    this.rowId = rowId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** 病害已被其它作业单占用，当前提交必须拦截 */
export class FaultOccupiedError extends Error {
  /** 被占用的病害 id */
  readonly faultId: string;
  /** 占用该病害的作业单编号 */
  readonly orderCode: string;

  constructor(faultId: string, orderCode: string) {
    super(`该病害已被作业单 ${orderCode} 占用，不能重复编排`);
    this.name = 'FaultOccupiedError';
    this.faultId = faultId;
    this.orderCode = orderCode;
  }
}

/** 作业单仍带着未处理的「退回草稿」冲突，不能下达 */
export class KickbackBlockingError extends Error {
  constructor(message = '作业单存在未处理的退回草稿冲突，处理并重新保存后才能下达') {
    super(message);
    this.name = 'KickbackBlockingError';
  }
}

/** 判断是否修订号冲突错误 */
export function isRevisionConflictError(error: unknown): error is RevisionConflictError {
  return error instanceof RevisionConflictError;
}

/** 判断是否业务规则拦截类错误（修订号 / 占用 / 退回草稿） */
export function isConcurrencyError(
  error: unknown,
): error is RevisionConflictError | FaultOccupiedError | KickbackBlockingError {
  return (
    error instanceof RevisionConflictError ||
    error instanceof FaultOccupiedError ||
    error instanceof KickbackBlockingError
  );
}
