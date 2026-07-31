import type {SteeringAction} from '@/steering/types';

export type SteeringActionType = SteeringAction['type'];

export interface SteeringRuleTelemetry {
	conditionMatches: number;
	fires: number;
	actions: Readonly<Record<SteeringActionType, number>>;
	lastActivation: string | null;
	recoveries: number;
	averageRecoveryMs: number | null;
	totalRecoveryMs: number;
}

export type SteeringTelemetrySnapshot = Readonly<
	Record<string, SteeringRuleTelemetry>
>;

const EMPTY_ACTIONS: Readonly<Record<SteeringActionType, number>> =
	Object.freeze({
		noop: 0,
		inject: 0,
		block: 0,
		stop: 0,
	});

export const EMPTY_STEERING_RULE_TELEMETRY: SteeringRuleTelemetry =
	Object.freeze({
		conditionMatches: 0,
		fires: 0,
		actions: EMPTY_ACTIONS,
		lastActivation: null,
		recoveries: 0,
		averageRecoveryMs: null,
		totalRecoveryMs: 0,
	});

let snapshot: SteeringTelemetrySnapshot = Object.freeze({});
const listeners = new Set<() => void>();

export function getSteeringTelemetrySnapshot(): SteeringTelemetrySnapshot {
	return snapshot;
}

export function subscribeSteeringTelemetry(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSteeringRuleTelemetry(
	ruleId: string,
): SteeringRuleTelemetry {
	return snapshot[ruleId] ?? EMPTY_STEERING_RULE_TELEMETRY;
}

export function recordSteeringConditionMatch(ruleId: string): void {
	updateRule(ruleId, current => ({
		...current,
		conditionMatches: current.conditionMatches + 1,
	}));
}

export function recordSteeringAction(
	ruleId: string,
	action: SteeringActionType,
	activatedAt: Date | number | string = new Date(),
): void {
	updateRule(ruleId, current => {
		const fired = action !== 'noop';
		return {
			...current,
			fires: current.fires + (fired ? 1 : 0),
			actions: Object.freeze({
				...current.actions,
				[action]: current.actions[action] + 1,
			}),
			lastActivation: fired
				? normalizeActivationTime(activatedAt)
				: current.lastActivation,
		};
	});
}

export function recordSteeringRecovery(
	ruleId: string,
	durationMs: number,
): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) return;
	updateRule(ruleId, current => {
		const recoveries = current.recoveries + 1;
		const totalRecoveryMs = current.totalRecoveryMs + durationMs;
		return {
			...current,
			recoveries,
			totalRecoveryMs,
			averageRecoveryMs: totalRecoveryMs / recoveries,
		};
	});
}

export function resetSteeringTelemetry(ruleId?: string): void {
	if (ruleId === undefined) {
		if (Object.keys(snapshot).length === 0) return;
		snapshot = Object.freeze({});
		emitChange();
		return;
	}
	if (!(ruleId in snapshot)) return;
	const {[ruleId]: _, ...remaining} = snapshot;
	snapshot = Object.freeze(remaining);
	emitChange();
}

function updateRule(
	ruleId: string,
	update: (current: SteeringRuleTelemetry) => SteeringRuleTelemetry,
): void {
	const next = update(getSteeringRuleTelemetry(ruleId));
	snapshot = Object.freeze({
		...snapshot,
		[ruleId]: Object.freeze(next),
	});
	emitChange();
}

function normalizeActivationTime(value: Date | number | string): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function emitChange(): void {
	for (const listener of listeners) listener();
}
