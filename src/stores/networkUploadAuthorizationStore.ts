import { create } from 'zustand';
import type { NetworkUploadAuthorizationRequest } from '@/types/networkUploadAuthorization';

interface PendingNetworkUploadAuthorization {
    request: NetworkUploadAuthorizationRequest;
    resolve: (confirmed: boolean) => void;
}

interface NetworkUploadAuthorizationState {
    pending: PendingNetworkUploadAuthorization | null;
    requestAuthorization: (request: NetworkUploadAuthorizationRequest) => Promise<boolean>;
    approvePending: () => void;
    denyPending: () => void;
}

export const useNetworkUploadAuthorizationStore = create<NetworkUploadAuthorizationState>((set, get) => ({
    pending: null,

    requestAuthorization: (request) => new Promise((resolve) => {
        const current = get().pending;
        if (current) {
            resolve(false);
            return;
        }
        set({ pending: { request, resolve } });
    }),

    approvePending: () => {
        const pending = get().pending;
        if (!pending) return;
        set({ pending: null });
        pending.resolve(true);
    },

    denyPending: () => {
        const pending = get().pending;
        if (!pending) return;
        set({ pending: null });
        pending.resolve(false);
    },
}));

export function requestNetworkUploadAuthorization(
    request: NetworkUploadAuthorizationRequest
): Promise<boolean> {
    return useNetworkUploadAuthorizationStore.getState().requestAuthorization(request);
}
