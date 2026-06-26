import type { SettingsTab } from '@components/settings/SettingsModal';

export const OPEN_SETTINGS_EVENT = 'agentvis:onboarding-open-settings';
export const OPEN_HUB_CREATE_EVENT = 'agentvis:onboarding-open-hub-create';
export const OPEN_AGENT_CREATE_EVENT = 'agentvis:onboarding-open-agent-create';
export const SETUP_STATUS_CHANGED_EVENT = 'agentvis:onboarding-status-changed';

export type OnboardingSettingsTab = Extract<SettingsTab, 'apiKeys' | 'cloudService'>;

export function openSettingsTab(tab: OnboardingSettingsTab): void {
    window.dispatchEvent(new CustomEvent<{ tab: OnboardingSettingsTab }>(
        OPEN_SETTINGS_EVENT,
        { detail: { tab } }
    ));
}

export function openHubCreate(): void {
    window.dispatchEvent(new Event(OPEN_HUB_CREATE_EVENT));
}

export function openAgentCreate(): void {
    window.dispatchEvent(new Event(OPEN_AGENT_CREATE_EVENT));
}

export function notifySetupStatusChanged(): void {
    window.dispatchEvent(new Event(SETUP_STATUS_CHANGED_EVENT));
}
