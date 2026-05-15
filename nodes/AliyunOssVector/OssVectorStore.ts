import { buildOssAuth, OssConfig } from './ossSign';
import { waitMs } from './waitMs';

export interface OssVectorStoreConfig extends OssConfig {
	indexName: string;
	topK?: number;
	autoCreateIndex?: boolean;
	dimension?: number;
	/** Optional metadata filter for all retrievals. OSS Vector uses MongoDB-style operators.
	 *  e.g. { "tenantId": { "$eq": "acme" } }  or  { "$and": [{ "category": { "$eq": "docs" } }, { "docId": { "$eq": "42" } }] }
	 */
	filter?: OssMetadataFilter;
}

/** OSS Vector metadata filter. Uses MongoDB-style operators: $eq, $ne, $in, $nin, $exists, $and, $or. */
export type OssMetadataFilter = Record<string, unknown>;

/**
 * OSS Vector putVectors request body per vector.
 * Spec: data.float32 required; metadata: string | string[] values only,
 *       filterable fields ≤ 10, total metadata size ≤ 40KB.
 */
interface OssVector {
	key: string;
	data: { float32: number[] };
	metadata?: Record<string, string | string[]>;
}

/**
 * QueryVectors response per vector.
 * Spec: field is "vectors" (not "matches"), similarity field is "distance" (not "score").
 */
interface OssQueryResult {
	key: string;
	distance?: number;
	metadata?: Record<string, unknown>;
}

interface OssQueryResponse {
	vectors?: OssQueryResult[];
}

/** Single vector row from ListVectors API. See https://help.aliyun.com/zh/oss/developer-reference/listvectors */
interface OssListVectorRow {
	key?: string;
	data?: { float32?: number[] };
	metadata?: Record<string, unknown>;
}

interface OssListVectorsResponse {
	nextToken?: string;
	vectors?: OssListVectorRow[];
}

const LIST_VECTORS_MAX_PAGE = 1000;
const LIST_VECTORS_PAGE_DELAY_MS = 50;

function metaValueMatchesExpected(expected: string, value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === 'string') return value === expected;
	if (Array.isArray(value)) return value.some((item) => String(item) === expected);
	return String(value) === expected;
}

/** AND-match: every entry in match must match the vector metadata (OSS stores string | string[]). */
export function vectorMetadataMatchesFilter(
	metadata: Record<string, unknown> | undefined,
	match: Record<string, string>,
): boolean {
	for (const [field, expected] of Object.entries(match)) {
		if (!metaValueMatchesExpected(expected, metadata?.[field])) return false;
	}
	return true;
}

export interface SimpleDocument {
	pageContent: string;
	metadata: Record<string, unknown>;
}

export interface EmbeddingsLike {
	embedDocuments(texts: string[]): Promise<number[][]>;
	embedQuery(text: string): Promise<number[]>;
}

/**
 * Fields that are always stored as non-filterable in OSS Vector.
 * pageContent carries large text and must not count toward the 10-field filterable limit.
 * All other metadata fields passed in by the upstream n8n workflow node are treated as
 * filterable — it is the workflow's responsibility to keep the count ≤ 10.
 */
const NON_FILTERABLE_KEYS: ReadonlySet<string> = new Set(['pageContent']);

async function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body,
	});
	const data = await res.text();
	if (res.status === 204) return '';
	if (res.status >= 400) {
		throw new Error('OSS API error ' + res.status + ': ' + data);
	}
	return data;
}

export class OssVectorStore {
	private config: OssVectorStoreConfig;
	embeddings: EmbeddingsLike;

	/**
	 * Self-reference required for n8n's RetrieverVectorStore else-branch compatibility.
	 *
	 * n8n 2.x RetrieverVectorStore does:
	 *   if (store instanceof VectorStore) { store.asRetriever(k) }
	 *   else { new ContextualCompressionRetriever({ baseCompressor: store.reranker, baseRetriever: store.vectorStore.asRetriever(k) }) }
	 *
	 * Since our class doesn't extend LangChain's VectorStore (different module instances),
	 * instanceof is always false. The else-branch uses store.vectorStore.asRetriever(k)
	 * and store.reranker.compressDocuments(docs, query) as a passthrough.
	 */
	get vectorStore(): this {
		return this;
	}

