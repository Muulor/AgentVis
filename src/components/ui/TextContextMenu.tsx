/**
 * TextContextMenu - 文本复制/粘贴右键菜单
 *
 * 为禁用原生右键菜单的区域提供轻量自定义菜单：
 * - 输入框：复制选区、粘贴到光标位置
 * - 普通文本：复制当前页面选区
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, Copy } from 'lucide-react';
import { useI18n } from '@/i18n';
import styles from './TextContextMenu.module.css';

type EditableElement = HTMLInputElement | HTMLTextAreaElement;
type TextContextMenuAction = 'copy' | 'paste';

interface TextContextMenuState {
  x: number;
  y: number;
  canCopy: boolean;
  canPaste: boolean;
  copyText: string;
  editable: EditableElement | null;
}

interface TextContextMenuProps {
  menu: TextContextMenuState | null;
  onAction: (action: TextContextMenuAction) => void | Promise<void>;
  onClose: () => void;
}

const EDITABLE_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

function getSupportedEditable(target: EventTarget | null): EditableElement | null {
  if (!(target instanceof Element)) return null;

  const editable = target.closest('input, textarea');
  if (editable instanceof HTMLTextAreaElement) {
    return editable;
  }
  if (editable instanceof HTMLInputElement && EDITABLE_INPUT_TYPES.has(editable.type)) {
    return editable;
  }

  return null;
}

function getEditableRange(editable: EditableElement): { start: number; end: number } {
  try {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? start;
    return { start, end };
  } catch {
    const offset = editable.value.length;
    return { start: offset, end: offset };
  }
}

function setEditableValue(editable: EditableElement, value: string) {
  const prototype =
    editable instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueDescriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  const boundValueSetter = valueDescriptor?.set?.bind(editable);

  if (boundValueSetter) {
    boundValueSetter(value);
  } else {
    editable.value = value;
  }

  editable.dispatchEvent(new Event('input', { bubbles: true }));
}

function replaceEditableSelection(editable: EditableElement, text: string) {
  const { start, end } = getEditableRange(editable);
  const nextValue = `${editable.value.slice(0, start)}${text}${editable.value.slice(end)}`;
  const nextCursor = start + text.length;

  editable.focus();
  setEditableValue(editable, nextValue);

  requestAnimationFrame(() => {
    try {
      editable.setSelectionRange(nextCursor, nextCursor);
    } catch {
      // Some input types do not support setSelectionRange.
    }
  });
}

function getSelectedTextWithin(root: HTMLElement | null): string {
  if (!root) return '';

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return '';
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const commonElement =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;

  if (!commonElement || !root.contains(commonElement)) {
    return '';
  }

  return selection.toString();
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTextContextMenu() {
  const [menu, setMenu] = useState<TextContextMenuState | null>(null);

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const openEditableMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();

      const editable = getSupportedEditable(event.target);
      if (!editable) {
        closeMenu();
        return;
      }

      const { start, end } = getEditableRange(editable);
      const copyText = start === end ? '' : editable.value.slice(start, end);

      setMenu({
        x: event.clientX,
        y: event.clientY,
        canCopy: copyText.length > 0,
        canPaste: !editable.disabled && !editable.readOnly,
        copyText,
        editable,
      });
    },
    [closeMenu]
  );

  const openSelectionMenu = useCallback(
    (event: ReactMouseEvent, root: HTMLElement | null) => {
      event.preventDefault();

      const copyText = getSelectedTextWithin(root);
      if (!copyText.trim()) {
        closeMenu();
        return;
      }

      setMenu({
        x: event.clientX,
        y: event.clientY,
        canCopy: true,
        canPaste: false,
        copyText,
        editable: null,
      });
    },
    [closeMenu]
  );

  const handleMenuAction = useCallback(
    async (action: TextContextMenuAction) => {
      if (!menu) return;

      if (action === 'copy' && menu.canCopy) {
        await navigator.clipboard.writeText(menu.copyText);
      }

      if (action === 'paste' && menu.canPaste && menu.editable) {
        const clipboardText = await navigator.clipboard.readText();
        if (clipboardText) {
          replaceEditableSelection(menu.editable, clipboardText);
        }
      }

      closeMenu();
    },
    [closeMenu, menu]
  );

  return {
    menu,
    closeMenu,
    openEditableMenu,
    openSelectionMenu,
    handleMenuAction,
  };
}

export function TextContextMenu({ menu, onAction, onClose }: TextContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const nextLeft = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const nextTop = Math.min(menu.y, window.innerHeight - rect.height - 8);

    menuRef.current.style.left = `${Math.max(8, nextLeft)}px`;
    menuRef.current.style.top = `${Math.max(8, nextTop)}px`;
  }, [menu]);

  if (!menu) return null;

  const menuElement = (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: menu.x, top: menu.y }}
      data-custom-context-menu
      onPointerDownCapture={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        className={styles.menuItem}
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          void onAction('copy');
        }}
        disabled={!menu.canCopy}
      >
        <Copy size={14} />
        <span>{t('common.copy')}</span>
      </button>
      {menu.canPaste && (
        <button
          className={styles.menuItem}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void onAction('paste');
          }}
        >
          <Clipboard size={14} />
          <span>{t('common.paste')}</span>
        </button>
      )}
    </div>
  );

  return createPortal(menuElement, document.body);
}
