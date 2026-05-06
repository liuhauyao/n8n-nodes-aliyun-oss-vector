import * as https from 'https';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import { buildOssAuth, type OssConfig } from './ossSign';

const OSS_VECTORS_HOST_SUFFIX = 'oss-vectors.aliyuncs.com';

export type ParsedOssEndpoint = Omit<OssConfig, 'accessKeyId' | 'accessKeySecret'>;

/**
 * Parses host/URL from the OSS Vector Bucket console, e.g.
 * https://my-bucket-1234567890123456.cn-beijing-internal.oss-vectors.aliyuncs.com
 */
export function parseVectorBucketEndpoint(input: string): ParsedOssEndpoint | null {
	let s = input.trim();
	if (!s) return null;

	if (s.includes('://')) {
		try {
			s = new URL(s).hostname;
		} catch {
			return null;
		}
	} else {
		const slash = s.indexOf('/');
		if (slash !== -1) s = s.slice(0, slash);
	}

	s = s.trim().toLowerCase();
	if (!s.endsWith(OSS_VECTORS_HOST_SUFFIX)) return null;

	const labels = s.split('.');
	if (labels.length !== 5) return null;
	if (labels[2] !== 'oss-vectors' || labels[3] !== 'aliyuncs' || labels[4] !== 'com') return null;

	const bucketAccount = labels[0];
	const regionPart = labels[1];
	if (!bucketAccount || !regionPart) return null;

	const accountSep = bucketAccount.lastIndexOf('-');
	if (accountSep <= 0) return null;
	const accountId = bucketAccount.slice(accountSep + 1);
	const bucketName = bucketAccount.slice(0, accountSep);
	if (!bucketName || !/^\d+$/.test(accountId)) return null;

	const internalSuffix = '-internal';
	let region: string;
	let endpointType: 'internal' | 'public';
	if (regionPart.endsWith(internalSuffix)) {
		region = regionPart.slice(0, -internalSuffix.length);
		endpointType = 'internal';
	} else {
		region = regionPart;
		endpointType = 'public';
	}
	if (!region) return null;

	return { bucketName, accountId, region, endpointType };
}

/**
 * Build {@link OssConfig} from decrypted credential fields (endpoint + access keys).
 */
export function credentialsDataToOssConfig(data: ICredentialDataDecryptedObject): OssConfig {
	const accessKeyId = String(data.accessKeyId ?? '').trim();
	const accessKeySecret = String(data.accessKeySecret ?? '').trim();
	if (!accessKeyId || !accessKeySecret) {
		throw new Error('Access Key ID and Access Key Secret are required.');
	}

	const hostRaw = String(data.vectorBucketHost ?? '').trim();
	if (!hostRaw) {
		throw new Error(
			'Vector Bucket Endpoint is required. Copy it from the OSS Vector Bucket console (URL or hostname).',
		);
	}
	const parsed = parseVectorBucketEndpoint(hostRaw);
	if (!parsed) {
		throw new Error(
			'Invalid Vector bucket endpoint. Expected a host like my-bucket-1234567890123456.cn-beijing-internal.oss-vectors.aliyuncs.com (or the full https URL).',
		);
	}
	return { accessKeyId, accessKeySecret, ...parsed };
}

function httpsPostSigned(auth: ReturnType<typeof buildOssAuth>): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const urlObj = new URL(auth.url);
		const body = auth.bodyJson;
		const req = https.request(
			{
				hostname: urlObj.hostname,
				path: urlObj.pathname + urlObj.search,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
					Authorization: auth.authorization,
					'x-oss-date': auth.xOssDate,
					'x-oss-content-sha256': auth.xOssContentSha256,
					Host: auth.host,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk: string) => {
					data += chunk;
				});
				res.on('end', () => {
					resolve({ statusCode: res.statusCode ?? 0, body: data });
				});
			},
		);
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

/** Placeholder index name for credential test only. Must satisfy OSS Vector index naming (no leading/trailing underscores, etc.). */
const CREDENTIAL_TEST_INDEX_NAME = 'n8ncredverify';

/**
 * Calls OSS Vector GetVectorIndex with a synthetic index name to verify signing and endpoint.
 */
export async function testOssVectorConnectivity(config: OssConfig): Promise<{
	ok: boolean;
	message: string;
}> {
	const auth = buildOssAuth(config, 'getVectorIndex', { indexName: CREDENTIAL_TEST_INDEX_NAME });
	try {
		const { statusCode, body } = await httpsPostSigned(auth);
		if (statusCode >= 200 && statusCode < 300) {
			return { ok: true, message: 'Connection successful.' };
		}
		if (statusCode === 404) {
			return {
				ok: true,
				message:
					'Connection successful. (404 for a non-existent test index — signature and endpoint are valid.)',
			};
		}
		if (statusCode === 403) {
			return {
				ok: false,
				message:
					'Access denied (403). Check the Access Key pair and RAM permissions for OSS Vector Bucket.',
			};
		}
		const snippet = body.length > 500 ? body.slice(0, 500) + '…' : body;
		return {
			ok: false,
			message: `OSS Vector request failed with HTTP ${statusCode}${snippet ? `: ${snippet}` : ''}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message: `Network error: ${msg}`,
		};
	}
}
