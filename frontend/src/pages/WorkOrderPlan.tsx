/**
 * /workorders 天窗作业单编排
 * 勾选病害成单、分配时间窗 / 人员 / 机具并做冲突校验；
 * 多标签并发：
 * - 保存按修订号提交，过期会与其它页面的最新版本做三方合并，冲突字段两边都留着待人工选定；
 * - 病害已被别的作业单占用时提交会被拦住；
 * - 本次保存引起的时间窗 / 人员 / 机具变化会把受影响的未下达作业单退回草稿并列出冲突来源。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  Grid,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  clearFaultSelection,
  deleteWorkOrder,
  saveWorkOrder,
  selectPlanableFaults,
  selectWindowStats,
  selectWorkOrderViews,
  setFaultSelection,
  type ConcurrencyReject,
} from '../stores/workOrderStore';
import {
  KICKBACK_REASON_LABEL,
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderView,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL, type FaultSeverity } from '../types/fault';
import { ROUTES } from '../router/routes';
import { endTimeOf, findMachineConflicts, findMemberConflicts, formatDuration, nowDateTime, windowMinutes } from '../utils/window';
import { share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import {
  allConflictsResolved,
  applyConflictChoice,
  mergeWorkOrderDraft,
  type DraftFieldConflict,
} from '../utils/orchestration';
import { getWorkOrder } from '../utils/db';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import SeverityTag from '../components/common/SeverityTag';

interface OrderFormState extends WorkOrderDraft {}

interface DialogState {
  open: boolean;
  editingId: string | null;
  form: OrderFormState;
  /** 打开编辑时的版本（三方合并基准） */
  base: OrderFormState | null;
  /** 页面依据的修订号，随远端合并更新 */
  expectedRevision: number | null;
  /** 待人工选定的字段冲突 */
  conflicts: DraftFieldConflict[];
}

function defaultForm(): OrderFormState {
  const start = `${nowDateTime().slice(0, 10)} 09:00`;
  return {
    code: buildWorkOrderCode(new Date(), Math.floor(Math.random() * 90) + 10),
    windowStart: start,
    windowEnd: endTimeOf(start, 120),
    leader: MEMBER_LIBRARY[0],
    machines: ['道尺', '捣固镐'],
    members: [MEMBER_LIBRARY[0], MEMBER_LIBRARY[1]],
    faultIds: [],
    remark: '',
  };
}

function draftFromOrder(order: Pick<WorkOrderView, keyof WorkOrderDraft>): OrderFormState {
  return {
    code: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    leader: order.leader,
    machines: [...order.machines],
    members: [...order.members],
    faultIds: [...order.faultIds],
    remark: order.remark,
  };
}

const closedDialog: DialogState = {
  open: false,
  editingId: null,
  form: defaultForm(),
  base: null,
  expectedRevision: null,
  conflicts: [],
};

