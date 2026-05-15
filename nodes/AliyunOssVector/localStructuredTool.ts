import type { z } from 'zod';

/**
 * Minimal StructuredTool-compatible object for n8n AI Agent without importing
 * `@langchain/core/tools` (required for verified community package scan).
 */
export class LocalDynamicStructuredTool<T extends z.ZodObject<z.ZodRawShape>> {
	readonly lc_namespace = ['langchain', 'tools'] as const;
	lc_serializable = false;
	readonly returnDirect = false;

	name: string;
	description: string;
	schema: T;
	private readonly run: (args: z.infer<T>) => Promise<string>;

	constructor(config: {
		name: string;
		description: string;
		schema: T;
		func: (args: z.infer<T>) => Promise<string>;
	}) {
		this.name = config.name;
		this.description = config.description;
		this.schema = config.schema;
		this.run = config.func;
	}

	async invoke(input: unknown): Promise<string> {
		const args = this.schema.parse(input) as z.infer<T>;
		return this.run(args);
	}

	/** LangChain / older callers */
	async call(input: unknown): Promise<string> {
		return this.invoke(input);
	}
}
