import { DynamicStructuredTool } from '@langchain/core/tools';
import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { z } from 'zod';
import {
	OssVectorStore,
	type SimpleDocument,
	type EmbeddingsLike,
	type OssMetadataFilter,
} from './OssVectorStore';
import { credentialsDataToOssConfig, testOssVectorConnectivity } from './ossCredentialConfig';
import { OssConfig } from './ossSign';

async function getOssConfig(context: IExecuteFunctions | ISupplyDataFunctions): Promise<OssConfig> {
	const credentials = await context.getCredentials('aliyunOssVectorApi');
	try {
		return credentialsDataToOssConfig(credentials);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new NodeOperationError(context.getNode(), msg);
	}
}

/** Shape returned by n8n's documentDefaultDataLoader (N8nJsonLoader / N8nBinaryLoader). */
interface N8nDocumentLoader {
	processItem(
		item: INodeExecutionData,
		itemIndex: number,
	): Promise<Array<{ pageContent: string; metadata: Record<string, unknown> }>>;
}

/**
 * Keys merged onto tool execute input from the Agent parent item (see n8n `requests-response.ts`)
 * that must not count as the retrieval query when the model sends empty/wrong tool args.
 */
const QUERY_CONTEXT_NOISE_KEYS = new Set([
	'toolCallId',
	'tool_call_id',
	'toolParameters',
	'hitlParameters',
	'systemPrompt',
	'system_prompt',
	'messages',
	'sessionId',
	'session_id',
]);

/**
 * AI Agent forwards merged JSON into `retrieve-as-tool` execute(): parent item fields plus `toolInput`
 * plus `toolCallId`. If the model omits `input`/`query`, only noise keys may remain unless we filter them.
 */
