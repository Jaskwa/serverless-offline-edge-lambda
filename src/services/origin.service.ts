import {
	CloudFrontHeaders,
	CloudFrontRequest,
	CloudFrontRequestEvent,
	CloudFrontResultResponse,
} from 'aws-lambda';
import * as fs from 'fs-extra';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { parse } from 'url';

import { toHttpHeaders } from '../utils';
import { OutgoingHttpHeaders } from 'http';
import { InternalServerError, NotFoundError } from '../errors/http';
import { StatusCodes } from 'http-status-codes';

interface FileUpstreamResponse {
	_tag: 'file';
	contents: string;
}

interface HttpUpstreamResponse {
	_tag: 'http';
	status?: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

type UpstreamResponse = FileUpstreamResponse | HttpUpstreamResponse;

const isHttpResponse = (
	response: UpstreamResponse
): response is HttpUpstreamResponse => response._tag === 'http';

const isFileResponse = (
	response: UpstreamResponse
): response is FileUpstreamResponse => response._tag === 'file';

const incomingHeadersToCloudFrontHeaders = (
	headers: http.IncomingHttpHeaders
): CloudFrontHeaders =>
	Object.keys(headers).reduce((aggregate, current) => {
		if (aggregate[current]) {
			if (Array.isArray(headers[current])) {
				aggregate[current].concat(headers[current] as []);
			} else if (typeof headers[current] === 'string') {
				aggregate[current].push({ value: headers[current] as string });
			}
		} else {
			if (Array.isArray(headers[current])) {
				aggregate[current] = headers[current] as [];
			} else if (typeof headers[current] === 'string') {
				aggregate[current] = [{ value: headers[current] as string }];
			}
		}
		return aggregate;
	}, {} as CloudFrontHeaders);

const header =
	(headerName: string) =>
	(httpResponse: HttpUpstreamResponse): string => {
		const v = httpResponse.headers[headerName];
		if (Array.isArray(v)) {
			return v[0];
		} else if (typeof v === 'string') {
			return v;
		}
		return '';
	};

const contentEncoding = header('content-encoding');

const upstreamResponseBodyEncoding = (
	httpResponse: HttpUpstreamResponse
): CloudFrontResultResponse['bodyEncoding'] =>
	['gzip'].includes(contentEncoding(httpResponse)) ? 'base64' : 'text';

const upstreamResponseBody = (
	httpResponse: HttpUpstreamResponse
): CloudFrontResultResponse['body'] =>
	['gzip'].includes(contentEncoding(httpResponse))
		? httpResponse.body.toString('base64')
		: httpResponse.body.toString();

const httpUpstreamResponseToCloudFrontResponse = (
	upstreamResponse: HttpUpstreamResponse
): CloudFrontResultResponse => {
	return {
		status: upstreamResponse.status?.toString() || '200',
		headers: incomingHeadersToCloudFrontHeaders(upstreamResponse.headers),
		bodyEncoding: upstreamResponseBodyEncoding(upstreamResponse),
		body: upstreamResponseBody(upstreamResponse),
	};
};

export class Origin {
	private readonly type: 'http' | 'https' | 'file' | 'noop' = 'http';

	constructor(public readonly baseUrl: string = '') {
		if (!baseUrl) {
			this.type = 'noop';
		} else if (/^http:\/\//.test(baseUrl)) {
			this.type = 'http';
		} else if (/^https:\/\//.test(baseUrl)) {
			this.type = 'https';
		} else {
			this.baseUrl = path.resolve(baseUrl);
			this.type = 'file';
		}
	}

	async retrieve(
		event: CloudFrontRequestEvent
	): Promise<CloudFrontResultResponse> {
		const { request } = event.Records[0].cf;

		try {
			const upstreamResponse = await this.getResource(request);

			if (isHttpResponse(upstreamResponse)) {
				console.log('DEBUG: Upstream response:');
				console.log(
					JSON.stringify(
						{
							status: upstreamResponse.status,
							headers: upstreamResponse.headers,
							bodyLength: upstreamResponse.body.byteLength,
						},
						null,
						2
					)
				);
				return httpUpstreamResponseToCloudFrontResponse(upstreamResponse);
			} else {
				return {
					status: '200',
					statusDescription: 'OK',
					headers: {
						'content-type': [
							{ key: 'content-type', value: 'application/json' },
						],
					},
					bodyEncoding: 'text',
					body: upstreamResponse.contents,
				};
			}
		} catch (err) {
			// Make sure error gets back to user
			const status = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
			const reasonPhrase = err.reasonPhrase || 'Internal Server Error';

			return {
				status: status,
				statusDescription: reasonPhrase,
				headers: {
					'content-type': [{ key: 'content-type', value: 'application/json' }],
				},
				bodyEncoding: 'text',
				body: JSON.stringify({
					code: status,
					message: err.message,
				}),
			};
		}
	}

	async getResource(request: CloudFrontRequest): Promise<UpstreamResponse> {
		const { uri: key } = request;

		switch (this.type) {
			case 'file': {
				const contents = await this.getFileResource(key);
				return { _tag: 'file', contents };
			}
			case 'http':
			case 'https': {
				return await this.getHttpResource(request);
			}
			case 'noop': {
				throw new NotFoundError('Operation given as "noop"');
			}
			default: {
				throw new InternalServerError(
					'Invalid request type (needs to be "http", "https" or "file")'
				);
			}
		}
	}

	private async getFileResource(key: string): Promise<string> {
		const uri = parse(key);
		const fileName = uri.pathname;

		const fileTarget = `${this.baseUrl}/${fileName}`;

		// Check for if path given is accessible and is a file before fetching it
		try {
			await fs.access(fileTarget);
		} catch {
			throw new NotFoundError(`File ${fileTarget} does not exist`);
		}

		const fileState = await fs.lstat(fileTarget);
		if (!fileState.isFile()) {
			throw new NotFoundError(`${fileTarget} is not a file.`);
		}

		return await fs.readFile(`${this.baseUrl}/${fileName}`, 'utf-8');
	}

	private async getHttpResource(
		request: CloudFrontRequest
	): Promise<HttpUpstreamResponse> {
		const httpModule = this.type === 'https' ? https : http;

		const uri = parse(request.uri);
		const baseUrl = parse(this.baseUrl);

		const initialHeaders = {
			// put any hardcoded, default headers here
		} as OutgoingHttpHeaders;

		const headers = toHttpHeaders(request.headers).reduce((acc, item) => {
			acc[item.key] = item.value[0];
			return acc;
		}, initialHeaders);

		const options: http.RequestOptions = {
			method: request.method,
			protocol: baseUrl.protocol,
			hostname: baseUrl.hostname,
			port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
			path: uri.path,
			headers: {
				...headers,
				Connection: 'Close',
			},
		};

		return new Promise((resolve, reject) => {
			const req = httpModule.request(options, (res: http.IncomingMessage) => {
				const chunks: Uint8Array[] = [];

				res.on('data', (chunk: Uint8Array) => {
					chunks.push(chunk);
				});

				res.on('close', () => {
					const retVal = {
						_tag: 'http' as const,
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks),
					};
					resolve(retVal);
				});
				res.on('error', (err: Error) => reject(err));
			});

			if (request.body && request.body.data) {
				req.write(request.body.data);
			}

			req.end();
		});
	}
}
