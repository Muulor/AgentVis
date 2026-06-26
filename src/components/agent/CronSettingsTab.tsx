/**
 * CronSettingsTab - 定时任务设置标签页
 *
 * 嵌入 AgentSettingsModal 内部，提供：
 * - 定时任务列表展示
 * - 频率驱动的友好调度配置 UI（替代原始 cron 表达式）
 * - 高级模式：直接编辑 cron 表达式
 * - 执行一次后自动关闭开关
 * - 编辑/删除/启用禁用操作
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useCronStore } from '@stores/cronStore';
import { TextContextMenu, useTextContextMenu } from '@components/ui';
import {
    isValidCronExpression,
    describeCronExpression,
    buildCronExpression,
    parseScheduleConfig,
    DEFAULT_SCHEDULE_CONFIG,
} from '@services/cron/cronExpression';
import type { ScheduleConfig, ScheduleFrequency } from '@services/cron/cronExpression';
import { CronJobItem } from './CronJobItem';
import type { CronJob } from '@services/cron/types';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './CronSettingsTab.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('CronSettingsTab');

interface CronSettingsTabProps {
    agentId: string;
}

/** 频率选项配置 */
const FREQUENCY_OPTIONS: ScheduleFrequency[] = [
    'every_n_minutes',
    'hourly',
    'daily',
    'weekly',
    'monthly',
    'specific',
];

/** 分钟间隔选项 */
const INTERVAL_OPTIONS = [1, 5, 10, 15, 20, 30];

/** 星期选项 */
const DAY_OF_WEEK_OPTIONS = [
    { value: 1, key: 'weekMonday' },
    { value: 2, key: 'weekTuesday' },
    { value: 3, key: 'weekWednesday' },
    { value: 4, key: 'weekThursday' },
    { value: 5, key: 'weekFriday' },
    { value: 6, key: 'weekSaturday' },
    { value: 0, key: 'weekSunday' },
] as const;

/** 编辑/创建表单状态 */
interface FormState {
    name: string;
    prompt: string;
    /** 友好调度配置 */
    schedule: ScheduleConfig;
    /** 是否使用高级模式（直接编辑 cron 表达式） */
    isAdvancedMode: boolean;
    /** 高级模式下的 cron 表达式 */
    rawCronExpression: string;
}

const DEFAULT_FORM: FormState = {
    name: '',
    prompt: '',
    schedule: { ...DEFAULT_SCHEDULE_CONFIG },
    isAdvancedMode: false,
    rawCronExpression: '0 9 * * *',
};

