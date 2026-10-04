/**
 * 多标签并发 / 原子提交逻辑验证（Node + fake-indexeddb）。
 * 运行：npx tsx scripts/verify-concurrency.mts
 * 覆盖：
 *  1. 病害已被别的作业单占用 → 当前提交被硬拦住
 *  2. 时间窗 / 人员 / 机具冲突 → 本单与受影响未下达单退回草稿，冲突来源落库
 *  3. 冲突解除重新保存 → 草稿自动回到待编排
 *  4. 编辑保存按修订号 CAS → 过期基版号被拦住
 *  5. 完成作业单 → 作业单状态 + 病害销号同一次提交
 *  6. 完成后手工撤销销号 CAS 拦截
 *  7. 模拟"应用阶段后、删日志前崩溃"→ 重开恢复到提交前完整状态
 *  8. mergeWorkOrderDraft 三方合并：自动合并 + 两边都改保留待选定
 */
import 'fake-indexeddb/auto';

const {
  initDatabase,
  db,
  saveWorkOrder,
  completeWorkOrder,
  advanceWorkOrderState,
  setFaultStateCAS,
  recoverPendingCommits,
  listWorkOrders,
  listFaults,
} = await import('../src/utils/db.ts');
const { ConcurrencyError, mergeWorkOrderDraft } = await import('../src/utils/concurrency.ts');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function resetDb(): Promise<void> {
  try {
    await db.close();
  } catch {
    // ignore
  }
  // fake-indexeddb：删库后重建
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbrailswitch');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('delete blocked'));
  });
  await initDatabase();
}

async function findFaultsForOrder(code: string) {
  const orders = await listWorkOrders();
  const order = orders.find((o) => o.code === code);
  if (!order) throw new Error(`order ${code} not found`);
  const faults = await listFaults();
  return { order, faults: faults.filter((f) => order.faultIds.includes(f.id)) };
}