function extractRetrieveToolQueryString(itemJson: IDataObject): string | undefined {
	function preferredKeysPick(data: IDataObject): string | undefined {
		const preferredKeys = [
			'input',
			'query',
			'question',
			'search_query',
			'searchQuery',
			'keyword',
			'keywords',
			'q',
			'text',
			'prompt',
			'search',
			'chatInput',
			'guardrailsInput',
			'userMessage',
			'content',
		];
		for (const key of preferredKeys) {
			const v = data[key];
			if (typeof v === 'string' && v.trim()) return v.trim();
			if (typeof v === 'number' && Number.isFinite(v)) return String(v);
		}
		const emptyKeyVal = data[''];
		if (typeof emptyKeyVal === 'string' && emptyKeyVal.trim()) return emptyKeyVal.trim();
		return undefined;
	}

	function tryParseToolArgumentsString(raw: unknown): string | undefined {
		if (typeof raw !== 'string') return undefined;
		const t = raw.trim();
		if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
		try {
			const parsed: unknown = JSON.parse(t);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return walk(parsed as IDataObject, 0);
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	function walk(data: IDataObject, depth: number): string | undefined {
		if (depth > 3) return undefined;

		const direct = preferredKeysPick(data);
		if (direct) return direct;

		const fromArgs =
			tryParseToolArgumentsString(data.arguments) ??
			tryParseToolArgumentsString((data as { tool_arguments?: unknown }).tool_arguments);
		if (fromArgs) return fromArgs;

		const entries = Object.entries(data).filter(([k]) => !QUERY_CONTEXT_NOISE_KEYS.has(k));
		const filtered: IDataObject = Object.fromEntries(entries);

		const afterNoise = preferredKeysPick(filtered);
		if (afterNoise) return afterNoise;

		const stringVals = entries
			.filter(([, v]) => typeof v === 'string' && (v as string).trim().length > 0)
			.map(([, v]) => (v as string).trim());
		if (stringVals.length === 1) return stringVals[0];

		if (depth < 3) {
			for (const [, v] of entries) {
				if (v && typeof v === 'object' && !Array.isArray(v)) {
					const nested = walk(v as IDataObject, depth + 1);
					if (nested) return nested;
				}
			}
		}

		return undefined;
	}

	return walk(itemJson, 0);
}

/** Parse OSS Vector metadata filter. Malformed JSON that looks like an object fails fast; garbage strings are ignored. */
function parseFilter(raw: unknown, errorNode: INode): OssMetadataFilter | undefined {
	if (raw === null || raw === undefined) return undefined;

	if (typeof raw === 'object' && !Array.isArray(raw)) {
		return Object.keys(raw).length > 0 ? (raw as OssMetadataFilter) : undefined;
	}

	if (typeof raw === 'string') {
		const s = raw.trim();
		if (!s || s === '{}') return undefined;
		try {
			const parsed: unknown = JSON.parse(s);
			if (Array.isArray(parsed)) {
				throw new NodeOperationError(errorNode, 'metadataFilter must be a JSON object, not an array.');
			}
			if (parsed && typeof parsed === 'object' && Object.keys(parsed as object).length > 0) {
				return parsed as OssMetadataFilter;
			}
			return undefined;
		} catch (e) {
			if (e instanceof NodeOperationError) throw e;
			if (s.startsWith('{') || s.startsWith('[')) {
				throw new NodeOperationError(
					errorNode,
					'Invalid metadataFilter JSON. Use a valid object or {} for no filter.',
				);
			}
			return undefined;
		}
	}

	return undefined;
}

/**
 * Flat metadata AND-match for ListVectors client-side filtering (field → string value).
 * Nested operators are not supported — use Query + metadataFilter for server-side OSS filters.
 */
function parseFlatMetadataMatch(raw: unknown, errorNode: INode): Record<string, string> {
	if (raw === null || raw === undefined) {
		return {};
	}

	let obj: Record<string, unknown>;
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		obj = raw as Record<string, unknown>;
	} else if (typeof raw === 'string') {
		const s = raw.trim();
		if (!s || s === '{}') {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(s);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new NodeOperationError(
					errorNode,
					'listMetadataMatch must be a JSON object with string values, e.g. {"category":"docs","docId":"42"}.',
				);
			}
			obj = parsed as Record<string, unknown>;
		} catch (e) {
			if (e instanceof NodeOperationError) throw e;
			if (s.startsWith('{') || s.startsWith('[')) {
				throw new NodeOperationError(errorNode, 'Invalid listMetadataMatch JSON.');
			}
			return {};
		}
	} else {
		return {};
	}

	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === null || v === undefined) continue;
		if (Array.isArray(v)) {
			out[k] = String(v[0]);
		} else if (typeof v === 'object') {
			throw new NodeOperationError(
				errorNode,
				`listMetadataMatch field "${k}" must be a string or string array, not an object.`,
			);
		} else {
			out[k] = String(v);
		}
	}
	return out;
}

type ScoredDoc = [SimpleDocument, number];

const DELETE_VECTORS_BATCH_SIZE = 100;
const DELETE_BATCH_PAUSE_MS = 120;

async function runOssSimilaritySearch(
	embeddingsInput: EmbeddingsLike,
	ossConfig: OssConfig,
	indexName: string,
	query: string,
	topK: number,
	filter: OssMetadataFilter | undefined,
): Promise<ScoredDoc[]> {
	const store = new OssVectorStore(embeddingsInput, { ...ossConfig, indexName });
	const embeddedQuery = await embeddingsInput.embedQuery(query);
	return store.similaritySearchVectorWithScore(embeddedQuery, topK, filter);
}

function scoredDocsToToolBlocks(
	docs: ScoredDoc[],
	includeMetadata: boolean,
): Array<{ type: 'text'; text: string }> {
	return docs.map(([doc]) => ({
		type: 'text' as const,
		text: includeMetadata
			? JSON.stringify({ pageContent: doc.pageContent, metadata: doc.metadata })
			: JSON.stringify({ pageContent: doc.pageContent }),
	}));
}

