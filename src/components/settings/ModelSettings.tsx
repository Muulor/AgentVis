/**
 * ModelSettings - 模型设置标签页
 *
 * 功能：
 * 1. 配置默认 LLM Provider 和模型
 * 2. 导入/导出/重置用户自定义模型配置
 */

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import {
  ChevronDown,
  Download,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useSettingsStore } from '@stores/settingsStore';
import { useToast } from '@components/ui/Toast';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { Select } from '@components/ui';
import {
  getProviders,
  getModelsByProvider,
  getUserModels,
  addUserModel,
  updateUserModel,
  hasRegisteredModel,
  importModelsFromJson,
  exportUserModelsAsJson,
  resetUserModels,
  removeUserModel,
  hasUserModels,
  onModelsChange,
  type ModelDefinition,
} from '@/config/modelRegistry';
import { cx } from '@utils/classNames';
import styles from './ModelSettings.module.css';
import { useI18n } from '@/i18n';

interface CustomModelFormState {
  providerId: string;
  modelId: string;
  modelName: string;
  contextWindow: string;
  supportsVision: boolean;
}

interface EditingModelKey {
  id: string;
  providerId: string;
}

const DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW = '128000';

function createEmptyModelForm(providerId: string): CustomModelFormState {
  return {
    providerId,
    modelId: '',
    modelName: '',
    contextWindow: DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW,
    supportsVision: false,
  };
}

