import {useEffect, useState} from 'react';
import {type BashExecutionState, bashExecutor} from '@/services/bash-executor';

const getCount = (): number => bashExecutor.getActiveBackgroundCount();

export function useBackgroundTaskCount(): number {
	const [count, setCount] = useState(getCount);

	useEffect(() => {
		const update = (_state: BashExecutionState) => setCount(getCount());
		bashExecutor.on('start', update);
		bashExecutor.on('progress', update);
		bashExecutor.on('complete', update);
		return () => {
			bashExecutor.off('start', update);
			bashExecutor.off('progress', update);
			bashExecutor.off('complete', update);
		};
	}, []);

	return count;
}
