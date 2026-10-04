/**
 * 持久化行元信息。
 * - ROW_REVISION：数据结构层面的行版本号（随结构迁移调整），用于不带并发控制的实体
 * - INITIAL_REVISION：业务修订号初值；参与乐观锁的实体（作业单、病害）每次写入 +1，
 *   提交方必须携带读取时的基版号，落库时做 CAS 比对，防止多标签页互相覆盖
 */
export const ROW_REVISION = 2;

/** 业务修订号初值（参与乐观并发控制的行从 1 开始） */
export const INITIAL_REVISION = 1;

/** 行修订号，用于按行迁移与版本核对 */
export interface Revisioned {
  revision: number;
}
