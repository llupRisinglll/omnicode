import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	getShowWorkingIndicator,
	resetPreferencesCache,
	updateShowWorkingIndicator,
} from './preferences';
import type {UserPreferences} from '@/types/index';

console.log('\nshow-working-indicator.spec.ts');

// Isolate the config directory so tests never touch the user's real prefs.
const testConfigDir = join(
	tmpdir(),
	`nanocoder-show-working-indicator-test-${Date.now()}`,
);

const getTestPreferencesPath = () =>
	join(testConfigDir, 'nanocoder-preferences.json');

test.before(() => {
	process.env.NANOCODER_CONFIG_DIR = testConfigDir;
	mkdirSync(testConfigDir, {recursive: true});
	resetPreferencesCache();
});

test.after.always(() => {
	if (existsSync(testConfigDir)) {
		rmSync(testConfigDir, {recursive: true, force: true});
	}
	delete process.env.NANOCODER_CONFIG_DIR;
	resetPreferencesCache();
});

test.serial(
	'getShowWorkingIndicator defaults to false when not set',
	t => {
		const preferencesPath = getTestPreferencesPath();
		writeFileSync(
			preferencesPath,
			JSON.stringify({lastProvider: 'test'}, null, 2),
			'utf-8',
		);

		try {
			t.is(getShowWorkingIndicator(), false);
		} finally {
			if (existsSync(preferencesPath)) {
				rmSync(preferencesPath, {force: true});
			}
		}
	},
);

test.serial(
	'getShowWorkingIndicator defaults to false when file is absent',
	t => {
		const preferencesPath = getTestPreferencesPath();
		if (existsSync(preferencesPath)) {
			rmSync(preferencesPath, {force: true});
		}

		t.is(getShowWorkingIndicator(), false);
	},
);

test.serial('getShowWorkingIndicator returns stored true value', t => {
	const preferencesPath = getTestPreferencesPath();
	const data: UserPreferences = {showWorkingIndicator: true};
	writeFileSync(preferencesPath, JSON.stringify(data, null, 2), 'utf-8');

	try {
		t.is(getShowWorkingIndicator(), true);
	} finally {
		if (existsSync(preferencesPath)) {
			rmSync(preferencesPath, {force: true});
		}
	}
});

test.serial('updateShowWorkingIndicator persists true to disk', t => {
	const preferencesPath = getTestPreferencesPath();
	if (existsSync(preferencesPath)) {
		rmSync(preferencesPath, {force: true});
	}

	try {
		updateShowWorkingIndicator(true);

		t.true(existsSync(preferencesPath));
		const parsed = JSON.parse(
			readFileSync(preferencesPath, 'utf-8'),
		) as UserPreferences;
		t.is(parsed.showWorkingIndicator, true);
	} finally {
		if (existsSync(preferencesPath)) {
			rmSync(preferencesPath, {force: true});
		}
	}
});

test.serial(
	'updateShowWorkingIndicator preserves unrelated preferences',
	t => {
		const preferencesPath = getTestPreferencesPath();
		const existing: UserPreferences = {
			lastProvider: 'openrouter',
			selectedTheme: 'tokyo-night',
		};
		writeFileSync(
			preferencesPath,
			JSON.stringify(existing, null, 2),
			'utf-8',
		);

		try {
			updateShowWorkingIndicator(true);

			const parsed = JSON.parse(
				readFileSync(preferencesPath, 'utf-8'),
			) as UserPreferences;
			t.is(parsed.lastProvider, 'openrouter');
			t.is(parsed.selectedTheme, 'tokyo-night');
			t.is(parsed.showWorkingIndicator, true);
		} finally {
			if (existsSync(preferencesPath)) {
				rmSync(preferencesPath, {force: true});
			}
		}
	},
);

test.serial(
	'full round-trip: update then read back both states',
	t => {
		const preferencesPath = getTestPreferencesPath();
		if (existsSync(preferencesPath)) {
			rmSync(preferencesPath, {force: true});
		}

		try {
			updateShowWorkingIndicator(true);
			t.is(getShowWorkingIndicator(), true);

			updateShowWorkingIndicator(false);
			t.is(getShowWorkingIndicator(), false);
		} finally {
			if (existsSync(preferencesPath)) {
				rmSync(preferencesPath, {force: true});
			}
		}
	},
);
