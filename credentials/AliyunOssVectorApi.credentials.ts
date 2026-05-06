import type { ICredentialType, INodeProperties } from 'n8n-workflow';

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
}
