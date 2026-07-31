import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {useTheme} from '@/hooks/useTheme';
import type {Task} from '@/tools/tasks/types';

interface TaskListDisplayProps {
	tasks: Task[];
	title?: string;
}

const STATUS_ICONS: Record<Task['status'], string> = {
	pending: '○',
	in_progress: '◐',
	completed: '✓',
};

/**
 * Build stats suffix: "(N completed, M in progress, K open)"
 */
function statsSuffix(tasks: Task[]): string {
	const total = tasks.length;
	const done = tasks.filter(t => t.status === 'completed').length;
	const inProgress = tasks.filter(t => t.status === 'in_progress').length;
	const open = tasks.filter(t => t.status === 'pending').length;
	if (total === 0) return '';
	return ` (${done} done, ${inProgress} in progress, ${open} open)`;
}

export function TaskListDisplay({
	tasks,
	title = 'Tasks',
}: TaskListDisplayProps) {
	const {colors} = useTheme();

	if (tasks.length === 0) {
		return (
			<Box flexDirection="column" marginY={1}>
				<Text color={colors.secondary}>
					No tasks found. Create one with write_tasks.
				</Text>
			</Box>
		);
	}

	const active = tasks.find(t => t.status === 'in_progress');
	const suffix = statsSuffix(tasks);

	const getStatusColor = (status: Task['status']): string => {
		switch (status) {
			case 'completed':
				return colors.success;
			case 'in_progress':
				return colors.warning;
			default:
				return colors.secondary;
		}
	};

	return (
		<Box flexDirection="column" marginY={1}>
			<Box marginBottom={0}>
				<Text color={colors.primary} bold>
					{active ? (
						<>
							{active.title}
							<Spinner type="simpleDots" />
							<Text color={colors.secondary}>{suffix}</Text>
						</>
					) : (
						<>tasks{suffix}</>
					)}
				</Text>
			</Box>
			{tasks.map((task, index) => (
				<Box key={task.id} flexDirection="row" marginLeft={1}>
					<Box width={2}>
						<Text color={getStatusColor(task.status)}>
							{STATUS_ICONS[task.status]}
						</Text>
					</Box>
					<Box width={3}>
						<Text color={colors.secondary}>{index + 1}.</Text>
					</Box>
					<Box flexShrink={1}>
						<Text
							wrap="truncate-end"
							color={
								task.status === 'completed' ? colors.secondary : colors.text
							}
							strikethrough={task.status === 'completed'}
						>
							{task.title}
						</Text>
					</Box>
				</Box>
			))}
		</Box>
	);
}
