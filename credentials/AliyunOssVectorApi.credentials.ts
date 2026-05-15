import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

import {
	CREDENTIAL_TEST_INDEX_NAME,
	credentialsDataToOssConfig,
} from '../nodes/AliyunOssVector/ossCredentialConfig';
import { buildOssAuth } from '../nodes/AliyunOssVector/ossSign';

/** HTTP status codes that must still fail the credential test (4xx/5xx other than the expected 404 for a missing test index). */
const CREDENTIAL_TEST_THROW_STATUSES = [400, 401, 403, 429, 500, 502, 503, 504] as const;

export class AliyunOssVectorApi implements ICredentialType {
	name = 'aliyunOssVectorApi';
	displayName = 'Aliyun OSS Vector API';
	icon: ICredentialType['icon'] = 'file:aliyun-oss.svg';
	documentationUrl = 'https://help.aliyun.com/zh/oss/user-guide/overview-vector-bucket';
	properties: INodeProperties[] = [
		{
			displayName: 'Access Key ID',
			name: 'accessKeyId',
			type: 'string',
			default: '',
			required: true,
			description: 'Alibaba Cloud RAM Access Key ID',
		},
		{
			displayName: 'Access Key Secret',
			name: 'accessKeySecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Alibaba Cloud RAM Access Key Secret',
		},
		{
			displayName: 'Vector Bucket Endpoint',
			name: 'vectorBucketHost',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://my-bucket-1234567890123456.cn-beijing-internal.oss-vectors.aliyuncs.com',
			description:
				'Paste the endpoint URL or hostname from the OSS Vector Bucket console. It encodes bucket name, account ID, region, and internal vs public access.',
		},
	];

	/** OSS v4 signing for the GetVectorIndex POST used by `test`. */
	async authenticate(
		rawCredentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const config = credentialsDataToOssConfig(rawCredentials);
		const auth = buildOssAuth(config, 'getVectorIndex', { indexName: CREDENTIAL_TEST_INDEX_NAME });
		return {
			...requestOptions,
			method: 'POST',
			url: auth.url,
			body: auth.bodyJson,
			json: false,
			headers: {
				...(requestOptions.headers ?? {}),
				'Content-Type': 'application/json',
				Authorization: auth.authorization,
				'x-oss-date': auth.xOssDate,
				'x-oss-content-sha256': auth.xOssContentSha256,
				Host: auth.host,
			},
			ignoreHttpStatusErrors: {
				ignore: true,
				except: [...CREDENTIAL_TEST_THROW_STATUSES],
			},
		};
	}

	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			url: 'https://oss-vectors.aliyuncs.com/?getVectorIndex',
			body: JSON.stringify({ indexName: CREDENTIAL_TEST_INDEX_NAME }),
			headers: {
				'Content-Type': 'application/json',
			},
			ignoreHttpStatusErrors: {
				ignore: true,
				except: [...CREDENTIAL_TEST_THROW_STATUSES],
			},
		},
	};
}
