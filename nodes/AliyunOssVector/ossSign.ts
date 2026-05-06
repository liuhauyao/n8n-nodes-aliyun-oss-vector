import { createHash, createHmac } from 'crypto';

export interface OssConfig {
	accessKeyId: string;
	accessKeySecret: string;
	region: string;
	bucketName: string;
	accountId: string;
	endpointType: 'internal' | 'public';
}

export interface OssAuthResult {
	url: string;
	authorization: string;
	xOssDate: string;
	xOssContentSha256: string;
	host: string;
	bodyJson: string;
}

/** Compute OSS Vector endpoint hostname from config fields */
export function getOssEndpoint(config: OssConfig): string {
	const suffix =
		config.endpointType === 'internal'
			? config.region + '-internal.oss-vectors.aliyuncs.com'
			: config.region + '.oss-vectors.aliyuncs.com';
	return config.bucketName + '-' + config.accountId + '.' + suffix;
}

export function buildOssAuth(config: OssConfig, action: string, bodyObj: unknown): OssAuthResult {
	const { accessKeyId: ak, accessKeySecret: sk, region, bucketName, accountId } = config;
	const endpoint = getOssEndpoint(config);

	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
	const datetimeStr = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
	const bodyJson = JSON.stringify(bodyObj);

	const encodedArn = 'acs%3Aossvector%3A' + region + '%3A' + accountId + '%3A' + bucketName;
	const canonicalUri = '/' + encodedArn + '/';
	const canonicalHeaders =
		'content-type:application/json\n' +
		'host:' + endpoint + '\n' +
		'x-oss-content-sha256:UNSIGNED-PAYLOAD\n' +
		'x-oss-date:' + datetimeStr + '\n';
	const canonicalRequest = [
		'POST',
		canonicalUri,
		action,
		canonicalHeaders,
		'host',
		'UNSIGNED-PAYLOAD',
	].join('\n');
	const credentialScope = dateStr + '/' + region + '/oss/aliyun_v4_request';
	const crHash = createHash('sha256').update(canonicalRequest).digest('hex');
	const stringToSign = ['OSS4-HMAC-SHA256', datetimeStr, credentialScope, crHash].join('\n');
	const k1 = createHmac('sha256', 'aliyun_v4' + sk).update(dateStr).digest();
	const k2 = createHmac('sha256', k1).update(region).digest();
	const k3 = createHmac('sha256', k2).update('oss').digest();
	const signingKey = createHmac('sha256', k3).update('aliyun_v4_request').digest();
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	return {
		url: 'https://' + endpoint + '/?' + action,
		authorization:
			'OSS4-HMAC-SHA256 Credential=' + ak + '/' + credentialScope +
			',AdditionalHeaders=host,Signature=' + signature,
		xOssDate: datetimeStr,
		xOssContentSha256: 'UNSIGNED-PAYLOAD',
		host: endpoint,
		bodyJson,
	};
}