export default function WorkOrderPlan() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const planable = useAppSelector(selectPlanableFaults);
  const stats = useAppSelector(selectWindowStats);
  const allOrderRows = useAppSelector((state) => state.workOrder.workOrders);

  const [toast, setToast] = useState('');
  const [selectedFaults, setSelectedFaults] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState>(closedDialog);
  /** 正在保存，避免重复提交 */
  const submittingRef = useRef(false);

  /** 当前表单的冲突预检结果 */
  const draftConflicts = useMemo(() => {
    const others = allOrderRows
      .filter((item) => item.id !== dialog.editingId && item.state !== 'done')
      .map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        members: item.members,
        machines: item.machines,
      }));
    const target = {
      id: dialog.editingId ?? 'draft',
      windowStart: dialog.form.windowStart,
      windowEnd: dialog.form.windowEnd,
      members: dialog.form.members,
      machines: dialog.form.machines,
    };
    const timeConflicts = others.filter(
      (item) => item.windowStart < target.windowEnd && target.windowStart < item.windowEnd,
    );
    const memberConflicts = findMemberConflicts(
      { id: target.id, windowStart: target.windowStart, windowEnd: target.windowEnd, members: target.members },
      others,
    );
    const machineConflicts = findMachineConflicts(
      { id: target.id, windowStart: target.windowStart, windowEnd: target.windowEnd, machines: target.machines },
      others,
    );
    return {
      time: timeConflicts.map((item) => item.code),
      members: memberConflicts,
      machines: machineConflicts,
      duration: windowMinutes({ windowStart: target.windowStart, windowEnd: target.windowEnd }),
    };
  }, [allOrderRows, dialog]);

  /**
   * 编辑对话框开着时，其它标签页提交了同一张作业单（修订号前进）：
   * 读取最新版本做三方合并 —— 未冲突的备注 / 新增人员机具自动并入，冲突字段两边保留待选定。
   */
  useEffect(() => {
    if (!dialog.open || !dialog.editingId) return;
    const latest = orders.find((item) => item.id === dialog.editingId);
    if (!latest || dialog.expectedRevision === null || latest.revision <= dialog.expectedRevision) return;
    const remote = draftFromOrder(latest);
    const base = dialog.base ?? remote;
    const { merged, conflicts } = mergeWorkOrderDraft(base, dialog.form, remote);
    setDialog((prev) => ({
      ...prev,
      form: merged,
      // 以最新一轮的字段冲突为准（新修订号可能消解旧冲突或产生新冲突）
      conflicts,
      base: remote,
      expectedRevision: latest.revision,
    }));
    setToast(
      conflicts.length > 0
        ? `其它页面保存了新版本（修订号 ${latest.revision}）：无冲突内容已自动合并，${conflicts.length} 个字段需人工选定`
        : `已读取到其它页面保存的最新版本（修订号 ${latest.revision}），无冲突内容已自动合并`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, dialog.open, dialog.editingId, dialog.expectedRevision]);

  const openCreate = (): void => {
    const next = defaultForm();
    next.faultIds = selectedFaults;
    setDialog({ open: true, editingId: null, form: next, base: null, expectedRevision: null, conflicts: [] });
  };

  const openEdit = (order: WorkOrderView): void => {
    const form = draftFromOrder(order);
    setDialog({
      open: true,
      editingId: order.id,
      form,
      base: form,
      expectedRevision: order.revision,
      conflicts: [],
    });
  };

  const patchForm = (patch: Partial<OrderFormState>): void => {
    setDialog((prev) => ({ ...prev, form: { ...prev.form, ...patch } }));
  };

  const chooseConflict = (index: number, choice: 'local' | 'remote'): void => {
    setDialog((prev) => {
      const conflicts = prev.conflicts.map((item, i) => (i === index ? { ...item, choice } : item));
      return { ...prev, conflicts, form: applyConflictChoice(prev.form, conflicts) };
    });
  };

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return;
    if (!dialog.form.leader.trim()) {
      setToast('请选择负责人');
      return;
    }
    if (dialog.form.faultIds.length === 0) {
      setToast('请至少关联一处病害');
      return;
    }
    if (windowMinutes({ windowStart: dialog.form.windowStart, windowEnd: dialog.form.windowEnd }) <= 0) {
      setToast('天窗止必须晚于天窗起');
      return;
    }
    if (dialog.conflicts.length > 0 && !allConflictsResolved(dialog.conflicts)) {
      setToast('还有冲突字段未选定，请先在下方逐条选择保留哪一边的内容');
      return;
    }
    submittingRef.current = true;
    try {
      const result = await dispatch(
        saveWorkOrder({
          draft: dialog.form,
          id: dialog.editingId,
          expectedRevision: dialog.expectedRevision,
        }),
      ).unwrap();

      const kicked = result.kickedBack;
      const selfConflict = result.order.draftKickback;
      const messages: string[] = [];
      messages.push(dialog.editingId ? '作业单已按修订号提交更新' : '作业单已创建');
      if (selfConflict) {
        messages.push(`本单仍与 ${selfConflict.sources.map((s) => s.target).join('、')} 存在冲突，保留在待编排草稿`);
      }
      if (kicked.length > 0) {
        messages.push(`受本次变化影响，${kicked.map((item) => item.code).join('、')} 已退回草稿`);
      }
      setToast(messages.join('；'));
      dispatch(clearFaultSelection());
      setDialog(closedDialog);
    } catch (error) {
      const reject = error as ConcurrencyReject;
      if (reject?.name === 'RevisionConflictError' && dialog.editingId) {
        // 提交期间又被别的页面抢先保存：拉最新版做一次三方合并，冲突字段等人工选定
        const latest = await getWorkOrder(dialog.editingId);
        if (latest) {
          const remote = draftFromOrder(latest);
          const { merged, conflicts } = mergeWorkOrderDraft(dialog.base ?? remote, dialog.form, remote);
          setDialog((prev) => ({
            ...prev,
            form: merged,
            conflicts,
            base: remote,
            expectedRevision: latest.revision,
          }));
          setToast(
            conflicts.length > 0
              ? `提交被拦住：其它页面已改过（修订号 ${latest.revision}），请在下方为冲突字段二选一后重新保存`
              : `提交被拦住：其它页面的修改已自动合并，请确认后重新保存`,
          );
          return;
        }
      }
      setToast(`保存被拦住：${reject?.message ?? '未知错误'}`);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            天窗作业单编排
          </Typography>
          <Typography variant="body2" color="text.secondary">
            勾选待修病害成单，分配天窗时间窗、负责人、作业人员与机具；多标签同时编排时按修订号提交，冲突自动退回草稿。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => navigate(ROUTES.progress)}>
            去进度与销号回写
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            新建作业单
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="作业单总数" value={stats.total} suffix="张" color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="天窗占用率"
            value={stats.occupationRate}
            suffix="%"
            percent={stats.occupationRate}
            color="#00897b"
            hint={`累计占用 ${formatDuration(stats.minutes)}（按每日 180 分钟基准）`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="退回草稿 / 冲突"
            value={stats.kickedBackCount}
            suffix="张"
            color={stats.kickedBackCount > 0 ? '#d32f2f' : '#2e7d32'}
            hint="受其它作业单时间窗 / 人员 / 机具变化影响"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="待编排病害"
            value={planable.length}
            suffix="处"
            color="#ed6c02"
            hint={`已完成 ${stats.doneCount} 张作业单`}
          />
        </Grid>
      </Grid>

      <Grid container spacing={1.75}>
        <Grid item xs={12} lg={7}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
              <Typography variant="subtitle1" fontWeight={600}>
                待编排病害（未销号且未编排）
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setSelectedFaults(planable.map((item) => item.id))}>
                  全选
                </Button>
                <Button size="small" onClick={() => setSelectedFaults([])}>
                  清空
                </Button>
                <Button size="small" variant="contained" disabled={selectedFaults.length === 0} onClick={openCreate}>
                  用选中病害建单（{selectedFaults.length}）
                </Button>
              </Stack>
            </Stack>

            {planable.length === 0 ? (
              <EmptyPanel
                title="没有待编排病害"
                description="所有待修病害都已编排进作业单，或已在病害页销号。"
                extra={
                  <Button variant="contained" onClick={() => navigate(ROUTES.faults)}>
                    去病害评定
                  </Button>
                }
              />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Checkbox
                          indeterminate={selectedFaults.length > 0 && selectedFaults.length < planable.length}
                          checked={planable.length > 0 && selectedFaults.length === planable.length}
                          onChange={() =>
                            setSelectedFaults(
                              selectedFaults.length === planable.length ? [] : planable.map((item) => item.id),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>病害</TableCell>
                      <TableCell>等级</TableCell>
                      <TableCell align="right">操作</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {planable.map((item) => (
                      <TableRow key={item.id} hover selected={selectedFaults.includes(item.id)}>
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={selectedFaults.includes(item.id)}
                            onChange={() =>
                              setSelectedFaults((prev) =>
                                prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id],
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>{item.label}</TableCell>
                        <TableCell>
                          <SeverityTag severity={item.severity as FaultSeverity} />
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            size="small"
                            onClick={() => {
                              setSelectedFaults([item.id]);
                              const next = defaultForm();
                              next.faultIds = [item.id];
                              setDialog({ open: true, editingId: null, form: next, base: null, expectedRevision: null, conflicts: [] });
                            }}
                          >
                            单独建单
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600} mb={1}>
              已编排作业单（{orders.length}）
            </Typography>
            {orders.length === 0 ? (
              <EmptyPanel title="暂无作业单" description="勾选左侧病害后建单，系统会做冲突校验。" />
            ) : (
              <Stack spacing={1.25}>
                {orders.map((order) => (
                  <Paper
                    key={order.id}
                    variant="outlined"
                    sx={{
                      p: 1.25,
                      borderColor: order.draftKickback ? 'error.light' : undefined,
                      borderWidth: order.draftKickback ? 2 : undefined,
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip size="small" label={WORK_ORDER_STATE_LABEL[order.state]} color={order.state === 'done' ? 'success' : 'default'} />
                        {order.draftKickback ? (
                          <Tooltip
                            title={order.kickbackSources
                              .map((source) => `${KICKBACK_REASON_LABEL[source.reason]} ← ${source.target}（${source.detail}）`)
                              .join('；')}
                          >
                            <Chip size="small" color="error" icon={<WarningAmberIcon />} label="已退回草稿" />
                          </Tooltip>
                        ) : order.conflict ? (
                          <Tooltip title={`与 ${order.conflictCodes.join('、')} 时间窗重叠`}>
                            <Chip size="small" color="warning" icon={<WarningAmberIcon />} label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        {order.memberConflict && !order.draftKickback ? <Chip size="small" color="warning" label="人员占用冲突" /> : null}
                        {order.machineConflict && !order.draftKickback ? <Chip size="small" color="warning" label="机具占用冲突" /> : null}
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => openEdit(order)}>
                          编辑
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          onClick={async () => {
                            await dispatch(deleteWorkOrder(order.id));
                            setToast('作业单已删除');
                          }}
                        >
                          删除
                        </Button>
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                      天窗 {order.windowStart} ~ {order.windowEnd.slice(-5)}（{formatDuration(order.durationMinutes)}）· 负责人{' '}
                      {order.leader} · 修订号 {order.revision}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      关联病害 {order.faultIds.length} 处（待销号 {order.pendingFaultCount}）· 涉及站场{' '}
                      {order.yardNames.join('、') || '—'}
                    </Typography>
                    {order.remark ? (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ whiteSpace: 'pre-line' }}>
                        备注：{order.remark}
                      </Typography>
                    ) : null}
                    {order.draftKickback ? (
                      <Alert severity="error" sx={{ mt: 0.75, py: 0.5 }} icon={<WarningAmberIcon fontSize="small" />}>
                        <Typography variant="caption" display="block">
                          退回时间 {order.draftKickback.at}，冲突来源：
                        </Typography>
                        {order.kickbackSources.map((source, index) => (
                          <Typography key={`${source.reason}-${source.target}-${index}`} variant="caption" display="block">
                            · {KICKBACK_REASON_LABEL[source.reason]}：{source.target}（{source.detail}）
                          </Typography>
                        ))}
                      </Alert>
                    ) : null}
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.75}>
                      {order.members.map((member) => (
                        <Chip key={member} size="small" variant="outlined" label={`人 ${member}`} />
                      ))}
                      {order.machines.map((machine) => (
                        <Chip key={machine} size="small" variant="outlined" color="info" label={`机具 ${machine}`} />
                      ))}
                    </Stack>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.75}>
                      {order.faultLabels.slice(0, 4).map((label) => (
                        <Chip key={label} size="small" label={label} sx={{ borderColor: SEVERITY_HEX.light }} />
                      ))}
                      {order.faultLabels.length > 4 ? <Chip size="small" label={`+${order.faultLabels.length - 4}`} /> : null}
                    </Stack>
                    {WORK_ORDER_STATE_FLOW[order.state].length > 0 ? (
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        下一步可推进为：{WORK_ORDER_STATE_FLOW[order.state].map((item) => WORK_ORDER_STATE_LABEL[item]).join('、')}
                      </Typography>
                    ) : null}
                  </Paper>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* 作业单表单 */}
      <Dialog
        open={dialog.open}
        onClose={() => setDialog(closedDialog)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {dialog.editingId ? '编辑天窗作业单' : '新建天窗作业单'}
          {dialog.editingId ? `（按修订号 ${dialog.expectedRevision ?? '-'} 提交）` : ''}
        </DialogTitle>
        <DialogContent dividers>
          {dialog.conflicts.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="subtitle2">
                其它页面已保存更新，以下 {dialog.conflicts.length} 个字段两边内容不同，请逐字段选定后再保存：
              </Typography>
              <Stack spacing={1} mt={1}>
                {dialog.conflicts.map((conflict, index) => (
                  <Paper key={conflict.field} variant="outlined" sx={{ p: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Chip size="small" label={conflict.label} />
                      <Button
                        size="small"
                        variant={conflict.choice === 'local' ? 'contained' : 'outlined'}
                        onClick={() => chooseConflict(index, 'local')}
                      >
                        用本页：{conflict.local || '（空）'}
                      </Button>
                      <Button
                        size="small"
                        color="success"
                        variant={conflict.choice === 'remote' ? 'contained' : 'outlined'}
                        onClick={() => chooseConflict(index, 'remote')}
                      >
                        用其它页最新：{conflict.remote || '（空）'}
                      </Button>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Alert>
          ) : null}

          <Grid container spacing={2} mt={0.5}>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                label="作业单编号"
                value={dialog.form.code}
                onChange={(event) => patchForm({ code: event.target.value })}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="天窗起"
                InputLabelProps={{ shrink: true }}
                value={dialog.form.windowStart.replace(' ', 'T')}
                onChange={(event) => {
                  const start = event.target.value.replace('T', ' ');
                  patchForm({
                    windowStart: start,
                    windowEnd: endTimeOf(start, draftConflicts.duration || 120),
                  });
                }}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="天窗止"
                InputLabelProps={{ shrink: true }}
                value={dialog.form.windowEnd.replace(' ', 'T')}
                onChange={(event) => patchForm({ windowEnd: event.target.value.replace('T', ' ') })}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>负责人</InputLabel>
                <Select
                  label="负责人"
                  value={dialog.form.leader}
                  onChange={(event) => patchForm({ leader: event.target.value })}
                >
                  {[...new Set([...MEMBER_LIBRARY, ...dialog.form.members])].map((name) => (
                    <MenuItem key={name} value={name}>
                      {name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>作业人员</InputLabel>
                <Select
                  multiple
                  label="作业人员"
                  value={dialog.form.members}
                  input={<OutlinedInput label="作业人员" />}
                  onChange={(event) =>
                    patchForm({
                      members: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                    })
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MEMBER_LIBRARY.map((name) => (
                    <MenuItem key={name} value={name}>
                      <Checkbox checked={dialog.form.members.includes(name)} />
                      <ListItemText primary={name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>机具清单</InputLabel>
                <Select
                  multiple
                  label="机具清单"
                  value={dialog.form.machines}
                  input={<OutlinedInput label="机具清单" />}
                  onChange={(event) =>
                    patchForm({
                      machines: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                    })
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MACHINE_LIBRARY.map((name) => (
                    <MenuItem key={name} value={name}>
                      <Checkbox checked={dialog.form.machines.includes(name)} />
                      <ListItemText primary={name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <FormControl fullWidth size="small">
                <InputLabel>关联病害</InputLabel>
                <Select
                  multiple
                  label="关联病害"
                  value={dialog.form.faultIds}
                  input={<OutlinedInput label="关联病害" />}
                  onChange={(event) =>
                    patchForm({
                      faultIds: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                    })
                  }
                  renderValue={(selected) => `已选 ${(selected as string[]).length} 处病害`}
                >
                  {[
                    ...planable,
                    ...dialog.form.faultIds
                      .filter((id) => !planable.some((item) => item.id === id))
                      .map((id) => ({ id, label: `本单已关联 ${id}`, severity: 'medium' as FaultSeverity, state: 'pending' })),
                  ].map((item) => (
                    <MenuItem key={item.id} value={item.id}>
                      <Checkbox checked={dialog.form.faultIds.includes(item.id)} />
                      <ListItemText primary={item.label} secondary={`等级 ${FAULT_SEVERITY_LABEL[item.severity as FaultSeverity]}`} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                label="备注（多标签各自新增的备注行会自动合并）"
                value={dialog.form.remark}
                onChange={(event) => patchForm({ remark: event.target.value })}
              />
            </Grid>

            <Grid item xs={12}>
              <Alert
                severity={
                  draftConflicts.time.length > 0 || draftConflicts.members.length > 0 || draftConflicts.machines.length > 0
                    ? 'warning'
                    : 'success'
                }
              >
                冲突预检：时间窗重叠 {draftConflicts.time.length > 0 ? draftConflicts.time.join('、') : '无'} · 人员占用{' '}
                {draftConflicts.members.length > 0 ? draftConflicts.members.join('、') : '无'} · 机具占用{' '}
                {draftConflicts.machines.length > 0 ? draftConflicts.machines.join('、') : '无'} · 天窗时长{' '}
                {formatDuration(draftConflicts.duration)}
              </Alert>
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" color="text.secondary">
                保存后：若与其它待编排在同一时间窗存在人员 / 机具 / 时间重叠，相关作业单会自动退回草稿并列出冲突来源；
                已被别的作业单占用的病害无法重复关联；带未处理退回冲突的作业单不能下达。
              </Typography>
            </Grid>

            <Grid item xs={12}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => patchForm({ windowEnd: endTimeOf(dialog.form.windowStart, 120) })}
                >
                  按 120 分钟设置天窗止
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => patchForm({ windowEnd: endTimeOf(dialog.form.windowStart, 180) })}
                >
                  按 180 分钟设置天窗止
                </Button>
                <Button size="small" onClick={() => dispatch(setFaultSelection(selectedFaults))}>
                  同步左侧勾选（{selectedFaults.length}）
                </Button>
                <Button size="small" onClick={() => setSelectedFaults([])}>
                  重置勾选状态
                </Button>
              </Stack>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(closedDialog)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => void submit()}
            disabled={dialog.conflicts.length > 0 && !allConflictsResolved(dialog.conflicts)}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      <Typography variant="caption" color="text.secondary" display="block" mt={2}>
        当前时间基准 {nowDateTime()} · 天窗占用率按每日 180 分钟基准计算，占比 {share(stats.minutes, 180)}%。
      </Typography>
    </Box>
  );
}