/** Returned as tool output text — wording discourages identical retries under Agent Max iterations. */
const EMPTY_RETRIEVAL_MESSAGE =
	'No relevant documents found for this query. Do not repeat the exact same query in a loop; rephrase once at most, otherwise answer from general context and state that retrieval was empty.';

function scoredDocsToLlmText(docs: ScoredDoc[], includeMetadata: boolean): string {
	if (docs.length === 0) return EMPTY_RETRIEVAL_MESSAGE;
	return docs
		.map(([doc]) =>
			includeMetadata
				? JSON.stringify({ pageContent: doc.pageContent, metadata: doc.metadata })
				: JSON.stringify({ pageContent: doc.pageContent }),
		)
		.join('\n\n---\n\n');
}

export class AliyunOssVector implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Aliyun OSS Vector Store',
		name: 'aliyunOssVector',
		icon: 'file:aliyun-oss.svg',
		group: ['transform'],
		version: 1,
		description: 'Store and retrieve vectors using Alibaba Cloud OSS Vector Bucket',
		defaults: {
			name: 'Aliyun OSS Vector Store',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Vector Stores'],
			},
		},
		// Dynamic inputs follow n8n official vector store node convention:
		//   insert  → Main + AiEmbedding (required) + AiDocument (required)
		//   retrieve → AiEmbedding (required)  [output is AiVectorStore]
		//   query / delete → Main + AiEmbedding (required for query only)
		//   deleteIndex → Main only
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: `={{ (() => {
			const op = $parameter["operation"];
			if (op === "insert") {
				return [
					{ type: "main" },
					{ type: "${NodeConnectionTypes.AiEmbedding}", required: true, displayName: "Embeddings", maxConnections: 1 },
					{ type: "${NodeConnectionTypes.AiDocument}", required: true, displayName: "Document", maxConnections: 1 }
				];
			}
			if (op === "retrieve" || op === "retrieve-as-tool") {
				return [
					{ type: "${NodeConnectionTypes.AiEmbedding}", required: true, displayName: "Embeddings", maxConnections: 1 }
				];
			}
			if (op === "query") {
				return [
					{ type: "main" },
					{ type: "${NodeConnectionTypes.AiEmbedding}", required: true, displayName: "Embeddings", maxConnections: 1 }
				];
			}
			return [{ type: "main" }];
		})() }}`,
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong-regular-node
		outputs: `={{ (() => {
			const op = $parameter["operation"];
			if (op === "retrieve") return [{ displayName: "Vector Store", type: "${NodeConnectionTypes.AiVectorStore}" }];
			if (op === "retrieve-as-tool") return [{ displayName: "Tool", type: "${NodeConnectionTypes.AiTool}" }];
			return [{ type: "main" }];
		})() }}`,
		credentials: [
			{
				name: 'aliyunOssVectorApi',
				required: true,
				testedBy: 'aliyunOssVectorApiCredentialTest',
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Insert',
						value: 'insert',
						description: 'Embed documents and write vectors to OSS index',
						action: 'Insert documents into the vector store',
					},
					{
						name: 'Retrieve (as Vector Store)',
						value: 'retrieve',
						description: 'Supply the vector store to a Vector Store Retriever node',
						action: 'Retrieve documents from the vector store',
					},
					{
						name: 'Retrieve (as Tool for AI Agent)',
						value: 'retrieve-as-tool',
						description: 'Use this vector store as a tool that AI Agent can call directly',
						action: 'Use as a tool for AI Agent',
					},
					{
						name: 'Query',
						value: 'query',
						description: 'Search for similar vectors and return results in main output',
						action: 'Query vectors with similarity search',
					},
					{
						name: 'Delete Vectors',
						value: 'delete',
						description: 'Delete specific vectors by key from an index',
						action: 'Delete vectors from the vector store',
					},
					{
						name: 'List Vectors',
						value: 'listVectors',
						description:
							'List vectors via OSS ListVectors (paginated). Optionally filter by flat metadata AND-match client-side; outputs keys for Delete Vectors.',
						action: 'List vector keys from the vector store',
					},
					{
						name: 'Delete Index',
						value: 'deleteIndex',
						description: 'Delete an entire vector index',
						action: 'Delete a vector index',
					},
				],
				default: 'insert',
			},
			{
				displayName: 'Index Name',
				name: 'indexName',
				type: 'string',
				default: '',
				required: true,
				description: 'OSS vector index name (must match the index in your bucket).',
				placeholder: 'my_vector_index',
			},
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: 'oss_vector_search',
				required: true,
				description:
					'Name of the tool (must be alphanumeric, underscores allowed). This is what the AI Agent uses to identify and call this tool.',
				placeholder: 'e.g. vector_knowledge_search',
				displayOptions: {
					show: {
						operation: ['retrieve-as-tool'],
					},
				},
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				default: 'Search the vector index and return the most relevant text chunks.',
				required: true,
				typeOptions: { rows: 3 },
				description:
					'Explain to the AI Agent what this tool does. A specific description helps the agent decide when and how to use it.',
				displayOptions: {
					show: {
						operation: ['retrieve-as-tool'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'topK',
				type: 'number',
				default: 4,
				description: 'Maximum number of results to return',
				displayOptions: {
					show: {
						operation: ['retrieve', 'retrieve-as-tool'],
					},
				},
			},
			{
				displayName: 'Include Metadata',
				name: 'includeDocumentMetadata',
				type: 'boolean',
				default: true,
				description:
					'When using retrieve-as-tool: include document metadata in each hit (page content is always included)',
				displayOptions: {
					show: {
						operation: ['retrieve-as-tool'],
					},
				},
			},
			{
				displayName: 'Metadata Filter',
				name: 'metadataFilter',
				type: 'json',
				default: '{}',
				// eslint-disable-next-line n8n-nodes-base/node-param-description-wrong-for-dynamic-options
				description:
					'Optional filter (OSS MongoDB-style operators). Invalid object-shaped JSON fails the node; stray text is ignored. Examples: {"docId":{"$eq":"abc"}}, {"$and":[{"docId":{"$eq":"abc"}}]}',
				displayOptions: {
					show: {
						operation: ['retrieve', 'retrieve-as-tool', 'query'],
					},
				},
			},
			{
				displayName: 'Query Text',
				name: 'queryText',
				type: 'string',
				default: '={{ $json.query }}',
				required: true,
				description: 'The query text to embed and search for',
				displayOptions: {
					show: {
						operation: ['query'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'topKQuery',
				type: 'number',
				default: 5,
				description: 'Maximum number of results to return',
				displayOptions: {
					show: {
						operation: ['query'],
					},
				},
			},
			// ── insert mode ──────────────────────────────────────────────────────
			{
				displayName: 'Auto Create Index',
				name: 'autoCreateIndex',
				type: 'boolean',
				default: true,
				description: 'Whether to automatically create the index if it does not exist',
				displayOptions: {
					show: {
						operation: ['insert'],
					},
				},
			},
			{
				displayName: 'Vector Dimension',
				name: 'dimension',
				type: 'number',
				default: 2560,
				description: 'Embedding dimension — must match the embedding model output and index setting',
				displayOptions: {
					show: {
						operation: ['insert'],
						autoCreateIndex: [true],
					},
				},
			},
			// ── delete mode ──────────────────────────────────────────────────────
			{
				displayName: 'Keys to Delete',
				name: 'deleteKeys',
				type: 'string',
				default: '={{ $json.keys }}',
				description:
					'Vector keys to delete: use an expression that returns a string[], or a comma-separated list of keys',
				displayOptions: {
					show: {
						operation: ['delete'],
					},
				},
			},
			// ── listVectors ─────────────────────────────────────────────────────
			{
				displayName: 'Max Results Per Page',
				name: 'listMaxResultsPerPage',
				type: 'number',
				default: 500,
				description:
					'ListVectors page size (1–1000 per OSS). Lower values reduce single-response size.',
				displayOptions: {
					show: {
						operation: ['listVectors'],
					},
				},
			},
			{
				displayName: 'Return Vector Data',
				name: 'listReturnData',
				type: 'boolean',
				default: false,
				description:
					'Whether to request float32 vectors from OSS (large). Keep false when only keys/metadata are needed.',
				displayOptions: {
					show: {
						operation: ['listVectors'],
					},
				},
			},
			{
				displayName: 'Return Metadata',
				name: 'listReturnMetadata',
				type: 'boolean',
				default: true,
				description: 'Whether to request metadata for each row (required for client-side matching).',
				displayOptions: {
					show: {
						operation: ['listVectors'],
					},
				},
			},
			{
				displayName: 'Metadata Match (flat AND)',
				name: 'listMetadataMatch',
				type: 'json',
				default: '{}',
				// eslint-disable-next-line n8n-nodes-base/node-param-description-wrong-for-dynamic-options
				description:
					'JSON object: only vectors whose metadata matches ALL fields (string equality; arrays in metadata match if any element equals) are included. Use expressions to map from upstream items. Empty {} lists every key in the index (paginated full scan — use with care on large indexes).',
				displayOptions: {
					show: {
						operation: ['listVectors'],
					},
				},
			},
		],
	};

	methods = {
		credentialTest: {
			async aliyunOssVectorApiCredentialTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				let ossConfig: OssConfig;
				try {
					ossConfig = credentialsDataToOssConfig(credential.data ?? {});
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { status: 'Error', message: msg };
				}
				const { ok, message } = await testOssVectorConnectivity(ossConfig);
				return ok ? { status: 'OK', message } : { status: 'Error', message };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		const indexName = this.getNodeParameter('indexName', 0) as string;
		const ossConfig = await getOssConfig(this);

		// ── deleteIndex ────────────────────────────────────────────────────────
		if (operation === 'deleteIndex') {
			const store = new OssVectorStore(
				{ embedDocuments: async () => [[]], embedQuery: async () => [] },
				{ ...ossConfig, indexName },
			);
			await store.deleteIndex();
			return [[{ json: { success: true, indexName, operation: 'deleteIndex' } }]];
		}

		// ── delete vectors ─────────────────────────────────────────────────────
		if (operation === 'delete') {
			const items = this.getInputData();
			const store = new OssVectorStore(
				{ embedDocuments: async () => [[]], embedQuery: async () => [] },
				{ ...ossConfig, indexName },
			);
			const results: INodeExecutionData[] = [];
			for (let i = 0; i < items.length; i++) {
				const keysRaw = this.getNodeParameter('deleteKeys', i);
				const keys: string[] = Array.isArray(keysRaw)
					? (keysRaw as string[])
					: String(keysRaw)
							.split(',')
							.map((k) => k.trim())
							.filter(Boolean);
				for (let off = 0; off < keys.length; off += DELETE_VECTORS_BATCH_SIZE) {
					const batch = keys.slice(off, off + DELETE_VECTORS_BATCH_SIZE);
					await store.deleteVectors(batch);
					if (off + DELETE_VECTORS_BATCH_SIZE < keys.length) {
						await new Promise((r) => setTimeout(r, DELETE_BATCH_PAUSE_MS));
					}
				}
				results.push({ json: { success: true, indexName, deletedKeys: keys } });
			}
			return [results];
		}

		// ── listVectors (ListVectors API + optional client-side metadata filter) ──
		if (operation === 'listVectors') {
			const items = this.getInputData();
			const out: INodeExecutionData[] = [];
			for (let i = 0; i < items.length; i++) {
				const idxName = this.getNodeParameter('indexName', i) as string;
				const pageSize = this.getNodeParameter('listMaxResultsPerPage', i) as number;
				const listReturnData = this.getNodeParameter('listReturnData', i) as boolean;
				const listReturnMetadata = this.getNodeParameter('listReturnMetadata', i) as boolean;
				const matchRaw = this.getNodeParameter('listMetadataMatch', i, '{}');
				const metadataMatch = parseFlatMetadataMatch(matchRaw, this.getNode());

				const store = new OssVectorStore(
					{ embedDocuments: async () => [[]], embedQuery: async () => [] },
					{ ...ossConfig, indexName: idxName },
				);
				const { keys, pagesScanned, vectorsListed } = await store.listVectorKeys({
					maxResultsPerPage: pageSize,
					returnData: listReturnData,
					returnMetadata: listReturnMetadata,
					metadataMatch,
				});

				out.push({
					json: {
						success: true,
						operation: 'listVectors',
						indexName: idxName,
						keys,
						deleteKeys: keys,
						matchedKeyCount: keys.length,
						pagesScanned,
						vectorsListed,
					},
				});
			}
			return [out];
		}

		// ── query ──────────────────────────────────────────────────────────────
		if (operation === 'query') {
			const queryText = this.getNodeParameter('queryText', 0) as string;
			const topKQuery = this.getNodeParameter('topKQuery', 0) as number;
			const filterRaw = this.getNodeParameter('metadataFilter', 0, '{}');
			const filter = parseFilter(filterRaw, this.getNode());

			const embeddingsInput = (await this.getInputConnectionData(
				NodeConnectionTypes.AiEmbedding,
				0,
			)) as EmbeddingsLike;
			if (!embeddingsInput) {
				throw new NodeOperationError(this.getNode(), 'No embeddings model connected.');
			}

			const store = new OssVectorStore(embeddingsInput, { ...ossConfig, indexName });
			const results = await store.similaritySearchWithScore(queryText, topKQuery, filter);

			const outputItems: INodeExecutionData[] = results.map(([doc, score]) => ({
				json: { pageContent: doc.pageContent, score, metadata: doc.metadata },
			}));

			return [outputItems.length > 0 ? outputItems : [{ json: { results: [], message: 'No results found' } }]];
		}

		// ── insert ─────────────────────────────────────────────────────────────
		if (operation === 'insert') {
			const autoCreateIndex = this.getNodeParameter('autoCreateIndex', 0) as boolean;
			const dimension = this.getNodeParameter('dimension', 0) as number;
			const items = this.getInputData();

			const embeddingsInput = (await this.getInputConnectionData(
				NodeConnectionTypes.AiEmbedding,
				0,
			)) as EmbeddingsLike;
			if (!embeddingsInput) {
				throw new NodeOperationError(
					this.getNode(),
					'No embeddings model connected. Please attach an Embeddings node.',
				);
			}

			// Document loader (documentDefaultDataLoader) — required in insert mode.
			// Following n8n official pattern: call processItem(item, i) per main input item.
			const documentInput = (await this.getInputConnectionData(
				NodeConnectionTypes.AiDocument,
				0,
			)) as N8nDocumentLoader | null;

			if (!documentInput || typeof documentInput.processItem !== 'function') {
				throw new NodeOperationError(
					this.getNode(),
					'A Document loader is required for insert. Please connect a "Default Data Loader" node (with an optional Text Splitter sub-node).',
				);
			}

			const store = new OssVectorStore(embeddingsInput, {
				...ossConfig,
				indexName,
				autoCreateIndex,
				dimension,
			});

			if (autoCreateIndex) {
				await store.ensureIndex(dimension);
			}

			// Process each main input item individually — mirrors n8n official v1 vector store
			// behavior (populateVectorStore called per item). Per-item error isolation allows
			// other items to continue when one fails.
			let totalInserted = 0;
			const failedItems: string[] = [];

			for (let i = 0; i < items.length; i++) {
				let baseKey = `item_${i}`;
				try {
					const chunks = await documentInput.processItem(items[i], i);
					if (!chunks || chunks.length === 0) continue;

					baseKey =
						(chunks[0]?.metadata?.pointId as string) || `doc_${Date.now()}_${i}`;

					// Filter out empty-content chunks to avoid zero-vector issues with cosine distance.
					const docs: SimpleDocument[] = chunks
						.filter((chunk) => chunk.pageContent && chunk.pageContent.trim().length > 0)
						.map((chunk, ci) => ({
							pageContent: chunk.pageContent,
							metadata: {
								...chunk.metadata,
								pointId: chunks.length === 1 ? baseKey : `${baseKey}_${ci}`,
							},
						}));

					if (docs.length === 0) continue;

					const insertedKeys = await store.addDocuments(docs);
					totalInserted += insertedKeys.length;
				} catch (err) {
					// Log the failing item's key and continue — partial sync is better than no sync.
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.warn(`OSS Vector: failed to insert item ${i} (${baseKey}): ${msg}`);
					failedItems.push(baseKey);
				}
			}

			this.logger.info(
				`OSS Vector insert complete: ${totalInserted} vectors written to ${indexName}` +
					(failedItems.length > 0 ? `, ${failedItems.length} items failed: ${failedItems.join(', ')}` : ''),
			);

			// Pass through the first input item's metadata so downstream nodes can read
			// the same fields without relying on n8n item-pairing across SplitInBatches.
			const firstItemMeta =
				items.length > 0
					? ((items[0].json?.metadata as Record<string, unknown>) ?? {})
					: {};

			return [
				[
					{
						json: {
							success: failedItems.length === 0,
							indexName,
							sourceItems: items.length,
							totalVectors: totalInserted,
							failedItems: failedItems.length > 0 ? failedItems : undefined,
							metadata: firstItemMeta,
						},
					},
				],
			];
		}

		// retrieve: node acts as an AI sub-node supplying an OssVectorStore via supplyData().
		// execute() is not used in retrieve mode — return empty placeholder.
		if (operation === 'retrieve') {
			return [[]];
		}

		// retrieve-as-tool: when the AI Agent dispatches a tool call via ExecutionNodeAction,
		// n8n calls execute() on this node with the tool input in getInputData().
		// We must perform the actual vector search here and return results in the format
		// { json: { response: [{type, text}] } } — exactly as handleRetrieveAsToolExecuteOperation
		// does in official n8n vector store nodes.
		if (operation === 'retrieve-as-tool') {
			const items = this.getInputData();
			const resultData: INodeExecutionData[] = [];

			const embeddingsInput = (await this.getInputConnectionData(
				NodeConnectionTypes.AiEmbedding,
				0,
			)) as EmbeddingsLike;
			if (!embeddingsInput) {
				throw new NodeOperationError(this.getNode(), 'No embeddings model connected.');
			}

			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				const item = items[itemIndex];
				const filterRaw = this.getNodeParameter('metadataFilter', itemIndex, '{}');
				const filter = parseFilter(filterRaw, this.getNode());
				const topKTool = this.getNodeParameter('topK', itemIndex, 4) as number;
				const includeMetadata = this.getNodeParameter('includeDocumentMetadata', itemIndex, true) as boolean;
				const itemIndexName = this.getNodeParameter('indexName', itemIndex) as string;

				const query = extractRetrieveToolQueryString(item.json);

				if (!query) {
					const keys = Object.keys(item.json ?? {}).join(', ') || '(empty)';
					throw new NodeOperationError(
						this.getNode(),
						`Item ${itemIndex}: tool arguments must include a non-empty search string (expected keys like input, query, question, …); received keys: ${keys}`,
					);
				}

				const docs = await runOssSimilaritySearch(
					embeddingsInput,
					ossConfig,
					itemIndexName,
					query,
					topKTool,
					filter,
				);
				const response =
					docs.length === 0
						? [{ type: 'text' as const, text: EMPTY_RETRIEVAL_MESSAGE }]
						: scoredDocsToToolBlocks(docs, includeMetadata);

				resultData.push({
					json: { response },
					pairedItem: { item: itemIndex },
				});
			}

			return [resultData];
		}

		throw new NodeOperationError(this.getNode(), 'Unknown operation: ' + operation);
	}

	/**
	 * supplyData is called by n8n for nodes that supply AI components.
	 *
	 * retrieve mode        → returns OssVectorStore (ai_vectorStore output)
	 *                        Compatible with RetrieverVectorStore node via duck-typing.
	 *
	 * retrieve-as-tool mode → returns a LangChain DynamicTool (ai_tool output)
	 *                         Connects directly to AI Agent's Tool connection point,
	 *                         exactly like official Qdrant/Pinecone vector store nodes.
	 */
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const operation = this.getNodeParameter('operation', itemIndex) as string;
		const indexName = this.getNodeParameter('indexName', itemIndex) as string;
		const topK = this.getNodeParameter('topK', itemIndex, 4) as number;
		const filterRaw = this.getNodeParameter('metadataFilter', itemIndex, '{}');
		const filter = parseFilter(filterRaw, this.getNode());
		const ossConfig = await getOssConfig(this);

		const embeddingsInput = (await this.getInputConnectionData(
			NodeConnectionTypes.AiEmbedding,
			0,
		)) as EmbeddingsLike;
		if (!embeddingsInput) {
			throw new NodeOperationError(this.getNode(), 'No embeddings model connected.');
		}

		if (operation !== 'retrieve-as-tool') {
			const store = new OssVectorStore(embeddingsInput, { ...ossConfig, indexName, topK, filter });
			return { response: store };
		}

		const includeMetadata = this.getNodeParameter('includeDocumentMetadata', itemIndex, true) as boolean;
		const toolDescription = this.getNodeParameter('toolDescription', itemIndex) as string;
		const toolName =
			(this.getNodeParameter('toolName', itemIndex, 'oss_vector_search') as string).trim() ||
			'oss_vector_search';

		const context = this;

		const schema = z
			.object({
				input: z.string().optional().describe('Primary search query'),
				query: z.string().optional().describe('Alternative query field (same meaning as input)'),
			})
			.superRefine((val, ctx) => {
				const q = (val.input?.trim() || val.query?.trim()) ?? '';
				if (!q) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'Provide non-empty input or query',
					});
				}
			});

		const tool = new DynamicStructuredTool({
			name: toolName,
			description: toolDescription,
			schema,
			func: async (args: { input?: string; query?: string }) => {
				const queryString = (args.input?.trim() || args.query?.trim()) ?? '';

				if (!queryString) {
					return 'Error: empty query string.';
				}

				const { index } = context.addInputData(NodeConnectionTypes.AiTool, [
					[{ json: { input: queryString, query: queryString } }],
				]);

				try {
					const documents = await runOssSimilaritySearch(
						embeddingsInput,
						ossConfig,
						indexName,
						queryString,
						topK,
						filter,
					);

					const contentBlocks =
						documents.length === 0
							? [{ type: 'text' as const, text: EMPTY_RETRIEVAL_MESSAGE }]
							: scoredDocsToToolBlocks(documents, includeMetadata);

					context.addOutputData(NodeConnectionTypes.AiTool, index, [
						[{ json: { response: contentBlocks } }],
					]);

					return scoredDocsToLlmText(documents, includeMetadata);
				} catch (e) {
					const error = e instanceof Error ? e : new Error(String(e));
					context.addOutputData(NodeConnectionTypes.AiTool, index, [
						[{ json: { error: error.message } }],
					]);
					throw error;
				}
			},
		});

		return { response: tool };
	}
}
