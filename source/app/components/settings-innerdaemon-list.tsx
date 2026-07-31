import {basename} from 'node:path';
import {Box, Text, useInput} from 'ink';
import {useState, useSyncExternalStore} from 'react';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {useResponsiveTerminal, useTerminalRows} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {
	EMPTY_STEERING_RULE_TELEMETRY,
	getSteeringTelemetrySnapshot,
	type SteeringRuleTelemetry,
	subscribeSteeringTelemetry,
} from '@/steering/telemetry';
import type {SteeringRule} from '@/steering/types';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';

export function SettingsInnerDaemonListPanel({
	rules,
	onBack,
}: {
	rules: SteeringRule[];
	onBack: () => void;
	onCancel: () => void;
}) {
	const {colors} = useTheme();
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const terminalRows = useTerminalRows();
	const telemetry = useSyncExternalStore(
		subscribeSteeringTelemetry,
		getSteeringTelemetrySnapshot,
		getSteeringTelemetrySnapshot,
	);
	const visibleCount = Math.max(1, terminalRows - 10);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [selectedRule, setSelectedRule] = useState<SteeringRule | null>(null);
	const [detailOffset, setDetailOffset] = useState(0);

	useInput((_, key) => {
		if (selectedRule) {
			if (key.escape || (key.shift && key.tab)) {
				setSelectedRule(null);
				setDetailOffset(0);
				return;
			}
			const detailLines = getDetailLines(
				selectedRule,
				telemetry[selectedRule.id] ?? EMPTY_STEERING_RULE_TELEMETRY,
				boxWidth,
			);
			const maxOffset = Math.max(0, detailLines.length - visibleCount);
			if (key.upArrow) {
				setDetailOffset(offset => Math.max(0, offset - 1));
			}
			if (key.downArrow) {
				setDetailOffset(offset => Math.min(maxOffset, offset + 1));
			}
			return;
		}
		if (key.escape || (key.shift && key.tab)) {
			onBack();
			return;
		}
		if (rules.length === 0) return;
		if (key.upArrow) {
			setSelectedIndex(index => (index > 0 ? index - 1 : rules.length - 1));
		}
		if (key.downArrow) {
			setSelectedIndex(index => (index + 1) % rules.length);
		}
		if (key.return) {
			setSelectedRule(rules[selectedIndex] ?? null);
			setDetailOffset(0);
		}
	});

	const start = Math.max(
		0,
		Math.min(
			selectedIndex - visibleCount + 1,
			Math.max(0, rules.length - visibleCount),
		),
	);
	const visibleRules = rules.slice(start, start + visibleCount);

	if (selectedRule) {
		const detailLines = getDetailLines(
			selectedRule,
			telemetry[selectedRule.id] ?? EMPTY_STEERING_RULE_TELEMETRY,
			boxWidth,
		);
		const visibleDetail = detailLines.slice(
			detailOffset,
			detailOffset + visibleCount,
		);
		return (
			<TitledBoxWithPreferences
				title={`Steering · ${selectedRule.id}`}
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				{visibleDetail.map((line, index) => (
					<Text key={`${detailOffset + index}-${line}`} color={colors.text}>
						{line || ' '}
					</Text>
				))}
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						{detailLines.length > visibleCount
							? `↑↓ scroll · ${detailOffset + 1}-${Math.min(
									detailOffset + visibleCount,
									detailLines.length,
								)} of ${detailLines.length} · `
							: ''}
						Esc back
					</Text>
				</Box>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Settings · Steering Rules"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Box marginBottom={rules.length > 0 ? 1 : 0}>
				<Text color={colors.secondary}>
					{rules.length} steering rule{rules.length === 1 ? '' : 's'} loaded for
					this session.
				</Text>
			</Box>
			{rules.length === 0 ? (
				<Text color={colors.secondary}>No steering rules are loaded.</Text>
			) : (
				visibleRules.map((rule, visibleIndex) => {
					const index = start + visibleIndex;
					const selected = index === selectedIndex;
					const source = rule.source ? basename(rule.source) : 'session';
					const stats = telemetry[rule.id] ?? EMPTY_STEERING_RULE_TELEMETRY;
					return (
						<Box key={`${rule.id}-${source}`} flexDirection="column">
							<Box>
								<Box minWidth={2}>
									<Text color={selected ? colors.primary : 'transparent'}>
										{selected ? '❯' : ' '}
									</Text>
								</Box>
								<Text
									bold={selected}
									color={selected ? colors.info : colors.text}
								>
									{rule.id}
								</Text>
								<Text color={colors.secondary}>
									{' '}
									· {rule.mode} · {source}
								</Text>
							</Box>
							{rule.description && (
								<Box marginLeft={2}>
									<Text color={colors.secondary} wrap="truncate-end">
										{rule.description}
									</Text>
								</Box>
							)}
							<Box marginLeft={2}>
								<Text color={colors.secondary}>
									{formatTelemetrySummary(stats)}
								</Text>
							</Box>
						</Box>
					);
				})
			)}
			{rules.length > visibleCount && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						{start + 1}-{Math.min(start + visibleCount, rules.length)} of{' '}
						{rules.length}
					</Text>
				</Box>
			)}
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						↑↓ navigate · Enter details · Esc back
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

function getDetailLines(
	rule: SteeringRule,
	telemetry: SteeringRuleTelemetry,
	boxWidth: number,
): string[] {
	const metadata = [
		`Description: ${rule.description ?? 'No description'}`,
		`Source: ${rule.source ?? 'session'}`,
		`Mode: ${rule.mode}`,
		`Priority: ${rule.priority ?? 0}`,
		`Max fires: ${rule.maxFires ?? 'default'}`,
		`On exhaustion: ${rule.onExhaustion ?? 'dormant'}`,
		`Cooldown turns: ${rule.cooldownTurns ?? 'default'}`,
		rule.condition
			? `Condition: ${JSON.stringify(rule.condition, null, 2)}`
			: 'Condition: none',
		rule.watch
			? `Watch: ${JSON.stringify(rule.watch, null, 2)}`
			: 'Watch: none',
		'',
		'Session diagnostics:',
		`Condition matches: ${telemetry.conditionMatches}`,
		`Fires: ${telemetry.fires}`,
		`Actions: inject ${telemetry.actions.inject} · noop ${telemetry.actions.noop} · block ${telemetry.actions.block} · stop ${telemetry.actions.stop}`,
		`Recoveries: ${telemetry.recoveries} · average ${telemetry.averageRecoveryMs === null ? 'n/a' : `${Math.round(telemetry.averageRecoveryMs / 1000)}s`}`,
		`Last activation: ${telemetry.lastActivation ?? 'never'}`,
		'',
		'Context:',
		rule.body?.trim() || 'No additional context.',
	].join('\n');
	return wrapWithTrimmedContinuations(
		metadata,
		Math.max(20, boxWidth - 6),
	).split('\n');
}

function formatTelemetrySummary(telemetry: SteeringRuleTelemetry): string {
	return `matches ${telemetry.conditionMatches} · fires ${telemetry.fires} · noop ${telemetry.actions.noop} · block ${telemetry.actions.block} · stop ${telemetry.actions.stop}`;
}
