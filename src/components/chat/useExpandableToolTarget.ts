/**
 * Sub-Agent 工具目标折叠 Hook
 *
 * 统一处理工具 target 的数据截断和 UI 单行溢出，让不同工具行复用同一套展开逻辑。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useExpandableToolTarget(target: string, fullTarget?: string) {
    const targetRef = useRef<HTMLSpanElement>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);

    const resolvedFullTarget = fullTarget ?? target;
    const hasFullTarget = Boolean(fullTarget && fullTarget !== target);

    const measureOverflow = useCallback(() => {
        const node = targetRef.current;
        if (!node || isExpanded) return;

        const nextIsOverflowing = node.scrollWidth > node.clientWidth
            || node.scrollHeight > node.clientHeight;
        setIsOverflowing(prev => (
            prev === nextIsOverflowing ? prev : nextIsOverflowing
        ));
    }, [isExpanded]);

    useEffect(() => {
        setIsExpanded(false);
        setIsOverflowing(false);
    }, [target, fullTarget]);

    useEffect(() => {
        if (isExpanded || !target) return undefined;

        const frameId = window.requestAnimationFrame(measureOverflow);
        const node = targetRef.current;
        let observer: ResizeObserver | undefined;

        if (node && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measureOverflow);
            observer.observe(node);
        }

        window.addEventListener('resize', measureOverflow);

        return () => {
            window.cancelAnimationFrame(frameId);
            observer?.disconnect();
            window.removeEventListener('resize', measureOverflow);
        };
    }, [isExpanded, measureOverflow, target, fullTarget]);

    return {
        targetRef,
        isExpanded,
        canExpand: hasFullTarget || isOverflowing,
        displayedTarget: isExpanded ? resolvedFullTarget : target,
        toggleExpanded: () => setIsExpanded(prev => !prev),
    };
}
