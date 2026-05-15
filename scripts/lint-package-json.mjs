/**
 * 使用 ESLint 程序化 API 检查根目录 package.json（与 n8n Community 插件中
 * valid-peer-dependencies / no-runtime-dependencies 等规则一致）。
 */
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import pluginPkg from '@n8n/eslint-plugin-community-nodes';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const eslint = new ESLint({
	cwd: root,
	allowInlineConfig: false,
	overrideConfigFile: true,
	overrideConfig: defineConfig(pluginPkg.configs.recommended),
});

const results = await eslint.lintFiles([join(root, 'package.json')]);
const errCount = results.reduce((n, r) => n + r.errorCount + r.fatalErrorCount, 0);
if (errCount > 0) {
	const formatter = await eslint.loadFormatter('stylish');
	process.stdout.write(await formatter.format(results));
	process.exit(1);
}
