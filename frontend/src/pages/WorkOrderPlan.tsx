/**
 * /workorders 天窗作业单编排
 * 勾选病害成单、分配时间窗 / 人员 / 机具并做冲突校验；
 *
 * 多标签协作：
 * - 保存按修订号提交：其他标签先改过则提交被拦住，自动重新读取并做三方合并；
 * - 病害已被别的作业单占用 → 提交被硬拦截并列出占用来源；
 * - 时间窗 / 人员 / 机具一有冲突，本单与受影响的未下达作业单退回草稿并列出冲突来源；
 * - 编辑过程中切回页面读到其他标签的新版本：未冲突的字段（含备注）自动合并，
 *   两边都改的字段两边内容都保留，在冲突面板里人工选定后才能再保存。
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
  selectPlanableFaults,
  selectWindowStats,
  selectWorkOrderViews,
  setFaultSelection,
  saveWorkOrderThunk,
} from '../stores/workOrderStore';
import {
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  WORK_ORDER_CONFLICT_KIND_LABEL,
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  buildWorkOrderCode,
  type WorkOrderConflictRef,
  type WorkOrderDraft,
  type WorkOrderView,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL, type FaultSeverity } from '../types/fault';
import { ROUTES } from '../router/routes';
import { endTimeOf, findMachineConflicts, findMemberConflicts, formatDuration, nowDateTime, windowMinutes } from '../utils/window';
import { share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import {
  WORK_ORDER_FIELD_LABEL,
  mergeWorkOrderDraft,
  resolveConflict,
  type FieldConflict,
} from '../utils/concurrency';
import type { OccupiedFault } from '../utils/db';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import SeverityTag from '../components/common/SeverityTag';

interface OrderFormState extends WorkOrderDraft {}

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

interface DialogState {
  open: boolean;
  editingId: string | null;
  form: OrderFormState;
  /** 打开编辑时的基版修订号（提交时做 CAS） */
  baseRevision: number;
  /** 打开编辑时的内容快照（三方合并的 base） */
  baseForm: OrderFormState;
  /** 三方合并后待人工选定的字段冲突 */
  conflicts: FieldConflict[];
  /** 是否已自动接收过其他标签的新版本（用于提示） */
  mergedHint: string;
}

function closedDialog(): DialogState {
  return {
    open: false,
    editingId: null,
    form: defaultForm(),
    baseRevision: 0,
    baseForm: defaultForm(),
    conflicts: [],
    mergedHint: '',
  };
}

function conflictText(refs: WorkOrderConflictRef[]): string {
  const lines: string[] = [];
  const byOrder = new Map<string, WorkOrderConflictRef[]>();
  for (const ref of refs) {
    const list = byOrder.get(ref.orderCode) ?? [];
    list.push(ref);
    byOrder.set(ref.orderCode, list);
  }
  for (const [code, list] of byOrder) {
    const kinds = list.map((ref) => {
      const label = WORK_ORDER_CONFLICT_KIND_LABEL[ref.kind];
      return ref.resource ? `${label}（${ref.resource}）` : label;
    });
    lines.push(`${code}：${[...new Set(kinds)].join('、')}`);
  }
  return lines.join('；');
}

function formatFieldValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '（空）';
  return value.trim() ? value : '（空）';
}

