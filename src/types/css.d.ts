/**
 * CSS Modules 类型声明
 * 
 * 为 .module.css 文件提供具体的类型定义
 * 避免 noPropertyAccessFromIndexSignature 导致的编译错误
 */

// ==================== CenterPanel ====================
declare module '*/CenterPanel.module.css' {
    const styles: {
        readonly centerPanel: string;
        readonly header: string;
        readonly title: string;
        readonly subtitle: string;
        readonly chatArea: string;
        readonly placeholder: string;
        readonly inputArea: string;
        readonly inputWrapper: string;
        readonly input: string;
        readonly inputActions: string;
        readonly modeBtn: string;
        readonly sendBtn: string;
    };
    export default styles;
}

// ==================== LeftPanel ====================
declare module '*/LeftPanel.module.css' {
    const styles: {
        readonly leftPanel: string;
        readonly collapseBtn: string;
        readonly navItem: string;
        readonly navIcon: string;
        readonly navLabel: string;
        readonly divider: string;
        readonly agentList: string;
        readonly avatar: string;
        readonly addAgent: string;
    };
    export default styles;
}

// ==================== RightPanel ====================
declare module '*/RightPanel.module.css' {
    const styles: {
        readonly rightPanel: string;
        readonly header: string;
        readonly title: string;
        readonly closeBtn: string;
        readonly fileList: string;
        readonly fileItem: string;
        readonly fileName: string;
        readonly fileTime: string;
        readonly preview: string;
        readonly previewPlaceholder: string;
    };
    export default styles;
}

// ==================== Shell ====================
declare module '*/Shell.module.css' {
    const styles: {
        readonly shell: string;
        readonly main: string;
        readonly leftPanel: string;
        readonly centerPanel: string;
        readonly rightPanel: string;
        readonly leftCollapsed: string;
        readonly rightHidden: string;
    };
    export default styles;
}

// ==================== StatusBar ====================
declare module '*/StatusBar.module.css' {
    const styles: {
        readonly statusBar: string;
        readonly left: string;
        readonly right: string;
        readonly item: string;
        readonly dot: string;
        readonly success: string;
        readonly warning: string;
        readonly error: string;
    };
    export default styles;
}

// ==================== TopBar ====================
declare module '*/TopBar.module.css' {
    const styles: {
        readonly topBar: string;
        readonly left: string;
        readonly center: string;
        readonly right: string;
        readonly title: string;
        readonly searchInput: string;
        readonly iconBtn: string;
    };
    export default styles;
}

// ==================== UI Components ====================
declare module '*/Button.module.css' {
    const styles: {
        readonly button: string;
        readonly primary: string;
        readonly secondary: string;
        readonly ghost: string;
        readonly danger: string;
        readonly small: string;
        readonly medium: string;
        readonly large: string;
        readonly disabled: string;
        readonly loading: string;
    };
    export default styles;
}

declare module '*/Input.module.css' {
    const styles: {
        readonly input: string;
        readonly wrapper: string;
        readonly label: string;
        readonly error: string;
        readonly hint: string;
    };
    export default styles;
}

declare module '*/Modal.module.css' {
    const styles: {
        readonly overlay: string;
        readonly modal: string;
        readonly header: string;
        readonly title: string;
        readonly content: string;
        readonly footer: string;
        readonly closeBtn: string;
    };
    export default styles;
}

declare module '*/ResizeHandle.module.css' {
    const styles: {
        readonly handle: string;
        readonly vertical: string;
        readonly horizontal: string;
        readonly active: string;
    };
    export default styles;
}

declare module '*/Toast.module.css' {
    const styles: {
        readonly toast: string;
        readonly container: string;
        readonly success: string;
        readonly error: string;
        readonly warning: string;
        readonly info: string;
        readonly title: string;
        readonly message: string;
        readonly close: string;
    };
    export default styles;
}

// ==================== Fallback ====================
declare module '*.module.css' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}

declare module '*.css' {
    const content: string;
    export default content;
}