export function CronSettingsTab({ agentId }: CronSettingsTabProps) {
    const { language, t } = useI18n();
    const { jobs, isLoading, loadJobsByAgent, createJob, updateJob, deleteJob, toggleJob } = useCronStore();
    const {
        menu: textContextMenu,
        closeMenu: closeTextContextMenu,
        openEditableMenu,
        handleMenuAction,
    } = useTextContextMenu();

    // 编辑模式状态
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingJobId, setEditingJobId] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(DEFAULT_FORM);
    const [formError, setFormError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    // 加载当前 Agent 的定时任务
    useEffect(() => {
        void loadJobsByAgent(agentId);
    }, [agentId, loadJobsByAgent]);

    // 计算当前 cron 表达式（由配置或高级模式决定）
    const currentCronExpression = useMemo(() => {
        if (form.isAdvancedMode) {
            return form.rawCronExpression;
        }
        return buildCronExpression(form.schedule);
    }, [form.isAdvancedMode, form.rawCronExpression, form.schedule]);

    const getFrequencyLabel = useCallback((frequency: ScheduleFrequency) => {
        switch (frequency) {
            case 'every_n_minutes':
                return t('agent.cron.frequencyEveryNMinutes');
            case 'hourly':
                return t('agent.cron.frequencyHourly');
            case 'daily':
                return t('agent.cron.frequencyDaily');
            case 'weekly':
                return t('agent.cron.frequencyWeekly');
            case 'monthly':
                return t('agent.cron.frequencyMonthly');
            case 'specific':
                return t('agent.cron.frequencySpecific');
        }
    }, [t]);

    // 表达式的人类可读预览
    const cronPreview = isValidCronExpression(currentCronExpression)
        ? describeCronExpression(currentCronExpression, language)
        : null;

    // 打开新增表单
    const handleOpenCreate = useCallback(() => {
        setEditingJobId(null);
        setForm(DEFAULT_FORM);
        setFormError(null);
        setIsFormOpen(true);
    }, []);

    // 打开编辑表单
    const handleEdit = useCallback((job: CronJob) => {
        // 尝试解析已有的 cron 表达式为友好配置
        const parsedConfig = parseScheduleConfig(job.cronExpression);
        const isAdvanced = parsedConfig === null;

        setEditingJobId(job.id);
        setForm({
            name: job.name,
            prompt: job.prompt,
            schedule: parsedConfig ?? { ...DEFAULT_SCHEDULE_CONFIG },
            isAdvancedMode: isAdvanced,
            rawCronExpression: job.cronExpression,
        });
        setFormError(null);
        setIsFormOpen(true);
    }, []);

    // 关闭表单
    const handleCloseForm = useCallback(() => {
        setIsFormOpen(false);
        setEditingJobId(null);
        setForm(DEFAULT_FORM);
        setFormError(null);
    }, []);

    // 更新调度配置的便捷函数
    const updateSchedule = useCallback((patch: Partial<ScheduleConfig>) => {
        setForm(prev => ({
            ...prev,
            schedule: { ...prev.schedule, ...patch },
        }));
    }, []);

    // 频率切换时调整相关默认值
    const handleFrequencyChange = useCallback((frequency: ScheduleFrequency) => {
        setForm(prev => {
            const newSchedule = { ...prev.schedule, frequency };

            // 仅「指定时间」模式开启 autoDisable，其余一律关闭
            newSchedule.autoDisable = frequency === 'specific';

            return { ...prev, schedule: newSchedule };
        });
    }, []);

    // 切换高级模式
    const handleToggleAdvanced = useCallback(() => {
        setForm(prev => {
            if (prev.isAdvancedMode) {
                // 从高级模式切回友好模式：尝试解析当前表达式
                const parsed = parseScheduleConfig(prev.rawCronExpression);
                if (parsed) {
                    return { ...prev, isAdvancedMode: false, schedule: parsed };
                }
                // 解析失败，保持高级模式
                setFormError(t('agent.cron.invalidFriendly'));
                return prev;
            } else {
                // 切换到高级模式：将当前配置生成的表达式填入
                const expr = buildCronExpression(prev.schedule);
                return { ...prev, isAdvancedMode: true, rawCronExpression: expr };
            }
        });
    }, [t]);

    // 保存（创建或更新）
    const handleSave = useCallback(async () => {
        // 校验
        if (!form.name.trim()) {
            setFormError(t('agent.cron.needName'));
            return;
        }
        if (!isValidCronExpression(currentCronExpression)) {
            setFormError(t('agent.cron.invalidSchedule'));
            return;
        }
        if (!form.prompt.trim()) {
            setFormError(t('agent.cron.needPrompt'));
            return;
        }

        setIsSaving(true);
        setFormError(null);

        try {
            // autoDisable 信息存入 metadata（JSON 字段扩展，不改后端 schema）
            // CronScheduler 执行后检查此标记
            const cronExpression = currentCronExpression;

            if (editingJobId) {
                await updateJob(editingJobId, {
                    name: form.name.trim(),
                    cronExpression,
                    prompt: form.prompt.trim(),
                });
            } else {
                await createJob({
                    agentId,
                    name: form.name.trim(),
                    cronExpression,
                    prompt: form.prompt.trim(),
                });
            }
            handleCloseForm();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setFormError(t('agent.cron.saveFailed', { error: message }));
            logger.error('保存定时任务失败', { error: message });
        } finally {
            setIsSaving(false);
        }
    }, [form, currentCronExpression, editingJobId, agentId, createJob, updateJob, handleCloseForm, t]);

    // 生成 0-N 的数字选项
    const numberOptions = useCallback((min: number, max: number) => {
        const options: number[] = [];
        for (let i = min; i <= max; i++) {
            options.push(i);
        }
        return options;
    }, []);

    return (
        <div
            className={styles.container}
            data-custom-context-menu
            onContextMenu={openEditableMenu}
        >
            {/* 头部：标题 + 新增按钮 */}
            <div className={styles.header}>
                <div>
                    <label className={styles.label}>{t('agent.cron.title')}</label>
                    <p className={styles.hint}>{t('agent.cron.hint')}</p>
                </div>
                {!isFormOpen && (
                    <button className={styles.addBtn} onClick={handleOpenCreate}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M6 2v8M2 6h8" />
                        </svg>
                        {t('agent.cron.add')}
                    </button>
                )}
            </div>

            {/* 新增/编辑表单 */}
            {isFormOpen && (
                <div className={styles.form}>
                    <div className={styles.formTitle}>
                        {editingJobId ? t('agent.cron.editTask') : t('agent.cron.newTask')}
                    </div>

                    {/* 任务名称 */}
                    <div className={styles.formField}>
                        <label className={styles.fieldLabel}>{t('agent.cron.name')}</label>
                        <input
                            className={styles.input}
                            value={form.name}
                            onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                            placeholder={t('agent.cron.namePlaceholder')}
                            maxLength={50}
                        />
                    </div>

                    {/* 调度时间 - 友好模式 */}
                    {!form.isAdvancedMode ? (
                        <div className={styles.formField}>
                            <label className={styles.fieldLabel}>
                                {t('agent.cron.executeTime')}
                                {cronPreview && (
                                    <span className={styles.cronPreview}>{cronPreview}</span>
                                )}
                            </label>

                            {/* 频率选择 */}
                            <div className={styles.scheduleRow}>
                                <select
                                    className={styles.select}
                                    value={form.schedule.frequency}
                                    onChange={(e) => handleFrequencyChange(e.target.value as ScheduleFrequency)}
                                >
                                    {FREQUENCY_OPTIONS.map(opt => (
                                        <option key={opt} value={opt}>{getFrequencyLabel(opt)}</option>
                                    ))}
                                </select>
                            </div>

                            {/* 每 N 分钟：间隔选择 */}
                            {form.schedule.frequency === 'every_n_minutes' && (
                                <div className={styles.scheduleRow}>
                                    <span className={styles.scheduleLabel}>{t('agent.cron.every')}</span>
                                    <select
                                        className={styles.selectSmall}
                                        value={form.schedule.intervalMinutes}
                                        onChange={(e) => updateSchedule({ intervalMinutes: parseInt(e.target.value, 10) })}
                                    >
                                        {INTERVAL_OPTIONS.map(n => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                    <span className={styles.scheduleLabel}>{t('agent.cron.minute')}</span>
                                </div>
                            )}

                            {/* 每小时：分钟选择 */}
                            {form.schedule.frequency === 'hourly' && (
                                <div className={styles.scheduleRow}>
                                    <span className={styles.scheduleLabel}>{t('agent.cron.atMinute')}</span>
                                    <select
                                        className={styles.selectSmall}
                                        value={form.schedule.minute}
                                        onChange={(e) => updateSchedule({ minute: parseInt(e.target.value, 10) })}
                                    >
                                        {numberOptions(0, 59).map(n => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                    <span className={styles.scheduleLabel}>{t('agent.cron.minuteShort')}</span>
                                </div>
                            )}

                            {/* 每天 / 每周 / 每月 / 指定时间：所有字段合并为一行 */}
                            {['daily', 'weekly', 'monthly', 'specific'].includes(form.schedule.frequency) && (
                                <div className={styles.scheduleRow}>
                                    {/* 每周：星期几 */}
                                    {form.schedule.frequency === 'weekly' && (
                                        <>
                                            <span className={styles.scheduleLabel}>{t('agent.cron.every')}</span>
                                            <select
                                                className={styles.selectSmall}
                                                value={form.schedule.dayOfWeek}
                                                onChange={(e) => updateSchedule({ dayOfWeek: parseInt(e.target.value, 10) })}
                                            >
                                                {DAY_OF_WEEK_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>{t(`agent.cron.${opt.key}`)}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}

                                    {/* 指定时间：月 + 日 */}
                                    {form.schedule.frequency === 'specific' && (
                                        <>
                                            <select
                                                className={styles.selectSmall}
                                                value={form.schedule.month}
                                                onChange={(e) => updateSchedule({ month: parseInt(e.target.value, 10) })}
                                            >
                                                {numberOptions(1, 12).map(n => (
                                                    <option key={n} value={n}>{n} {t('agent.cron.month')}</option>
                                                ))}
                                            </select>
                                            <select
                                                className={styles.selectSmall}
                                                value={form.schedule.dayOfMonth}
                                                onChange={(e) => updateSchedule({ dayOfMonth: parseInt(e.target.value, 10) })}
                                            >
                                                {numberOptions(1, 31).map(n => (
                                                    <option key={n} value={n}>{n} {t('agent.cron.day')}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}

                                    {/* 每月：日 */}
                                    {form.schedule.frequency === 'monthly' && (
                                        <>
                                            <span className={styles.scheduleLabel}>{t('agent.cron.monthlyEvery')}</span>
                                            <select
                                                className={styles.selectSmall}
                                                value={form.schedule.dayOfMonth}
                                                onChange={(e) => updateSchedule({ dayOfMonth: parseInt(e.target.value, 10) })}
                                            >
                                                {numberOptions(1, 31).map(n => (
                                                    <option key={n} value={n}>{n} {t('agent.cron.day')}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}

                                    {/* 时:分 */}
                                    <select
                                        className={styles.selectSmall}
                                        value={form.schedule.hour}
                                        onChange={(e) => updateSchedule({ hour: parseInt(e.target.value, 10) })}
                                    >
                                        {numberOptions(0, 23).map(n => (
                                            <option key={n} value={n}>{String(n).padStart(2, '0')}</option>
                                        ))}
                                    </select>
                                    <span className={styles.timeSeparator}>:</span>
                                    <select
                                        className={styles.selectSmall}
                                        value={form.schedule.minute}
                                        onChange={(e) => updateSchedule({ minute: parseInt(e.target.value, 10) })}
                                    >
                                        {numberOptions(0, 59).map(n => (
                                            <option key={n} value={n}>{String(n).padStart(2, '0')}</option>
                                        ))}
                                    </select>

                                    {/* 指定时间模式：行尾显示「执行一次后自动关闭」开关 */}
                                    {form.schedule.frequency === 'specific' && (
                                        <label className={styles.toggleLabel}>
                                            <div
                                                className={cx(styles.toggleSwitch, form.schedule.autoDisable && styles.toggleOn)}
                                                onClick={() => updateSchedule({ autoDisable: !form.schedule.autoDisable })}
                                                role="switch"
                                                aria-checked={form.schedule.autoDisable}
                                            >
                                                <div className={styles.toggleThumb} />
                                            </div>
                                            <span className={styles.toggleText}>{t('agent.cron.autoDisable')}</span>
                                        </label>
                                    )}
                                </div>
                            )}


                            {/* 切换到高级模式 */}
                            <button
                                className={styles.advancedToggle}
                                onClick={handleToggleAdvanced}
                                type="button"
                            >
                                {t('agent.cron.advancedCustom')}
                            </button>
                        </div>
                    ) : (
                        /* 高级模式：直接编辑 cron 表达式 */
                        <div className={styles.formField}>
                            <label className={styles.fieldLabel}>
                                {t('agent.cron.cronExpression')}
                                {cronPreview && (
                                    <span className={styles.cronPreview}>{cronPreview}</span>
                                )}
                            </label>
                            <input
                                className={styles.input}
                                value={form.rawCronExpression}
                                onChange={(e) => setForm(prev => ({ ...prev, rawCronExpression: e.target.value }))}
                                placeholder={t('agent.cron.cronPlaceholder')}
                            />
                            <span className={styles.fieldHint}>
                                {t('agent.cron.cronHint')}
                            </span>
                            <button
                                className={styles.advancedToggle}
                                onClick={handleToggleAdvanced}
                                type="button"
                            >
                                {t('agent.cron.backFriendly')}
                            </button>
                        </div>
                    )}

                    {/* 提示词 */}
                    <div className={styles.formField}>
                        <label className={styles.fieldLabel}>{t('agent.cron.prompt')}</label>
                        <textarea
                            className={styles.textarea}
                            value={form.prompt}
                            onChange={(e) => setForm(prev => ({ ...prev, prompt: e.target.value }))}
                            placeholder={t('agent.cron.promptPlaceholder')}
                            rows={4}
                        />
                    </div>

                    {/* 错误提示 */}
                    {formError && (
                        <div className={styles.formError}>{formError}</div>
                    )}

                    {/* 操作按钮 */}
                    <div className={styles.formActions}>
                        <button className={styles.cancelFormBtn} onClick={handleCloseForm} disabled={isSaving}>
                            {t('common.cancel')}
                        </button>
                        <button className={styles.saveFormBtn} onClick={handleSave} disabled={isSaving}>
                            {isSaving ? t('agent.settings.saving') : t('common.save')}
                        </button>
                    </div>
                </div>
            )
            }

            {/* 任务列表 */}
            {
                isLoading ? (
                    <div className={styles.loading}>{t('common.loading')}</div>
                ) : jobs.length === 0 && !isFormOpen ? (
                    <div className={styles.empty}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.emptyIcon}>
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                        </svg>
                        <p>{t('agent.cron.empty')}</p>
                        <p className={styles.emptyHint}>{t('agent.cron.emptyHint')}</p>
                    </div>
                ) : (
                    <div className={styles.jobList}>
                        {jobs.map((job) => (
                            <CronJobItem
                                key={job.id}
                                job={job}
                                onToggle={toggleJob}
                                onEdit={handleEdit}
                                onDelete={deleteJob}
                            />
                        ))}
                    </div>
                )
            }
            <TextContextMenu
                menu={textContextMenu}
                onAction={handleMenuAction}
                onClose={closeTextContextMenu}
            />
        </div>
    );
}
