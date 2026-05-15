import { defineConfig } from 'eslint/config';
import pluginPkg from '@n8n/eslint-plugin-community-nodes';

const rec = pluginPkg.configs.recommended;

/**
 * 与 `npx @n8n/scan-community-package` 对 **dist 内 JS** 的校验一致：recommended + no-console。
 * `package.json` 由 `scripts/lint-package-json.mjs` 单独跑（ESLint API 对 JSON 的解析与 CLI 扁平配置一致）。
 */
export default defineConfig(
	{
		ignores: [
			'node_modules/**',
			'nodes/**',
			'credentials/**',
			'eslint.config.mjs',
			'scripts/**',
			'package.json',
			'package-lock.json',
			'dist/**/*.map',
			'dist/**/*.d.ts',
		],
	},
	{
		files: ['dist/**/*.js'],
		...rec,
		rules: {
			...rec.rules,
			'no-console': 'error',
		},
	},
);
