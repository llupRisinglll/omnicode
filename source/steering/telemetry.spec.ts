import test from 'ava';
import {
	EMPTY_STEERING_RULE_TELEMETRY,
	getSteeringRuleTelemetry,
	getSteeringTelemetrySnapshot,
	recordSteeringAction,
	recordSteeringConditionMatch,
	recordSteeringRecovery,
	resetSteeringTelemetry,
	subscribeSteeringTelemetry,
} from './telemetry';

test.beforeEach(() => {
	resetSteeringTelemetry();
});

test('tracks average recovery time', t => {
	recordSteeringRecovery('recovery-rule', 1000);
	recordSteeringRecovery('recovery-rule', 3000);
	const telemetry = getSteeringRuleTelemetry('recovery-rule');
	t.is(telemetry.recoveries, 2);
	t.is(telemetry.averageRecoveryMs, 2000);
});

test('records matches, action counters, fires, and last activation per rule', t => {
	recordSteeringConditionMatch('runtime-supervision');
	recordSteeringConditionMatch('runtime-supervision');
	recordSteeringAction('runtime-supervision', 'noop');
	recordSteeringAction(
		'runtime-supervision',
		'inject',
		'2026-07-30T02:00:00.000Z',
	);
	recordSteeringAction(
		'runtime-supervision',
		'block',
		'2026-07-30T02:01:00.000Z',
	);
	recordSteeringAction(
		'runtime-supervision',
		'stop',
		'2026-07-30T02:02:00.000Z',
	);

	t.deepEqual(getSteeringRuleTelemetry('runtime-supervision'), {
		conditionMatches: 2,
		fires: 3,
		actions: {noop: 1, inject: 1, block: 1, stop: 1},
		lastActivation: '2026-07-30T02:02:00.000Z',
		recoveries: 0,
		averageRecoveryMs: null,
		totalRecoveryMs: 0,
	});
	t.is(
		getSteeringRuleTelemetry('other-rule'),
		EMPTY_STEERING_RULE_TELEMETRY,
	);
});

test('publishes immutable snapshots and supports per-rule reset', t => {
	let notifications = 0;
	const unsubscribe = subscribeSteeringTelemetry(() => {
		notifications += 1;
	});

	const initial = getSteeringTelemetrySnapshot();
	recordSteeringConditionMatch('first');
	const afterFirst = getSteeringTelemetrySnapshot();
	recordSteeringAction('second', 'inject', 0);

	t.not(initial, afterFirst);
	t.is(afterFirst.first?.conditionMatches, 1);
	t.false('second' in afterFirst);
	t.is(notifications, 2);

	resetSteeringTelemetry('first');
	t.false('first' in getSteeringTelemetrySnapshot());
	t.true('second' in getSteeringTelemetrySnapshot());
	t.is(notifications, 3);

	unsubscribe();
	recordSteeringConditionMatch('second');
	t.is(notifications, 3);
});

test('noop does not replace the last activation timestamp', t => {
	recordSteeringAction('rule', 'inject', '2026-07-30T02:00:00.000Z');
	recordSteeringAction('rule', 'noop', '2026-07-30T03:00:00.000Z');

	t.is(
		getSteeringRuleTelemetry('rule').lastActivation,
		'2026-07-30T02:00:00.000Z',
	);
});
