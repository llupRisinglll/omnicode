import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';

type ReportReproductionArgs = {
	status: 'reproduced' | 'blocked';
	steps: string[];
	expected: string;
	actual?: string;
	blocker?: string;
};

const executeReportReproduction = async (
	args: ReportReproductionArgs,
): Promise<string> => {
	if (args.status === 'reproduced') {
		if (!args.actual?.trim()) {
			return 'Error: actual is required when status is reproduced.';
		}
		return [
			'REPRODUCTION_RECORDED',
			`Expected: ${args.expected}`,
			`Actual: ${args.actual}`,
			`Steps: ${args.steps.join(' -> ')}`,
		].join('\n');
	}

	if (!args.blocker?.trim()) {
		return 'Error: blocker is required when status is blocked.';
	}
	return [
		'REPRODUCTION_BLOCKED',
		`Blocker: ${args.blocker}`,
		`Attempted steps: ${args.steps.join(' -> ')}`,
	].join('\n');
};

const reportReproductionCoreTool = tool({
	description:
		'Record evidence from an attempted bug reproduction. Call this only after exercising the reported flow through the product. Use reproduced with concrete expected and actual behavior, or blocked with the exact blocker. Navigation or login alone is not reproduction.',
	inputSchema: jsonSchema<ReportReproductionArgs>({
		type: 'object',
		properties: {
			status: {
				type: 'string',
				enum: ['reproduced', 'blocked'],
				description:
					'Whether the reported failure was observed or reproduction is blocked.',
			},
			steps: {
				type: 'array',
				items: {type: 'string'},
				minItems: 1,
				description: 'Product actions actually performed, in order.',
			},
			expected: {
				type: 'string',
				description: 'Expected product behavior from the bug report.',
			},
			actual: {
				type: 'string',
				description: 'Concrete behavior observed in the running product.',
			},
			blocker: {
				type: 'string',
				description: 'Exact reason the flow could not be exercised.',
			},
		},
		required: ['status', 'steps', 'expected'],
	}),
	execute: executeReportReproduction,
});

export const reportReproductionTool: NanocoderToolExport = {
	name: 'report_reproduction',
	tool: reportReproductionCoreTool,
	readOnly: true,
	approval: false,
};
