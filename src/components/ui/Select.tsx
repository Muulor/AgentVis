/**
 * 通用下拉选择组件
 *
 * 基于 Radix Select 统一应用内下拉框的圆角菜单、选中态与键盘交互。
 */

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@utils/classNames';
import styles from './Select.module.css';

const EMPTY_SELECT_VALUE = '__agentvis_empty_select_value__';

export interface SelectOption {
    value: string;
    label: ReactNode;
    disabled?: boolean;
}

interface SelectProps {
    id?: string;
    name?: string;
    value: string;
    options: ReadonlyArray<SelectOption>;
    onValueChange: (value: string) => void;
    className?: string;
    contentClassName?: string;
    disabled?: boolean;
    placeholder?: string;
    side?: SelectPrimitive.SelectContentProps['side'];
    align?: SelectPrimitive.SelectContentProps['align'];
    sideOffset?: number;
    'aria-label'?: string;
    'aria-labelledby'?: string;
}

function encodeSelectValue(value: string): string {
    return value === '' ? EMPTY_SELECT_VALUE : value;
}

function decodeSelectValue(value: string): string {
    return value === EMPTY_SELECT_VALUE ? '' : value;
}

export function Select({
    id,
    name,
    value,
    options,
    onValueChange,
    className,
    contentClassName,
    disabled = false,
    placeholder,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
}: SelectProps) {
    return (
        <SelectPrimitive.Root
            value={encodeSelectValue(value)}
            onValueChange={(nextValue) => onValueChange(decodeSelectValue(nextValue))}
            disabled={disabled}
            name={name}
        >
            <SelectPrimitive.Trigger
                id={id}
                className={cx(styles.trigger, className)}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
            >
                <SelectPrimitive.Value className={styles.value} placeholder={placeholder} />
                <SelectPrimitive.Icon className={styles.icon}>
                    <ChevronDown size={16} strokeWidth={2.2} />
                </SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>

            <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                    className={cx(styles.content, contentClassName)}
                    position="popper"
                    side={side}
                    align={align}
                    sideOffset={sideOffset}
                    collisionPadding={12}
                >
                    <SelectPrimitive.ScrollUpButton className={styles.scrollButton}>
                        <ChevronDown size={14} strokeWidth={2.2} />
                    </SelectPrimitive.ScrollUpButton>
                    <SelectPrimitive.Viewport className={styles.viewport}>
                        {options.map((option, index) => (
                            <SelectPrimitive.Item
                                key={`${option.value}-${index}`}
                                className={styles.item}
                                value={encodeSelectValue(option.value)}
                                disabled={option.disabled}
                            >
                                <SelectPrimitive.ItemText className={styles.itemText}>
                                    {option.label}
                                </SelectPrimitive.ItemText>
                                <SelectPrimitive.ItemIndicator className={styles.itemIndicator}>
                                    <Check size={16} strokeWidth={2.2} />
                                </SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>
                        ))}
                    </SelectPrimitive.Viewport>
                    <SelectPrimitive.ScrollDownButton className={styles.scrollButton}>
                        <ChevronDown size={14} strokeWidth={2.2} />
                    </SelectPrimitive.ScrollDownButton>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
