import { useAgentStore } from '@stores/agentStore';
import { HubChatView } from '@components/hub';
import { AgentChatView } from '@components/agent';
import { useSetupChecklistState } from '@components/onboarding/SetupChecklist';
import styles from './CenterPanel.module.css';

/**
 * CenterPanel 中栏对话区
 *
 * 根据当前选中状态显示 Hub 讨论区或 Agent 对话视图
 */
export function CenterPanel() {
    const currentAgentId = useAgentStore((state) => state.currentAgentId);
    const setupChecklistState = useSetupChecklistState();

    // 根据是否有选中的Agent来决定显示哪个视图
    // 如果有选中的Agent，显示AgentChatView
    // 否则显示HubChatView（Hub讨论区）
    const showAgentView = currentAgentId !== null;

    return (
        <div className={styles.centerPanel}>
            {showAgentView ? (
                <AgentChatView />
            ) : (
                <HubChatView setupChecklistState={setupChecklistState} />
            )}
        </div>
    );
}