	/**
	 * Passthrough compressor for n8n's ContextualCompressionRetriever else-branch.
	 * Returns all documents unchanged — effectively a no-op that satisfies the interface.
	 */
	readonly reranker = {
		compressDocuments: async (documents: unknown[]) => documents,
		lc_serializable: false,
		lc_namespace: ['langchain', 'retrievers', 'document_compressors'],
		lc_kwargs: {},
	};

	constructor(embeddings: EmbeddingsLike, config: OssVectorStoreConfig) {
		this.embeddings = embeddings;
		this.config = config;
	}

	_vectorstoreType(): string {
		return 'aliyun-oss-vector';
	}

	private async callOssApi(action: string, body: unknown): Promise<unknown> {
		const auth = buildOssAuth(this.config, action, body);
		const responseText = await httpsPost(
			auth.url,
			{
				Authorization: auth.authorization,
				'x-oss-date': auth.xOssDate,
				'x-oss-content-sha256': auth.xOssContentSha256,
				Host: auth.host,
			},
			auth.bodyJson,
		);
		if (!responseText || responseText.trim() === '') return {};
		return JSON.parse(responseText);
	}

	/**
	 * Poll GetVectorIndex until status becomes "enable" (ready to accept writes).
	 * OSS Vector has an undocumented async initialization phase after PutVectorIndex:
	 * the API returns 200 OK but the index status is "creating" for an indeterminate
	 * period.  The only reliable way to detect readiness is to poll status via
	 * GetVectorIndex (documented status values: creating | enable | deleting).
	 *
	 * During the "creating" phase, GetVectorIndex itself may also return 5xx — those
	 * are treated as "not ready yet" and polling continues rather than failing hard.
	 */
	private async waitForIndexReady(timeoutMs = 180000): Promise<void> {
		const pollMs = 3000;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await waitMs(pollMs);
			try {
				const resp = (await this.callOssApi('getVectorIndex', {
					indexName: this.config.indexName,
				})) as { index?: { status?: string } };
				const status = resp?.index?.status;
				if (status === 'enable') {
					// OSS reports "enable" but the underlying storage backend has an additional
					// propagation delay before it can accept writes. Empirically, the first
					// putVectors call within ~10s of "enable" still returns 500 InternalError.
					// A fixed 12s buffer eliminates this race condition in the vast majority of cases.
					await waitMs(12000);
					return;
				}
				if (status === 'deleting') {
					throw new Error(`Index ${this.config.indexName} is being deleted — cannot write`);
				}
				// status === 'creating' or unknown → continue polling
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// Re-throw fatal errors (deleting, auth).
				if (msg.includes('being deleted') || msg.includes('OSS API error 403')) throw err;
				// For 5xx or 404 (index not yet visible), treat as "still initializing" and retry.
				// This handles the case where GetVectorIndex itself returns 500 during creation.
			}
		}
		throw new Error(
			`Index ${this.config.indexName} did not become ready within ${timeoutMs / 1000}s`,
		);
	}

	/**
	 * Create the vector index if it does not exist, then wait until it is ready.
	 * Returns true if a new index was just created, false if already existed.
	 * pageContent is declared as nonFilterable so large text chunks can be stored
	 * without counting toward the 10-field filterable metadata limit.
	 *
	 * putVectorIndex can itself return 500 InternalError transiently (observed in
	 * production when the OSS control plane is under load). Retry up to 3 times
	 * with exponential backoff before giving up.
	 */
	async ensureIndex(dimension: number): Promise<boolean> {
		let lastErr: Error | undefined;
		for (let attempt = 0; attempt <= 3; attempt++) {
			try {
				await this.callOssApi('putVectorIndex', {
					dataType: 'float32',
					dimension,
					distanceMetric: 'cosine',
					indexName: this.config.indexName,
					metadata: {
						nonFilterableMetadataKeys: ['pageContent'],
					},
				});
				// New index created — poll until status === "enable" before writing vectors.
				await this.waitForIndexReady();
				return true;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// 409: index already exists — safe to continue immediately.
				if (
					msg.includes('VectorBucketIndexAlreadyExist') ||
					msg.includes('VectorIndexAlreadyExists') ||
					msg.includes('IndexAlreadyExist')
				) {
					return false;
				}
				// 5xx: transient OSS control-plane error — retry with backoff (5s → 10s → 20s).
				if (msg.includes('OSS API error 5')) {
					lastErr = err instanceof Error ? err : new Error(msg);
					if (attempt < 3) await waitMs(5000 * Math.pow(2, attempt));
					continue;
				}
				// Other errors (4xx, auth failures, etc.): throw immediately.
				throw err;
			}
		}
		throw lastErr ?? new Error(`Failed to create index ${this.config.indexName} after retries`);
	}

	/**
	 * Build OSS-compatible metadata for a single vector.
	 *
	 * This method is intentionally generic — it does NOT maintain a hardcoded whitelist
	 * of field names. The upstream n8n workflow node is responsible for deciding which
	 * fields to include in metadata and must keep the count of filterable fields ≤ 10
	 * (OSS Vector hard limit).
	 *
	 * Rules enforced here:
	 *   - pageContent is always stored as non-filterable (declared in ensureIndex).
	 *     It can carry up to 30 000 chars of structured content without consuming a
	 *     filterable slot. OSS total metadata limit is 40KB.
	 *   - All other fields received from the document metadata are passed through as
	 *     filterable. Values are coerced to string | string[] (OSS requirement).
	 *   - Filterable string values are truncated to 2000 chars (OSS ≤ 2KB per field).
	 */
	private buildMetadata(
		pageContent: string,
		meta: Record<string, unknown>,
	): Record<string, string | string[]> {
		const result: Record<string, string | string[]> = {};

		// pageContent: non-filterable, generous size limit
		result['pageContent'] = pageContent.slice(0, 30000);

		// Pass through all other metadata fields as filterable.
		// The workflow node controls which fields are included (must be ≤ 10).
		for (const [key, v] of Object.entries(meta)) {
			if (NON_FILTERABLE_KEYS.has(key)) continue;
			if (v === null || v === undefined) continue;
			if (Array.isArray(v)) {
				result[key] = v.map((item) =>
					typeof item === 'string' ? item.slice(0, 2000) : String(item).slice(0, 2000),
				);
			} else if (typeof v === 'string') {
				result[key] = v.slice(0, 2000);
			} else if (typeof v === 'object') {
				// Serialize nested objects to JSON string (OSS only accepts primitives/string[])
				result[key] = JSON.stringify(v).slice(0, 2000);
			} else {
				result[key] = String(v).slice(0, 2000);
			}
		}

		return result;
	}

	/**
	 * Call putVectors with automatic retry on 5xx errors.
	 * Two-tier backoff:
	 *   - Attempts 0-2: short waits (5s → 10s → 20s) — handles transient QPS spikes.
	 *   - Attempts 3-4: longer waits (40s → 80s) — guards against residual index
	 *     propagation delay that can persist beyond the 12s buffer in waitForIndexReady.
	 * Total max extra wait: ~155s across 5 retries.
	 */
	private async putVectorsWithRetry(batch: OssVector[], maxRetries = 5): Promise<void> {
		let lastErr: Error | undefined;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await this.callOssApi('putVectors', {
					indexName: this.config.indexName,
					vectors: batch,
				});
				return;
			} catch (err: unknown) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				// Only retry on 5xx; propagate 4xx immediately.
				if (!lastErr.message.includes('OSS API error 5')) throw lastErr;
				if (attempt < maxRetries) await waitMs(5000 * Math.pow(2, attempt));
			}
		}
		throw lastErr;
	}

	/**
	 * Validate a single embedding vector before sending to OSS.
	 * OSS putVectors requirements:
	 *   - No NaN or Infinity values (server crashes with 500 if violated)
	 *   - No zero vectors when using cosine distance metric
	 * Returns true if the vector is valid.
	 */
	private isValidVector(vec: number[]): boolean {
		if (!vec || vec.length === 0) return false;
		let allZero = true;
		for (const v of vec) {
			if (!isFinite(v) || isNaN(v)) return false;
			if (v !== 0) allZero = false;
		}
		// Reject zero vectors — cosine distance requires non-zero vectors.
		return !allZero;
	}

	async addVectors(vectors: number[][], documents: SimpleDocument[]): Promise<string[]> {
		// Filter out vectors with NaN, Infinity, or all-zero values before sending to OSS.
		// Invalid vectors cause an undocumented 500 InternalError on the OSS server side.
		const validEntries: Array<{ vec: number[]; doc: SimpleDocument }> = [];
		for (let i = 0; i < vectors.length; i++) {
			if (this.isValidVector(vectors[i])) {
				validEntries.push({ vec: vectors[i], doc: documents[i] });
			}
		}

		const ossVectors: OssVector[] = validEntries.map(({ vec, doc }) => {
			const pointId = (doc.metadata?.pointId as string) || ('doc_' + Date.now());
			return {
				key: pointId,
				data: { float32: vec },
				metadata: this.buildMetadata(doc.pageContent, {
					...doc.metadata,
					pointId,
				}),
			};
		});

		// OSS putVectors: max 500 per request, QPS ≤ 5.
		// Batch size 10 keeps each request body small (~200KB for 2560-dim vectors).
		const BATCH_SIZE = 10;
		for (let i = 0; i < ossVectors.length; i += BATCH_SIZE) {
			if (i > 0) await waitMs(250);
			await this.putVectorsWithRetry(ossVectors.slice(i, i + BATCH_SIZE));
		}
		return validEntries.map(({ doc }) => (doc.metadata?.pointId as string) || '');
	}

	async addDocuments(documents: SimpleDocument[]): Promise<string[]> {
		const texts = documents.map((d) => d.pageContent);
		const vectors = await this.embeddings.embedDocuments(texts);
		return this.addVectors(vectors, documents);
	}

	async deleteVectors(keys: string[]): Promise<void> {
		// OSS deleteVectors returns 204 No Content on success.
		await this.callOssApi('deleteVectors', {
			indexName: this.config.indexName,
			keys,
		});
	}

	/**
	 * List vectors in the index with pagination (ListVectors API).
	 * Optionally filter client-side to keys whose metadata matches all fields in `metadataMatch`.
	 * When `metadataMatch` is empty/undefined, every listed key is collected (full index scan).
	 *
	 * Spec: https://help.aliyun.com/zh/oss/developer-reference/listvectors
	 */
	async listVectorKeys(options: {
		maxResultsPerPage?: number;
		returnData?: boolean;
		returnMetadata?: boolean;
		metadataMatch?: Record<string, string>;
	}): Promise<{
		keys: string[];
		pagesScanned: number;
		vectorsListed: number;
	}> {
		const maxResults = Math.min(
			LIST_VECTORS_MAX_PAGE,
			Math.max(1, Math.floor(options.maxResultsPerPage ?? 500)),
		);
		const returnData = options.returnData ?? false;
		const returnMetadata = options.returnMetadata ?? true;
		const match = options.metadataMatch;
		const useFilter = match !== undefined && Object.keys(match).length > 0;

		const keys: string[] = [];
		let nextToken: string | undefined;
		let pagesScanned = 0;
		let vectorsListed = 0;

		do {
			const body: Record<string, unknown> = {
				indexName: this.config.indexName,
				maxResults,
				returnData,
				returnMetadata,
			};
			if (nextToken) {
				body.nextToken = nextToken;
			}

			const resp = (await this.callOssApi('listVectors', body)) as OssListVectorsResponse;
			const rows = resp.vectors ?? [];
			vectorsListed += rows.length;
			pagesScanned++;

			for (const row of rows) {
				const key = row.key;
				if (!key) continue;
				if (!useFilter || vectorMetadataMatchesFilter(row.metadata, match!)) {
					keys.push(key);
				}
			}

			const nt = resp.nextToken;
			nextToken = nt && String(nt).length > 0 ? String(nt) : undefined;

			if (nextToken) {
				await waitMs(LIST_VECTORS_PAGE_DELAY_MS);
			}
		} while (nextToken);

		return { keys, pagesScanned, vectorsListed };
	}

	async deleteIndex(): Promise<void> {
		await this.callOssApi('deleteVectorIndex', {
			indexName: this.config.indexName,
		});
	}

	/**
	 * Perform vector similarity search with optional metadata filter.
	 *
	 * OSS Vector filter uses MongoDB-style operators:
	 *   $eq, $ne, $in, $nin, $exists for field matching
	 *   $and, $or for combining conditions
	 *
	 * Example: { "$and": [{ "category": { "$eq": "docs" } }, { "docId": { "$eq": "42" } }] }
	 *
	 * The `filter` param overrides this.config.filter for this call only.
	 * pointId is preserved in the returned metadata (not stripped).
	 */
	async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: OssMetadataFilter,
	): Promise<Array<[SimpleDocument, number]>> {
		const body: Record<string, unknown> = {
			indexName: this.config.indexName,
			queryVector: { float32: query },
			topK: k,
			returnMetadata: true,
			returnDistance: true,
		};

		const effectiveFilter = filter ?? this.config.filter;
		if (effectiveFilter && Object.keys(effectiveFilter).length > 0) {
			body.filter = effectiveFilter;
		}

		const response = (await this.callOssApi('queryVectors', body)) as OssQueryResponse;

		const results = response.vectors ?? [];
		return results.map((item) => {
			const meta = (item.metadata ?? {}) as Record<string, unknown>;
			// Extract pageContent from stored metadata; preserve all other fields (including pointId).
			const { pageContent, ...restMeta } = meta;
			const doc: SimpleDocument = {
				pageContent: (pageContent as string) ?? '',
				metadata: restMeta,
			};
			return [doc, item.distance ?? 0] as [SimpleDocument, number];
		});
	}

	async similaritySearch(
		query: string,
		k: number = 4,
		filter?: OssMetadataFilter,
	): Promise<SimpleDocument[]> {
		const queryVector = await this.embeddings.embedQuery(query);
		const results = await this.similaritySearchVectorWithScore(queryVector, k, filter);
		return results.map(([doc]) => doc);
	}

	async similaritySearchWithScore(
		query: string,
		k: number = 4,
		filter?: OssMetadataFilter,
	): Promise<Array<[SimpleDocument, number]>> {
		const queryVector = await this.embeddings.embedQuery(query);
		return this.similaritySearchVectorWithScore(queryVector, k, filter);
	}

	/**
	 * Return a LangChain-compatible retriever for use with n8n's vector store chain.
	 *
	 * Accepts both calling conventions:
	 *   asRetriever(5)             → n8n's built-in RetrieverVectorStore passes a number
	 *   asRetriever({ k: 5 })     → LangChain direct usage
	 *   asRetriever()             → falls back to this.config.topK
	 *
	 * The returned object satisfies LangChain's BaseRetriever duck-type contract
	 * (getRelevantDocuments + invoke) and will be passed through logWrapper correctly.
	 */
	asRetriever(kOrFields?: number | { k?: number; filter?: OssMetadataFilter }) {
		let k: number;
		let callFilter: OssMetadataFilter | undefined;

		if (typeof kOrFields === 'number') {
			// Called by n8n's RetrieverVectorStore: asRetriever(topK)
			k = kOrFields;
		} else {
			k = kOrFields?.k ?? this.config.topK ?? 4;
			callFilter = kOrFields?.filter;
		}

		// Effective filter: caller override → config default → none
		const effectiveFilter = callFilter ?? this.config.filter;
		const store = this;

		return {
			_vectorstoreType: () => 'aliyun-oss-vector',
			getRelevantDocuments: async (query: string) =>
				store.similaritySearch(query, k, effectiveFilter),
			_getRelevantDocuments: async (query: string) =>
				store.similaritySearch(query, k, effectiveFilter),
			invoke: async (query: string) => store.similaritySearch(query, k, effectiveFilter),
			lc_namespace: ['langchain', 'retrievers'],
			lc_serializable: false,
			lc_kwargs: {},
		};
	}
}
