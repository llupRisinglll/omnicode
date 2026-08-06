import test from 'ava';
import type {Colors} from '../types/markdown-parser';
import {parseMarkdownTable} from './table-parser';

console.log(`\ntable-parser.spec.ts`);

const mockColors: Colors = {
	primary: '#3b82f6',
	secondary: '#6b7280',
	success: '#10b981',
	error: '#ef4444',
	warning: '#f59e0b',
	info: '#3b82f6',
	text: '#ffffff',
	tool: '#8b5cf6',
};

test('parseMarkdownTable handles simple two-column table', t => {
	const table = `| Name | Age |
|------|-----|
| John | 25  |
| Jane | 30  |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('Name'));
	t.true(result.includes('Age'));
	t.true(result.includes('John'));
	t.true(result.includes('Jane'));
	t.true(result.includes('25'));
	t.true(result.includes('30'));
});

test('parseMarkdownTable fits content instead of stretching to full width', t => {
	const table = `| Name | Age |
|------|-----|
| John | 25  |
| Jane | 30  |`;
	const result = parseMarkdownTable(table, mockColors, 80);
	const borderLines = result
		.split('\n')
		.filter(line => line.includes('─'));
	t.true(borderLines.length > 0);
	const maxLine = Math.max(
		...result.split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, '').length),
	);
	// Content columns are 4 + 3 wide (+ 2 padding each + 3 borders) — the
	// table must NOT span the full 80-column width.
	t.true(maxLine < 30, `expected a compact table, got ${maxLine} columns`);
});

test('parseMarkdownTable wraps long cells when content exceeds the width', t => {
	const table = `| A | B |
|---|--:|
| Short | ${'x'.repeat(40)} |
| Longer content | short |`;
	const result = parseMarkdownTable(table, mockColors, 50);
	const cleanLines = result
		.split('\n')
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
	const maxLine = Math.max(...cleanLines.map(line => line.length));
	// 50 - 3 borders - 4 padding = 43 content columns; rows must wrap, never
	// overflow the terminal width.
	t.true(maxLine <= 50, `table overflowed: ${maxLine} columns`);
});

test('parseMarkdownTable handles table with varying cell lengths', t => {
	const table = `| Short | Very Long Column Name |
|-------|----------------------|
| A     | This is a much longer text |
| B     | Short |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('Short'));
	t.true(result.includes('Very Long Column Name'));
	t.true(result.includes('This is a much longer text'));
});

test('parseMarkdownTable returns original text for invalid table', t => {
	const table = `Not a table at all`;
	const result = parseMarkdownTable(table, mockColors);
	t.is(result, table);
});

test('parseMarkdownTable returns original text for table without data rows', t => {
	const table = `| Name | Age |
|------|-----|`;
	const result = parseMarkdownTable(table, mockColors);
	t.is(result, table);
});

test('parseMarkdownTable handles table with empty cells', t => {
	const table = `| Name | Age |
|------|-----|
| John |     |
|      | 30  |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('John'));
	t.true(result.includes('30'));
});

test('parseMarkdownTable normalizes column count', t => {
	const table = `| A | B | C |
|---|---|---|
| 1 | 2 |
| 3 | 4 | 5 | 6 |`;
	const result = parseMarkdownTable(table, mockColors);
	// Should handle mismatched columns gracefully
	t.true(typeof result === 'string');
	t.true(result.length > 0);
});

test('parseMarkdownTable strips markdown from cells', t => {
	const table = `| Command | Description |
|---------|-------------|
| \`npm install\` | Install **dependencies** |
| \`npm start\` | Start the *application* |`;
	const result = parseMarkdownTable(table, mockColors);
	// Should have plain text (backticks and formatting removed)
	t.true(result.includes('npm install'));
	t.true(result.includes('npm start'));
	t.true(result.includes('dependencies'));
	t.true(result.includes('application'));
	// Should NOT have markdown syntax
	t.false(result.includes('`npm install`'));
	t.false(result.includes('**dependencies**'));
	t.false(result.includes('*application*'));
});

test('parseMarkdownTable strips HTML from cells', t => {
	const table = `| Name | Description |
|------|-------------|
| Test | Text with <br> tag |
| Another | Text with <b>bold</b> |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('Text with  tag')); // HTML tag removed
	t.true(result.includes('Text with bold')); // HTML tags removed
	t.false(result.includes('<br>'));
	t.false(result.includes('<b>'));
});

test('parseMarkdownTable handles links in cells', t => {
	const table = `| Name | Link |
|------|------|
| Google | [Visit](https://google.com) |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('Visit'));
	t.false(result.includes('[Visit]'));
	t.false(result.includes('(https://google.com)'));
});

test('parseMarkdownTable handles alignment markers', t => {
	const table = `| Left | Center | Right |
|:-----|:------:|------:|
| A    | B      | C     |`;
	const result = parseMarkdownTable(table, mockColors);
	t.true(result.includes('Left'));
	t.true(result.includes('Center'));
	t.true(result.includes('Right'));
});

test('parseMarkdownTable creates table with borders', t => {
	const table = `| A | B |
|---|---|
| 1 | 2 |`;
	const result = parseMarkdownTable(table, mockColors);
	// Should contain table border characters
	t.true(result.includes('─') || result.includes('│'));
});