export function ModelSettings() {
  const { t } = useI18n();
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);

  // 订阅模型列表变更以触发重渲染
  const [, forceUpdate] = useState(0);
  // 自定义模型列表折叠状态（默认收起，节省设置窗口空间）
  const [userModelsExpanded, setUserModelsExpanded] = useState(false);
  // 重置确认弹窗状态
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [modelForm, setModelForm] = useState<CustomModelFormState>(() =>
    createEmptyModelForm(defaultProvider || 'local')
  );
  const [editingModelKey, setEditingModelKey] = useState<EditingModelKey | null>(null);
  const { toast } = useToast();
  useEffect(() => {
    return onModelsChange(() => forceUpdate((v) => v + 1));
  }, []);

  const providers = getProviders();
  const userModels = getUserModels();

  // 当前选中的 provider
  const currentProvider = defaultProvider || 'local';
  const availableModels = getModelsByProvider(currentProvider);
  const isEditingModel = editingModelKey !== null;

  const resetModelForm = useCallback(
    (providerId = currentProvider) => {
      setModelForm(createEmptyModelForm(providerId));
      setEditingModelKey(null);
    },
    [currentProvider]
  );

  // 切换 Provider 时自动选择第一个模型
  const handleProviderChange = (provider: string) => {
    setDefaultProvider(provider);
    const models = getModelsByProvider(provider);
    if (models.length > 0 && models[0]) {
      setDefaultModel(models[0].id);
    }
  };

  const handleModelFormSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const providerId = modelForm.providerId.trim();
      const modelId = modelForm.modelId.trim();
      const modelName = modelForm.modelName.trim() || modelId;
      const contextWindow = Number(modelForm.contextWindow);

      if (!providerId || !modelId) {
        toast({ title: t('settings.model.modelFormRequired'), type: 'warning' });
        return;
      }

      if (
        !Number.isFinite(contextWindow) ||
        contextWindow <= 0 ||
        !Number.isInteger(contextWindow)
      ) {
        toast({ title: t('settings.model.contextWindowInvalid'), type: 'warning' });
        return;
      }

      const isSameEditingModel = editingModelKey
        ? editingModelKey.id === modelId && editingModelKey.providerId === providerId
        : false;
      if (hasRegisteredModel(modelId, providerId) && !isSameEditingModel) {
        toast({ title: t('settings.model.modelAlreadyExists'), type: 'warning' });
        return;
      }

      const nextModel: ModelDefinition = {
        id: modelId,
        name: modelName,
        providerId,
        contextWindow,
        ...(modelForm.supportsVision ? { supportsVision: true } : {}),
      };

      try {
        if (editingModelKey) {
          await updateUserModel(editingModelKey.id, editingModelKey.providerId, nextModel);
          toast({ title: t('settings.model.updateModelSuccess'), type: 'success' });
        } else {
          await addUserModel(nextModel);
          toast({ title: t('settings.model.addModelSuccess'), type: 'success' });
        }
        setUserModelsExpanded(true);
        resetModelForm(providerId);
      } catch (error) {
        toast({
          title: isEditingModel
            ? t('settings.model.updateModelFailed')
            : t('settings.model.addModelFailed'),
          description: error instanceof Error ? error.message : String(error),
          type: 'error',
        });
      }
    },
    [editingModelKey, isEditingModel, modelForm, resetModelForm, t, toast]
  );

  // 下载 JSON 配置模板：让用户直观了解文件格式，无需查阅文档
  const handleDownloadTemplate = useCallback(async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        title: t('settings.model.templateSaveTitle'),
        defaultPath: 'model-config-template.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return;

      // 模板内容：包含所有合法 providerId 的示例条目，字段均有说明
      // 使用行内注释字段（_comment）作为格式说明，导入时这些字段会被忽略
      const templateContent = JSON.stringify(
        {
          version: 1,
          _description: t('settings.model.templateComment'),
          _providerId_values: [
            'openai         -> OpenAI',
            'anthropic      -> Anthropic',
            'gemini         -> Google AI',
            'zhipu          -> ZhipuAI',
            'deepseek       -> DeepSeek',
            'agnes          -> Agnes AI',
            'stepfun        -> StepFun (Step Plan)',
            'xiaomi-mimo    -> Xiaomi(Token Plan)',
            'minimax        -> MiniMax(Token Plan)',
            `volcengine     -> ${t('settings.model.providerVolcengineName')} (Coding Plan)`,
            'openrouter     -> OpenRouter',
            `local          -> ${t('settings.model.providerLocalName')}`,
          ],
          models: [
            {
              id: 'deepseek-v3',
              name: t('settings.model.templateDeepSeekName'),
              providerId: 'volcengine',
              contextWindow: 163840,
              supportsVision: false,
            },
            {
              id: 'my-local-model',
              name: t('settings.model.templateLocalName'),
              providerId: 'local',
              contextWindow: 128000,
              supportsVision: false,
            },
          ],
        },
        null,
        2
      );

      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(filePath, templateContent);
      toast({ title: t('settings.model.templateSaved'), type: 'success' });
    } catch (error) {
      toast({
        title: t('settings.model.templateSaveFailed'),
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    }
  }, [toast, t]);

  // 导入 JSON 配置文件
  const handleImport = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        title: t('settings.model.importTitle'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });

      if (!selected) return;

      const filePath = typeof selected === 'string' ? selected : selected;
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const content = await readTextFile(filePath);
      const count = await importModelsFromJson(content);
      toast({ title: t('settings.model.importSuccess', { count }), type: 'success' });
    } catch (error) {
      toast({
        title: t('settings.model.importFailed'),
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    }
  }, [toast, t]);

  // 导出用户自定义配置
  const handleExport = useCallback(async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        title: t('settings.model.exportTitle'),
        defaultPath: 'model-config.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (!filePath) return;

      const content = exportUserModelsAsJson();
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(filePath, content);
      toast({ title: t('settings.model.exportSuccess'), type: 'success' });
    } catch (error) {
      toast({
        title: t('settings.model.exportFailed'),
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    }
  }, [toast, t]);

  // 重置用户配置（由 ConfirmDialog 确认后触发）
  const handleResetConfirmed = useCallback(async () => {
    setResetConfirmOpen(false);
    try {
      await resetUserModels();
      toast({ title: t('settings.model.resetSuccess'), type: 'success' });
    } catch (error) {
      toast({
        title: t('settings.model.resetFailed'),
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    }
  }, [toast, t]);

  // 删除单个用户自定义模型
  const handleRemoveUserModel = useCallback(
    async (modelId: string, providerId: string) => {
      await removeUserModel(modelId, providerId);
      if (editingModelKey?.id === modelId && editingModelKey.providerId === providerId) {
        resetModelForm(providerId);
      }
    },
    [editingModelKey, resetModelForm]
  );

  const handleEditUserModel = useCallback((model: ModelDefinition) => {
    setEditingModelKey({ id: model.id, providerId: model.providerId });
    setModelForm({
      providerId: model.providerId,
      modelId: model.id,
      modelName: model.name,
      contextWindow: String(model.contextWindow),
      supportsVision: model.supportsVision === true,
    });
    setUserModelsExpanded(true);
  }, []);

  return (
    <div className={styles.container}>
      <p className={styles.description}>{t('settings.model.description')}</p>

      {/* 默认 Provider */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('settings.model.defaultProvider')}</h3>
        <div className={styles.providerSelector}>
          {providers.map((provider) => (
            <button
              key={provider.id}
              className={cx(
                styles.providerOption,
                currentProvider === provider.id && styles.providerOptionActive
              )}
              onClick={() => handleProviderChange(provider.id)}
            >
              {provider.name}
            </button>
          ))}
        </div>
      </section>

      {/* 默认模型 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('settings.model.defaultModel')}</h3>
        <Select
          className={styles.select}
          value={defaultModel || (availableModels.length > 0 ? (availableModels[0]?.id ?? '') : '')}
          onValueChange={setDefaultModel}
          options={availableModels.map((model) => ({
            value: model.id,
            label: model.name,
          }))}
        />
      </section>

      {/* 模型配置管理 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('settings.model.configManagement')}</h3>
        <p className={styles.description}>{t('settings.model.configDescription')}</p>

        <form className={styles.modelForm} onSubmit={handleModelFormSubmit}>
          <div className={styles.modelFormHeader}>
            <span>
              {isEditingModel
                ? t('settings.model.editCustomModel')
                : t('settings.model.addCustomModel')}
            </span>
          </div>
          <div className={styles.modelFormGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.model.formProvider')}</span>
              <Select
                className={styles.formControl}
                value={modelForm.providerId}
                onValueChange={(value) => setModelForm((form) => ({ ...form, providerId: value }))}
                options={providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.model.formModelId')}</span>
              <input
                className={styles.formControl}
                value={modelForm.modelId}
                onChange={(event) =>
                  setModelForm((form) => ({ ...form, modelId: event.target.value }))
                }
                placeholder={t('settings.model.formModelIdPlaceholder')}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.model.formModelName')}</span>
              <input
                className={styles.formControl}
                value={modelForm.modelName}
                onChange={(event) =>
                  setModelForm((form) => ({ ...form, modelName: event.target.value }))
                }
                placeholder={t('settings.model.formModelNamePlaceholder')}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.model.formContextWindow')}</span>
              <input
                className={styles.formControl}
                type="number"
                min="1"
                value={modelForm.contextWindow}
                onChange={(event) =>
                  setModelForm((form) => ({ ...form, contextWindow: event.target.value }))
                }
                placeholder={DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW}
              />
            </label>
          </div>
          <div className={styles.modelFormFooter}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={modelForm.supportsVision}
                onChange={(event) =>
                  setModelForm((form) => ({ ...form, supportsVision: event.target.checked }))
                }
              />
              <span className={styles.toggleSwitch} />
              <span className={styles.toggleText}>{t('settings.model.formSupportsVision')}</span>
            </label>
            <div className={styles.formActions}>
              {isEditingModel && (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => resetModelForm()}
                >
                  <X size={14} />
                  {t('common.cancel')}
                </button>
              )}
              <button type="submit" className={cx(styles.actionButton, styles.actionButtonPrimary)}>
                {isEditingModel ? <Save size={14} /> : <Plus size={14} />}
                {isEditingModel
                  ? t('settings.model.saveCustomModel')
                  : t('settings.model.addCustomModel')}
              </button>
            </div>
          </div>
        </form>

        <div className={styles.configActions}>
          <Tooltip content={t('settings.model.downloadTemplateTitle')}>
            <button className={styles.actionButton} onClick={handleDownloadTemplate}>
              <Download size={14} />
              {t('settings.model.downloadTemplate')}
            </button>
          </Tooltip>
          <button className={styles.actionButton} onClick={handleImport}>
            <Upload size={14} />
            {t('settings.model.importConfig')}
          </button>
          <button
            className={styles.actionButton}
            onClick={handleExport}
            disabled={!hasUserModels()}
          >
            <Download size={14} />
            {t('settings.model.exportConfig')}
          </button>
          <button
            className={cx(styles.actionButton, styles.actionButtonDanger)}
            onClick={() => setResetConfirmOpen(true)}
            disabled={!hasUserModels()}
          >
            <RotateCcw size={14} />
            {t('settings.model.resetToDefault')}
          </button>
        </div>

        {/* 用户自定义模型列表（可折叠） */}
        {userModels.length > 0 && (
          <div className={styles.userModelList}>
            <button
              className={styles.userModelListToggle}
              onClick={() => setUserModelsExpanded((v) => !v)}
            >
              <span>{t('settings.model.customModels', { count: userModels.length })}</span>
              <ChevronDown
                size={12}
                className={cx(styles.toggleChevron, userModelsExpanded && styles.toggleChevronOpen)}
              />
            </button>
            {userModelsExpanded && (
              <div className={styles.userModelItems}>
                {userModels.map((model) => (
                  <div key={`${model.id}-${model.providerId}`} className={styles.userModelItem}>
                    <div className={styles.userModelInfo}>
                      <span className={styles.userModelName}>{model.name}</span>
                      <span className={styles.userModelMeta}>
                        {model.providerId} - {(model.contextWindow / 1000).toFixed(0)}k tokens
                        {model.supportsVision === true
                          ? ` - ${t('settings.model.visionSupported')}`
                          : ''}
                      </span>
                    </div>
                    <div className={styles.userModelActions}>
                      <Tooltip content={t('settings.model.editCustomModel')}>
                        <button
                          className={styles.userModelIconButton}
                          onClick={() => handleEditUserModel(model)}
                          aria-label={t('settings.model.editCustomModel')}
                        >
                          <Pencil size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('settings.model.deleteCustomModel')}>
                        <button
                          className={cx(styles.userModelIconButton, styles.userModelDangerButton)}
                          onClick={() => handleRemoveUserModel(model.id, model.providerId)}
                          aria-label={t('settings.model.deleteCustomModel')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className={styles.infoSection}>
        <div className={styles.infoCard}>
          <h4 className={styles.infoTitle}>{t('settings.model.aboutProvider')}</h4>
          <ul className={styles.infoList}>
            <li>
              <strong>OpenAI</strong> - {t('settings.model.providerOpenAI')}
            </li>
            <li>
              <strong>Anthropic</strong> - {t('settings.model.providerAnthropic')}
            </li>
            <li>
              <strong>Google AI</strong> - {t('settings.model.providerGoogle')}
            </li>
            <li>
              <strong>ZhipuAI</strong> - {t('settings.model.providerZhipu')}
            </li>
            <li>
              <strong>DeepSeek</strong> - {t('settings.model.providerDeepSeek')}
            </li>
            <li>
              <strong>Agnes AI</strong> - {t('settings.model.providerAgnes')}
            </li>
            <li>
              <strong>StepFun</strong> - {t('settings.model.providerStepFun')}
            </li>
            <li>
              <strong>Xiaomi MiMo</strong> - {t('settings.model.providerXiaomi')}
            </li>
            <li>
              <strong>MiniMax</strong> - {t('settings.model.providerMiniMax')}
            </li>
            <li>
              <strong>{t('settings.model.providerVolcengineName')}</strong> -{' '}
              {t('settings.model.providerVolcengine')}
            </li>
            <li>
              <strong>OpenRouter</strong> - {t('settings.model.providerOpenRouter')}
            </li>
            <li>
              <strong>Local</strong> - {t('settings.model.providerLocal')}
            </li>
          </ul>
        </div>
      </section>

      {/* 重置确认弹窗 */}
      <ConfirmDialog
        open={resetConfirmOpen}
        onClose={() => setResetConfirmOpen(false)}
        onConfirm={handleResetConfirmed}
        title={t('settings.model.resetDialogTitle')}
        description={t('settings.model.resetDialogDescription')}
        confirmText={t('settings.model.resetDialogConfirm')}
        variant="danger"
      />
    </div>
  );
}
