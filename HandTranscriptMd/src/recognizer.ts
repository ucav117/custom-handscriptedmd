/* =============================================
   Recognizer — handwriting OCR through Turnstone

   A short-lived Turnstone workstream receives the PNG as a native image
   attachment. Turnstone then routes the request to whichever multimodal
   model alias the user configured on their server.
   ============================================= */

import { requestUrl, RequestUrlResponse } from 'obsidian';

interface TurnstoneCreateResponse {
	ws_id?: string;
	error?: string;
}

interface TurnstoneHistoryResponse {
	messages?: Array<{ role?: string; content?: string | null }>;
	error?: string;
}

interface TurnstoneErrorResponse {
	error?: string;
	detail?: string;
}

export interface IRecognizer {
	recognize(imageBase64: string): Promise<string>;
}

export interface TurnstoneRecognizerOptions {
	baseUrl: string;
	token: string;
	model: string;
	languages: string[];
	timeoutSeconds: number;
}

const encoder = new TextEncoder();

function joinBytes(parts: Uint8Array[]): ArrayBuffer {
	const size = parts.reduce((total, part) => total + part.byteLength, 0);
	const output = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output.buffer;
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value.replace(/^data:image\/png;base64,/, ''));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function multipartBody(meta: Record<string, unknown>, image: Uint8Array, boundary: string): ArrayBuffer {
	const start =
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="meta"\r\n` +
		`Content-Type: application/json\r\n\r\n` +
		`${JSON.stringify(meta)}\r\n` +
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="handwriting.png"\r\n` +
		`Content-Type: image/png\r\n\r\n`;
	return joinBytes([encoder.encode(start), image, encoder.encode(`\r\n--${boundary}--\r\n`)]);
}

// requestUrl's `.json` getter lazily runs JSON.parse and throws a raw, unhelpful
// error ("Unexpected end of JSON input") when the body is empty or not JSON —
// e.g. wrong baseUrl, a proxy/error page in front of Turnstone, or a 204/empty
// response. Surface the HTTP status and a snippet of the actual body instead.
function safeJson(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch {
		const snippet = response.text.trim().slice(0, 200);
		throw new Error(
			`Turnstone returned an invalid response (HTTP ${response.status}, ${snippet ? `body: ${snippet}` : 'empty body'}). ` +
			`Check that the Turnstone server URL is correct and the server is running.`
		);
	}
}

function errorMessage(status: number, json: unknown): string {
	const body = json as TurnstoneErrorResponse | undefined;
	return body?.error ?? body?.detail ?? `HTTP ${status}`;
}

class TurnstoneRecognizer implements IRecognizer {
	constructor(private options: TurnstoneRecognizerOptions) {}

	private headers(): Record<string, string> {
		return this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {};
	}

	async recognize(imageBase64: string): Promise<string> {
		const boundary = `----HandTranscriptMd${Date.now().toString(16)}`;
		const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
		const languageList = this.options.languages.join(', ') || 'the languages visible in the image';
		const prompt =
			`Act only as a handwriting OCR system. Transcribe the attached image exactly. ` +
			`Expected languages: ${languageList}. Preserve handwritten Markdown symbols and the plugin's // commands. ` +
			`Return only the transcription as plain text: no explanation, preamble, or surrounding code fence. ` +
			`Do not use tools.`;
		const meta: Record<string, unknown> = {
			name: 'HandTranscriptMd OCR',
			initial_message: prompt,
			client_type: 'chat',
		};
		if (this.options.model.trim()) meta.model = this.options.model.trim();

		const create = await requestUrl({
			url: `${baseUrl}/v1/api/workstreams/new`,
			method: 'POST',
			headers: {
				...this.headers(),
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
			},
			body: multipartBody(meta, decodeBase64(imageBase64), boundary),
			throw: false,
		});
		if (create.status < 200 || create.status >= 300) {
			throw new Error(`Turnstone ${errorMessage(create.status, safeJson(create))}`);
		}
		const wsId = (safeJson(create) as TurnstoneCreateResponse)?.ws_id;
		if (!wsId) throw new Error('Turnstone returned no workstream ID');

		const deadline = Date.now() + this.options.timeoutSeconds * 1000;
		try {
			while (Date.now() < deadline) {
				const history = await requestUrl({
					url: `${baseUrl}/v1/api/workstreams/${encodeURIComponent(wsId)}/history?limit=20`,
					method: 'GET',
					headers: this.headers(),
					throw: false,
				});
				if (history.status < 200 || history.status >= 300) {
					throw new Error(`Turnstone ${errorMessage(history.status, safeJson(history))}`);
				}
				const messages = (safeJson(history) as TurnstoneHistoryResponse)?.messages ?? [];
				const answer = [...messages].reverse().find(message => message.role === 'assistant');
				if (answer?.content?.trim()) return answer.content.trim();
				await new Promise(resolve => window.setTimeout(resolve, 750));
			}
			throw new Error(`Turnstone OCR timed out after ${this.options.timeoutSeconds} seconds`);
		} finally {
			// OCR workstreams are implementation details; don't clutter Turnstone history.
			void requestUrl({
				url: `${baseUrl}/v1/api/workstreams/${encodeURIComponent(wsId)}/delete`,
				method: 'POST',
				headers: this.headers(),
				contentType: 'application/json',
				body: '{}',
				throw: false,
			});
		}
	}
}

export function getRecognizer(options: TurnstoneRecognizerOptions): IRecognizer {
	if (!options.baseUrl.trim()) throw new Error('Turnstone server URL is not configured');
	if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 1) {
		throw new Error('Turnstone timeout must be at least one second');
	}
	return new TurnstoneRecognizer({ ...options, baseUrl: options.baseUrl.trim() });
}
