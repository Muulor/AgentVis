import { create } from 'zustand';
import type {
  NetworkDirectAllowance,
  NetworkDirectAllowanceScope,
  NetworkDirectAuthorizationRequest,
  NetworkDirectSubjectType,
} from '@/types/networkDirectAuthorization';
import {
  hasMetadataNetworkDirectTarget,
  hasPrivateNetworkDirectTarget,
} from '@utils/networkDirectRisk';

interface PendingNetworkDirectAuthorization {
  request: NetworkDirectAuthorizationRequest;
  resolve: (allowances: NetworkDirectAllowance[] | null) => void;
}

interface NetworkDirectAuthorizationState {
  pending: PendingNetworkDirectAuthorization | null;
  sessionAllowances: NetworkDirectAllowance[];
  requestAuthorization: (
    request: NetworkDirectAuthorizationRequest
  ) => Promise<NetworkDirectAllowance[] | null>;
  approvePending: (scope: NetworkDirectAllowanceScope) => void;
  denyPending: () => void;
  activeAllowancesForSubject: (
    subjectType: NetworkDirectSubjectType,
    subjectId?: string
  ) => NetworkDirectAllowance[];
}

function createAllowanceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `direct-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function allowanceExpiry(scope: NetworkDirectAllowanceScope, createdAt: number): number {
  const minutes = scope === 'session' ? 12 * 60 : 15;
  return createdAt + minutes * 60_000;
}

function buildAllowances(
  request: NetworkDirectAuthorizationRequest,
  scope: NetworkDirectAllowanceScope
): NetworkDirectAllowance[] {
  if (hasMetadataNetworkDirectTarget(request.targets)) {
    return [];
  }
  const createdAt = Date.now();
  const effectiveScope =
    scope === 'session' && hasPrivateNetworkDirectTarget(request.targets)
      ? 'currentExecution'
      : scope;
  return request.targets.map((target) => ({
    id: createAllowanceId(),
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    scope: effectiveScope,
    expiresAt: allowanceExpiry(effectiveScope, createdAt),
    createdAt,
    reason: request.reasonCode,
  }));
}

function isActiveAllowance(allowance: NetworkDirectAllowance): boolean {
  return allowance.expiresAt === undefined || allowance.expiresAt > Date.now();
}

export const useNetworkDirectAuthorizationStore = create<NetworkDirectAuthorizationState>(
  (set, get) => ({
    pending: null,
    sessionAllowances: [],

    requestAuthorization: (request) =>
      new Promise((resolve) => {
        const current = get().pending;
        if (current) {
          resolve(null);
          return;
        }
        set({ pending: { request, resolve } });
      }),

    approvePending: (scope) => {
      const pending = get().pending;
      if (!pending) return;
      const allowances = buildAllowances(pending.request, scope);
      set((state) => ({
        pending: null,
        sessionAllowances: allowances.some((allowance) => allowance.scope === 'session')
          ? [...state.sessionAllowances.filter(isActiveAllowance), ...allowances]
          : state.sessionAllowances.filter(isActiveAllowance),
      }));
      pending.resolve(allowances);
    },

    denyPending: () => {
      const pending = get().pending;
      if (!pending) return;
      set({ pending: null });
      pending.resolve(null);
    },

    activeAllowancesForSubject: (subjectType, subjectId) => {
      const active = get().sessionAllowances.filter(
        (allowance) =>
          isActiveAllowance(allowance) &&
          allowance.subjectType === subjectType &&
          allowance.subjectId === subjectId
      );
      if (active.length !== get().sessionAllowances.length) {
        set({ sessionAllowances: get().sessionAllowances.filter(isActiveAllowance) });
      }
      return active;
    },
  })
);

export function requestNetworkDirectAuthorization(
  request: NetworkDirectAuthorizationRequest
): Promise<NetworkDirectAllowance[] | null> {
  return useNetworkDirectAuthorizationStore.getState().requestAuthorization(request);
}

export function activeNetworkDirectAllowancesForSubject(
  subjectType: NetworkDirectSubjectType,
  subjectId?: string
): NetworkDirectAllowance[] {
  return useNetworkDirectAuthorizationStore
    .getState()
    .activeAllowancesForSubject(subjectType, subjectId);
}
