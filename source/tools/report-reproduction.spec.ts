import test from 'ava';
import {reportReproductionTool} from './report-reproduction.js';

const context = {toolCallId: 'test', messages: []};

test('report_reproduction records concrete observed behavior', async t => {
	const result = await reportReproductionTool.tool.execute!(
		{
			status: 'reproduced',
			steps: ['replace 4-hour line', 'void old line'],
			expected: '8-hour line remains Active',
			actual: '8-hour line disappears',
		},
		context,
	);
	t.regex(String(result), /REPRODUCTION_RECORDED/);
	t.regex(String(result), /8-hour line disappears/);
});

test('report_reproduction rejects an evidence-free reproduced claim', async t => {
	const result = await reportReproductionTool.tool.execute!(
		{
			status: 'reproduced',
			steps: ['open page'],
			expected: 'failure',
		},
		context,
	);
	t.regex(String(result), /^Error: actual is required/);
});
