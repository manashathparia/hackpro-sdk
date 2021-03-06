import { delay } from 'bluebird';
import { Writable } from 'readable-stream';

import { PROGRESS_EMISSION_INTERVAL, RETRY_BASE_TIMEOUT } from '../constants';
import { isTransientError } from '../errors';
import { makeClassEmitProgressEvents } from '../source-destination/progress';
import { SourceDestination } from '../source-destination/source-destination';
import { asCallback } from '../utils';
import { SparseStreamChunk } from './shared';

export interface SparseWritable extends NodeJS.WritableStream {
	_write(
		chunk: SparseStreamChunk,
		encoding: string,
		callback: (err?: Error | void) => void,
	): void;
}

export class SparseWriteStream extends Writable implements SparseWritable {
	public position: number;
	public bytesWritten = 0;
	private _firstChunks: SparseStreamChunk[] = [];

	constructor(
		private destination: SourceDestination,
		public firstBytesToKeep = 0,
		private maxRetries = 5,
	) {
		super({ objectMode: true });
	}

	private async writeChunk(
		chunk: SparseStreamChunk,
		flushing = false,
	): Promise<void> {
		let retries = 0;
		while (true) {
			try {
				this.position = chunk.position;
				await this.destination.write(
					chunk.buffer,
					0,
					chunk.buffer.length,
					chunk.position,
				);
				if (!flushing) {
					this.position += chunk.buffer.length;
					this.bytesWritten += chunk.buffer.length;
				}
				return;
			} catch (error) {
				if (isTransientError(error)) {
					if (retries < this.maxRetries) {
						retries += 1;
						await delay(RETRY_BASE_TIMEOUT * retries);
						continue;
					}
					error.code = 'EUNPLUGGED';
				}
				throw error;
			}
		}
	}

	private async __write(chunk: SparseStreamChunk): Promise<void> {
		// Keep the first blocks in memory and write them once the rest has been written.
		// This is to prevent Windows from mounting the device while we flash it.
		if (chunk.position < this.firstBytesToKeep) {
			const end = chunk.position + chunk.buffer.length;
			if (end <= this.firstBytesToKeep) {
				this._firstChunks.push(chunk);
				this.position = chunk.position + chunk.buffer.length;
				this.bytesWritten += chunk.buffer.length;
			} else {
				const difference = this.firstBytesToKeep - chunk.position;
				this._firstChunks.push({
					position: chunk.position,
					buffer: chunk.buffer.slice(0, difference),
				});
				this.position = this.firstBytesToKeep;
				this.bytesWritten += difference;
				const remainingBuffer = chunk.buffer.slice(difference);
				await this.writeChunk({
					position: this.firstBytesToKeep,
					buffer: remainingBuffer,
				});
			}
		} else {
			await this.writeChunk(chunk);
		}
	}

	public _write(
		chunk: SparseStreamChunk,
		_enc: string,
		callback: (error: Error | undefined) => void,
	): void {
		asCallback(this.__write(chunk), callback);
	}

	private async __final(): Promise<void> {
		try {
			for (const chunk of this._firstChunks) {
				await this.writeChunk(chunk, true);
			}
		} catch (error) {
			this.destroy();
			throw error;
		}
	}

	/**
	 * @summary Write buffered data before a stream ends, called by stream internals
	 */
	public _final(callback: (error?: Error | void) => void) {
		asCallback(this.__final(), callback);
	}
}

export const ProgressSparseWriteStream = makeClassEmitProgressEvents(
	SparseWriteStream,
	'bytesWritten',
	'position',
	PROGRESS_EMISSION_INTERVAL,
);