export default function WorkOrderPlan() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const planable = useAppSelector(selectPlanableFaults);
  const stats = useAppSelector(selectWindowStats);
  const allOrderRows = useAppSelector((state) => state.workOrder.workOrders);

  const [toast, setToast] = useState('');
  const [selectedFaults, setSelectedFaults] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState>(closedDialog());
  /** 合并去重保护：同一条远端版本只处理一次 */
  const mergedRevisionsRef = useRef<Set<string>>(new Set());

  /** 当前表单的冲突预检结果 */
  const draftConflicts = useMemo(() => {
    const others = allOrderRows
      .filter((item) => item.id !== dialog.editingId)
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
   * 编辑过程中其他标签页保存了同一作业单（修订号变化）：
   * 以打开时的 base、本页 form、远端最新 row 做三方合并。
   */
  useEffect(() => {
    if (!dialog.open || !dialog.editingId) return;
    const remote = allOrderRows.find((item) => item.id === dialog.editingId);
    if (!remote) return;
    const mergeKey = `${remote.id}@${remote.revision}`;
    if (remote.revision === dialog.baseRevision || mergedRevisionsRef.current.has(mergeKey)) return;

    const remoteForm: OrderFormState = {
      code: remote.code,
      faultIds: remote.faultIds,
      windowStart: remote.windowStart,
      windowEnd: remote.windowEnd,
      leader: remote.leader,
      machines: remote.machines,
      members: remote.members,
      remark: remote.remark,
    };
    const result = mergeWorkOrderDraft(dialog.baseForm, dialog.form, remoteForm);
    mergedRevisionsRef.current.add(mergeKey);
    setDialog((prev) => ({
      ...prev,
      form: result.merged,
      baseRevision: remote.revision,
      baseForm: remoteForm,
      conflicts: result.conflicts,
      mergedHint:
        result.conflicts.length > 0
          ? `其他标签页也修改了该作业单：${result.conflicts
              .map((item) => WORK_ORDER_FIELD_LABEL[item.field])
              .join('、')} 两边内容不同，请在下方人工选定。`
          : '已读取其他标签页保存的最新版本，未冲突的修改（含备注）已自动合并。',
    }));
  }, [dialog, allOrderRows]);

  const openCreate = (): void => {
    const next = defaultForm();
    next.faultIds = selectedFaults;
    mergedRevisionsRef.current = new Set();
    setDialog({ ...closedDialog(), open: true, form: next, baseForm: { ...next } });
  };

  const openEdit = (order: WorkOrderView): void => {
    const form: OrderFormState = {
      code: order.code,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      leader: order.leader,
      machines: order.machines,
      members: order.members,
      faultIds: order.faultIds,
      remark: order.remark,
    };
    mergedRevisionsRef.current = new Set([`${order.id}@${order.revision}`]);
    setDialog({
      open: true,
      editingId: order.id,
      form,
      baseRevision: order.revision,
      baseForm: { ...form },
      conflicts: [],
      mergedHint: '',
    });
  };

  const patchForm = (patch: Partial<OrderFormState>): void => {
    setDialog((prev) => ({ ...prev, form: { ...prev.form, ...patch } }));
  };

  const chooseResolution = (conflict: FieldConflict, resolution: 'local' | 'remote'): void => {
    setDialog((prev) => ({
      ...prev,
      form: resolveConflict(prev.form, conflict, resolution),
      conflicts: prev.conflicts.map((item) =>
        item.field === conflict.field ? { ...item, resolution } : item,
      ),
    }));
  };

  const submit = async (): Promise<void> => {
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
    if (dialog.conflicts.some((item) => item.resolution === null)) {
      setToast('还有字段冲突未选定，请保留本页或采用其他标签页的内容后再保存');
      return;
    }

    try {
      const result = await dispatch(
        saveWorkOrderThunk({
          id: dialog.editingId,
          baseRevision: dialog.editingId ? dialog.baseRevision : undefined,
          draft: dialog.form,
        }),
      ).unwrap();

      const parts: string[] = [];
      parts.push(result.created ? '作业单已创建' : '作业单已更新');
      if (result.selfConflictRefs.length > 0) {
        parts.push(`本单存在冲突已退回草稿：${conflictText(result.selfConflictRefs)}`);
      } else if (result.order.state === 'planned' && dialog.editingId) {
        parts.push('冲突已解除，作业单恢复为待编排');
      }
      if (result.cascaded.length > 0) {
        parts.push(
          `受影响退回草稿 ${result.cascaded.length} 张：${result.cascaded
            .map((item) => `${item.code}（${conflictText(item.conflictRefs)}）`)
            .join('；')}`,
        );
      }
      setToast(parts.join('；'));
    } catch (error) {
      const rejected = error as { message?: string; reason?: string; details?: Record<string, unknown> };
      if (rejected.reason === 'fault-occupied') {
        const occupied = (rejected.details?.occupied ?? []) as OccupiedFault[];
        setToast(
          `提交被拦住：${occupied
            .map((item) => `病害 ${item.faultId} 已在作业单 ${item.orderCode} 中`)
            .join('；')}`,
        );
        return;
      }
      if (rejected.reason === 'stale-work-order') {
        setToast('提交被拦住：该作业单刚被其他标签页保存，已为你重新读取，请核对合并提示后再保存');
        return;
      }
      setToast(`保存失败：${rejected.message ?? '未知错误'}`);
      return;
    }
    dispatch(clearFaultSelection());
    setDialog(closedDialog());
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            天窗作业单编排
          </Typography>
          <Typography variant="body2" color="text.secondary">
            勾选待修病害成单，分配天窗时间窗、负责人、作业人员与机具，并做时间窗 / 人员 / 机具三重冲突校验。
            保存按修订号提交，多标签同时作业不会互相覆盖。
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
            title="草稿（有冲突）"
            value={stats.draftCount}
            suffix="张"
            color={stats.draftCount > 0 ? '#d32f2f' : '#2e7d32'}
            hint="冲突未解除前不能下达"
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
                              mergedRevisionsRef.current = new Set();
                              setDialog({ ...closedDialog(), open: true, form: next, baseForm: { ...next } });
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
                      borderColor: order.state === 'draft' ? '#d32f2f' : undefined,
                      borderWidth: order.state === 'draft' ? 2 : undefined,
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip
                          size="small"
                          label={WORK_ORDER_STATE_LABEL[order.state]}
                          color={
                            order.state === 'done'
                              ? 'success'
                              : order.state === 'draft'
                                ? 'error'
                                : order.state === 'working'
                                  ? 'info'
                                  : 'default'
                          }
                        />
                        {order.conflict ? (
                          <Tooltip title={conflictText(order.liveConflictRefs)}>
                            <Chip size="small" color="error" icon={<WarningAmberIcon />} label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        {order.memberConflict ? <Chip size="small" color="warning" label="人员占用冲突" /> : null}
                        {order.machineConflict ? <Chip size="small" color="warning" label="机具占用冲突" /> : null}
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => openEdit(order)}>
                          {order.state === 'draft' ? '处理冲突' : '编辑'}
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          onClick={async () => {
                            const result = await dispatch(deleteWorkOrder({ id: order.id, revision: order.revision }));
                            if (result.meta.requestStatus === 'fulfilled') {
                              setToast('作业单已删除');
                            } else {
                              setToast('删除失败：该作业单已被其他标签页修改，请刷新后重试');
                            }
                          }}
                        >
                          删除
                        </Button>
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                      天窗 {order.windowStart} ~ {order.windowEnd.slice(-5)}（{formatDuration(order.durationMinutes)}）· 负责人{' '}
                      {order.leader}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      关联病害 {order.faultIds.length} 处（待销号 {order.pendingFaultCount}）· 涉及站场{' '}
                      {order.yardNames.join('、') || '—'} · 修订号 r{order.revision}
                    </Typography>
                    {order.state === 'draft' && order.conflictRefs.length > 0 ? (
                      <Alert severity="error" sx={{ mt: 0.75, py: 0.5 }} icon={<WarningAmberIcon fontSize="small" />}>
                        <Typography variant="caption" fontWeight={600}>
                          退回草稿的冲突来源：{conflictText(order.conflictRefs)}
                        </Typography>
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
                    {order.remark.trim() ? (
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.75}>
                        备注：{order.remark}
                      </Typography>
                    ) : null}
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
      <Dialog open={dialog.open} onClose={() => setDialog(closedDialog())} fullWidth maxWidth="md">
        <DialogTitle>
          {dialog.editingId ? '编辑天窗作业单' : '新建天窗作业单'}
          {dialog.editingId ? (
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              基版修订号 r{dialog.baseRevision}
            </Typography>
          ) : null}
        </DialogTitle>
        <DialogContent dividers>
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
                      .map((id) => ({ id, label: `本单病害 ${id}`, severity: 'medium' as FaultSeverity, state: 'pending' })),
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
                label="备注（多标签同时编辑时，未冲突的备注改动会自动合并）"
                value={dialog.form.remark}
                onChange={(event) => patchForm({ remark: event.target.value })}
              />
            </Grid>

            {dialog.mergedHint ? (
              <Grid item xs={12}>
                <Alert severity={dialog.conflicts.some((item) => item.resolution === null) ? 'warning' : 'info'}>
                  {dialog.mergedHint}
                </Alert>
              </Grid>
            ) : null}

            {dialog.conflicts.length > 0 ? (
              <Grid item xs={12}>
                <Paper variant="outlined" sx={{ p: 1.5, borderColor: '#ed6c02' }}>
                  <Typography variant="subtitle2" color="warning.dark" gutterBottom>
                    字段冲突人工选定（两边内容都保留）
                  </Typography>
                  <Stack spacing={1.25}>
                    {dialog.conflicts.map((conflict) => (
                      <Stack
                        key={conflict.field}
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        alignItems={{ sm: 'center' }}
                      >
                        <Chip size="small" label={WORK_ORDER_FIELD_LABEL[conflict.field]} sx={{ minWidth: 88 }} />
                        <Button
                          size="small"
                          variant={conflict.resolution === 'local' ? 'contained' : 'outlined'}
                          onClick={() => chooseResolution(conflict, 'local')}
                          sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
                        >
                          本页：{formatFieldValue(conflict.local)}
                        </Button>
                        <Button
                          size="small"
                          color="success"
                          variant={conflict.resolution === 'remote' ? 'contained' : 'outlined'}
                          onClick={() => chooseResolution(conflict, 'remote')}
                          sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
                        >
                          其他标签：{formatFieldValue(conflict.remote)}
                        </Button>
                      </Stack>
                    ))}
                  </Stack>
                </Paper>
              </Grid>
            ) : null}

            <Grid item xs={12}>
              <Alert
                severity={draftConflicts.time.length > 0 || draftConflicts.members.length > 0 ? 'warning' : 'success'}
              >
                冲突预检：时间窗重叠 {draftConflicts.time.length > 0 ? draftConflicts.time.join('、') : '无'} · 人员占用{' '}
                {draftConflicts.members.length > 0 ? draftConflicts.members.join('、') : '无'} · 机具占用{' '}
                {draftConflicts.machines.length > 0 ? draftConflicts.machines.join('、') : '无'} · 天窗时长{' '}
                {formatDuration(draftConflicts.duration)}
                {draftConflicts.time.length > 0 || draftConflicts.members.length > 0 || draftConflicts.machines.length > 0
                  ? '。保存后本单及受影响的未下达作业单将退回草稿。'
                  : ''}
              </Alert>
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
          <Button onClick={() => setDialog(closedDialog())}>取消</Button>
          <Button
            variant="contained"
            onClick={() => void submit()}
            disabled={dialog.conflicts.some((item) => item.resolution === null)}
          >
            {dialog.conflicts.some((item) => item.resolution === null) ? '先解决字段冲突' : '保存'}
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
