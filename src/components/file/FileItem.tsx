/**
 * FileItem - 单个文件项组件
 * 
 * 显示文件图标、名称、大小、时间
 * 支持点击选中、右键菜单
 */

import { useState } from 'react';
import { FileText, FileCode, File, Folder } from 'lucide-react';
import { FileContextMenu } from './FileContextMenu';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './FileItem.module.css';

/** 文件信息类型 */
export interface FileItemData {
    id: string;
    fileName: string;
    filePath: string;
    size: number;
    createdAt: number;
    /** 是否为目录 */
    isDirectory?: boolean;
}

interface FileItemProps {
    /** 文件信息 */
    file: FileItemData;
    /** 是否选中 */
    isSelected: boolean;
    /** 点击回调 */
    onClick: () => void;
    /** 导出回调 */
    onExport: () => void;
    /** 在资源管理器中显示回调 */
    onRevealInExplorer: () => void;
    /** 删除回调 */
    onDelete: () => void;
}

// 获取文件类型图标
function getFileIcon(fileName: string, isDirectory?: boolean): React.ReactNode {
    // 文件夹使用专用图标
    if (isDirectory) {
        return <Folder size={16} className={styles.iconFolder} />;
    }

    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

    // Markdown 文件
    if (['md', 'markdown'].includes(ext)) {
        return <FileText size={16} className={styles.iconMarkdown} />;
    }

    // 代码文件
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'json', 'css', 'html', 'yml', 'yaml'].includes(ext)) {
        return <FileCode size={16} className={styles.iconCode} />;
    }

    // 默认文件图标
    return <File size={16} className={styles.iconDefault} />;
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 格式化时间
function formatTime(timestamp: number, locale: string): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }

    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function FileItem({
    file,
    isSelected,
    onClick,
    onExport,
    onRevealInExplorer,
    onDelete,
}: FileItemProps) {
    const { language, t } = useI18n();
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const handleCloseMenu = () => {
        setContextMenu(null);
    };

    return (
        <>
            <div
                className={cx(styles.fileItem, isSelected && styles.selected)}
                onClick={onClick}
                onContextMenu={handleContextMenu}
                role="button"
                tabIndex={0}
                data-custom-context-menu="true"
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        onClick();
                    }
                }}
            >
                <div className={styles.icon}>
                    {getFileIcon(file.fileName, file.isDirectory)}
                </div>
                <div className={styles.info}>
                    <span className={styles.name} title={file.fileName}>
                        {file.fileName}
                    </span>
                    <span className={styles.meta}>
                        {file.isDirectory ? t('file.folder') : formatFileSize(file.size)} · {formatTime(file.createdAt, language)}
                    </span>
                </div>
            </div>

            {contextMenu && (
                <FileContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    fileName={file.fileName}
                    isDirectory={file.isDirectory}
                    onExport={onExport}
                    onRevealInExplorer={onRevealInExplorer}
                    onDelete={onDelete}
                    onClose={handleCloseMenu}
                />
            )}
        </>
    );
}
