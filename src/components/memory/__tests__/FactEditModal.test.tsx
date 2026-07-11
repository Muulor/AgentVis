import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n';
import { FactEditModal } from '../FactEditModal';

function renderModal() {
  return renderToStaticMarkup(
    <I18nProvider>
      <FactEditModal
        isOpen
        mode="create"
        factId={null}
        initialContent=""
        initialCategory="preference_style"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    </I18nProvider>
  );
}

describe('FactEditModal', () => {
  it('renders create copy and keeps edit copy out of create mode', () => {
    const html = renderModal();

    expect(html).toContain('新增事实');
    expect(html).toContain('保存事实');
    expect(html).toContain('新增事实会立即影响 Agent 后续行为');
    expect(html).not.toContain('编辑事实');
    expect(html).not.toContain('保存修改');
  });
});