async function main(): Promise<void> {
  // ---------- 场景 1：病害占用硬拦截 ----------
  console.log('\n[1] 病害已被别的作业单占用 → 当前提交被拦住');
  await resetDb();
  const seeded = await listWorkOrders();
  const occupiedIds = new Set(seeded.flatMap((o) => o.faultIds));
  const freeFault = (await listFaults()).find((f) => f.state === 'pending' && !occupiedIds.has(f.id));
  check('存在可用于测试的未编排待修病害', Boolean(freeFault), freeFault?.id);

  // 先用 freeFault 建一张不冲突的作业单 A
  const a = await saveWorkOrder({
    draft: {
      code: 'TW-TEST-A',
      faultIds: [freeFault!.id],
      windowStart: '2099-01-01 09:00',
      windowEnd: '2099-01-01 11:00',
      leader: '赵铁军',
      machines: ['道尺'],
      members: ['赵铁军'],
      remark: '',
    },
  });
  check('作业单 A 新建后为待编排（无冲突）', a.order.state === 'planned');

  // 另一张作业单 B 再用同一处病害 → 必须被拦住
  let blocked: unknown = null;
  try {
    await saveWorkOrder({
      draft: {
        code: 'TW-TEST-B',
        faultIds: [freeFault!.id],
        windowStart: '2099-02-01 09:00',
        windowEnd: '2099-02-01 11:00',
        leader: '孙立波',
        machines: ['捣固镐'],
        members: ['孙立波'],
        remark: '',
      },
    });
  } catch (error) {
    blocked = error;
  }
  check('重复占用病害的提交被拦住', blocked instanceof ConcurrencyError);
  check(
    '拦截原因为 fault-occupied 且带出来源作业单',
    (blocked as ConcurrencyError)?.reason === 'fault-occupied' &&
      ((blocked as ConcurrencyError).details.occupied as Array<{ orderCode: string }>)?.[0]?.orderCode === 'TW-TEST-A',
  );
  const afterBlock = await listWorkOrders();
  check('被拦住后没有产生半成品作业单', !afterBlock.some((o) => o.code === 'TW-TEST-B'));

  // ---------- 场景 2：冲突 → 退回草稿 + 冲突来源 ----------
  console.log('\n[2] 时间窗/人员/机具冲突 → 退回草稿并列出冲突来源');
  await resetDb();
  // 新建两张互不冲突、各占用不同病害的作业单
  const allFaults = await listFaults();
  const occupiedIds0 = new Set((await listWorkOrders()).flatMap((o) => o.faultIds));
  const freeFaults = allFaults.filter((f) => f.state === 'pending' && !occupiedIds0.has(f.id));
  check('至少有两处空闲待修病害用于建单', freeFaults.length >= 2, `got ${freeFaults.length}`);
  const victimCreate = await saveWorkOrder({
    draft: {
      code: 'TW-VICTIM',
      faultIds: [freeFaults[0].id],
      windowStart: '2099-06-01 09:00',
      windowEnd: '2099-06-01 11:00',
      leader: '韩学斌',
      machines: ['发电机'],
      members: ['韩学斌'],
      remark: '',
    },
  });
  const targetCreate = await saveWorkOrder({
    draft: {
      code: 'TW-TARGET',
      faultIds: [freeFaults[1].id],
      windowStart: '2099-07-01 09:00',
      windowEnd: '2099-07-01 11:00',
      leader: '冯国栋',
      machines: ['照明灯组'],
      members: ['冯国栋'],
      remark: '',
    },
  });
  const victim = victimCreate.order;
  const target = targetCreate.order;

  // 把 target 改成与 victim 同时窗、同负责人/人员/机具冲突
  const res = await saveWorkOrder({
    id: target.id,
    baseRevision: target.revision,
    draft: {
      code: target.code,
      faultIds: target.faultIds,
      windowStart: victim.windowStart,
      windowEnd: victim.windowEnd,
      leader: victim.leader,
      machines: victim.machines,
      members: victim.members,
      remark: target.remark,
    },
  });
  check('产生冲突的保存：本单落为草稿', res.order.state === 'draft');
  check('本单记录了结构化冲突来源（时间窗+人员+机具）', res.selfConflictRefs.some((r) => r.orderId === victim.id));
  const kinds = new Set(res.selfConflictRefs.filter((r) => r.orderId === victim.id).map((r) => r.kind));
  check('冲突来源覆盖 window/member/machine 三类', kinds.has('window') && kinds.has('member') && kinds.has('machine'));
  const cascaded = res.cascaded.find((c) => c.id === victim.id);
  check('受影响的未下达作业单被退回草稿', Boolean(cascaded));
  check('被级联单记录了对向冲突来源', Boolean(cascaded?.conflictRefs.some((r) => r.orderId === target.id)));
  let orders = await listWorkOrders();
  const victimRow = orders.find((o) => o.id === victim.id)!;
  check('被级联单落库状态为 draft', victimRow.state === 'draft');
  check('被级联单 conflictRefs 已落库', victimRow.conflictRefs.length > 0);

  // ---------- 场景 3：冲突解除 → 草稿自动恢复 planned ----------
  console.log('\n[3] 冲突解除重新保存 → 草稿自动回到待编排');
  const fixed = await saveWorkOrder({
    id: target.id,
    baseRevision: res.order.revision,
    draft: {
      code: target.code,
      faultIds: target.faultIds,
      windowStart: '2099-03-03 08:00',
      windowEnd: '2099-03-03 09:30',
      leader: '吴长胜',
      machines: ['发电机'],
      members: ['吴长胜'],
      remark: '已改期',
    },
  });
  check('改期后本单恢复 planned', fixed.order.state === 'planned');
  const victimFixed = fixed.cascaded.find((c) => c.id === victim.id);
  check('原受害单冲突解除并被级联恢复', Boolean(victimFixed));
  orders = await listWorkOrders();
  check('原受害单落库恢复 planned', orders.find((o) => o.id === victim.id)?.state === 'planned');

  // ---------- 场景 4：修订号 CAS ----------
  console.log('\n[4] 编辑保存按修订号提交 → 过期基版号被拦住');
  await resetDb();
  orders = await listWorkOrders();
  const wo = orders.find((o) => o.state === 'planned')!;
  // 模拟另一个标签先保存一次（修订号前进）
  const first = await saveWorkOrder({
    id: wo.id,
    baseRevision: wo.revision,
    draft: {
      code: wo.code,
      faultIds: wo.faultIds,
      windowStart: '2099-04-04 08:00',
      windowEnd: '2099-04-04 10:00',
      leader: wo.leader,
      machines: wo.machines,
      members: wo.members,
      remark: '标签甲的修改',
    },
  });
  let stale: unknown = null;
  try {
    await saveWorkOrder({
      id: wo.id,
      baseRevision: wo.revision, // 旧修订号
      draft: {
        code: wo.code,
        faultIds: wo.faultIds,
        windowStart: '2099-05-05 08:00',
        windowEnd: '2099-05-05 10:00',
        leader: wo.leader,
        machines: wo.machines,
        members: wo.members,
        remark: '标签乙拿着旧版本保存',
      },
    });
  } catch (error) {
    stale = error;
  }
  check('旧基版号提交被拦住', stale instanceof ConcurrencyError);
  check('拦截原因为 stale-work-order', (stale as ConcurrencyError)?.reason === 'stale-work-order');
  const rowsNow = await listWorkOrders();
  const woRow = rowsNow.find((o) => o.id === wo.id)!;
  check('被拦住后保留的是标签甲的内容（未覆盖）', woRow.remark === '标签甲的修改' && woRow.revision === first.order.revision);

  // ---------- 场景 5：完成原子提交 ----------
  console.log('\n[5] 完成作业单 → 状态与销号同一次提交');
  await resetDb();
  const { order: issuedOrder, faults: issuedFaults } = await findFaultsForOrder(
    (await listWorkOrders()).find((o) => o.state === 'issued')!.code,
  );
  const pendingCountBefore = issuedFaults.filter((f) => f.state === 'pending').length;
  await advanceWorkOrderState({
    id: issuedOrder.id,
    baseRevision: issuedOrder.revision,
    next: 'working',
  });
  const done = await completeWorkOrder({
    id: issuedOrder.id,
    baseRevision: issuedOrder.revision + 1,
  });
  check('完成返回已销号病害数', done.solvedCount === pendingCountBefore, `got ${done.solvedCount}, want ${pendingCountBefore}`);
  const after = await findFaultsForOrder(issuedOrder.code);
  check('作业单状态为 done', after.order.state === 'done');
  check('全部待修病害已销号', after.faults.every((f) => f.state === 'solved'));
  check('销号时间已写入', after.faults.every((f) => Boolean(f.solvedAt)));
  const journalLeft = await db.pendingCommits.count();
  check('提交成功后预提交日志已清除', journalLeft === 0);

  // ---------- 场景 6：完成后旧标签撤销销号被 CAS 拦住 ----------
  console.log('\n[6] 拿着完成前修订号撤销销号 → 被拦住');
  const someFault = after.faults[0];
  let faultStale: unknown = null;
  try {
    await setFaultStateCAS({
      faultId: someFault.id,
      baseRevision: someFault.revision - 1, // 完成回写已让修订号 +1
      state: 'pending',
      solvedAt: null,
    });
  } catch (error) {
    faultStale = error;
  }
  check('过期病害修订号的销号撤销被拦住', faultStale instanceof ConcurrencyError);
  check('拦截原因为 stale-fault', (faultStale as ConcurrencyError)?.reason === 'stale-fault');
  const stillSolved = (await listFaults()).find((f) => f.id === someFault.id)!;
  check('被拦住后病害仍为已销号', stillSolved.state === 'solved');

  // ---------- 场景 7：完成后、删日志前崩溃 → 重开恢复 ----------
  console.log('\n[7] 崩溃恢复 → 回到提交前完整状态');
  await resetDb();
  const { order: issued2, faults: faults2 } = await findFaultsForOrder(
    (await listWorkOrders()).find((o) => o.state === 'issued')!.code,
  );
  await advanceWorkOrderState({ id: issued2.id, baseRevision: issued2.revision, next: 'working' });
  // completeWorkOrder 的日志是在 working 状态下抓取的：重新读取当前行作为提交前快照
  const workingSnapshot = await findFaultsForOrder(issued2.code);
  const workingOrder = workingSnapshot.order;
  const workingFaults = workingSnapshot.faults;
  const workingRevision = workingOrder.revision;

  // 手工复刻 completeWorkOrder 的前两步（写日志 + 写业务数据），但不删日志、不广播，
  // 模拟浏览器在"业务数据写完、日志还没删"那一刻崩溃
  const { uuid } = await import('../src/utils/format.ts');
  const commitId = `commit-${uuid()}`;
  await db.pendingCommits.put({
    id: commitId,
    kind: 'complete-work-order' as const,
    createdAt: new Date().toISOString(),
    workOrderBefore: workingOrder,
    faultsBefore: workingFaults.filter((f) => f.state === 'pending'),
  });
  await db.transaction('rw', [db.workOrders, db.faults], async () => {
    await db.workOrders.put({ ...workingOrder, state: 'done' as const, revision: workingRevision + 1 });
    for (const f of workingFaults.filter((x) => x.state === 'pending')) {
      await db.faults.put({ ...f, state: 'solved' as const, solvedAt: '2099-01-01 00:00', revision: f.revision + 1 });
    }
  });
  // 此时库里是"半成品"：作业单已完成、病害已销号，但日志还在
  const halfDone = await findFaultsForOrder(issued2.code);
  check('模拟崩溃点：作业单确实已是 done', halfDone.order.state === 'done');

  // 重新打开页面：恢复未完成提交
  const recoverResult = await recoverPendingCommits();
  check('检测到 1 个未完成提交', recoverResult.recovered === 1);
  const restored = await findFaultsForOrder(issued2.code);
  check('恢复后作业单回到崩溃前状态（working）', restored.order.state === 'working');
  check('恢复后作业单修订号回到崩溃前', restored.order.revision === workingRevision);
  const pendingRestored = workingFaults.filter((f) => f.state === 'pending').map((f) => f.id);
  check(
    '恢复后曾被销号的病害全部回到待修',
    restored.faults.filter((f) => pendingRestored.includes(f.id)).every((f) => f.state === 'pending'),
  );
  check(
    '恢复后待修病害销号时间被清空',
    restored.faults.filter((f) => pendingRestored.includes(f.id)).every((f) => f.solvedAt === null),
  );
  check('恢复后日志已删除', (await db.pendingCommits.count()) === 0);

  // 再跑一次 initDatabase 的恢复路径，确认幂等（无日志时不报错、不误改）
  await recoverPendingCommits();
  const idempotent = await findFaultsForOrder(issued2.code);
  check('重复恢复幂等，状态保持 working', idempotent.order.state === 'working');

  // ---------- 场景 8：三方合并 ----------
  console.log('\n[8] 三方合并：自动合并 + 冲突两边保留');
  const base = {
    code: 'TW-1',
    faultIds: ['f1'],
    windowStart: '2099-01-01 09:00',
    windowEnd: '2099-01-01 11:00',
    leader: '赵铁军',
    machines: ['道尺'],
    members: ['赵铁军'],
    remark: '原备注',
  };
  // 本页只改了备注；他页只改了负责人 → 两边都应自动收下
  const localOnly = { ...base, remark: '本页补充备注' };
  const remoteOnly = { ...base, leader: '孙立波' };
  const m1 = mergeWorkOrderDraft(base, localOnly, remoteOnly);
  check('只改不同字段：自动合并负责人', m1.merged.leader === '孙立波');
  check('只改不同字段：自动合并备注', m1.merged.remark === '本页补充备注');
  check('只改不同字段：无冲突待选定', m1.conflicts.length === 0);

  // 两边都改了备注且内容不同 → 冲突保留两边
  const localBoth = { ...base, remark: '本页备注', windowStart: '2099-01-02 09:00' };
  const remoteBoth = { ...base, remark: '他页备注', leader: '周振海' };
  const m2 = mergeWorkOrderDraft(base, localBoth, remoteBoth);
  check('两边都改备注：产生 1 个字段冲突', m2.conflicts.length === 1 && m2.conflicts[0].field === 'remark');
  check('冲突里同时保留本页与他页内容', m2.conflicts[0].local === '本页备注' && m2.conflicts[0].remote === '他页备注');
  check('冲突待人工选定', m2.conflicts[0].resolution === null);
  check('他页独改的负责人仍自动合并', m2.merged.leader === '周振海');
  check('本页独改的天窗起不被覆盖', m2.merged.windowStart === '2099-01-02 09:00');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
