'use strict';

const { Writable } = require('stream');

// Creates a Writable that buffers incomplete lines and calls onLine for each complete line
function makeLineWriter(onLine) {
	let pending = '';
	return new Writable({
		write(chunk, _enc, cb) {
			pending += chunk.toString();
			const lines = pending.split('\n');
			pending = lines.pop();
			for (const raw of lines) {
				const line = raw.trim();
				if (line) onLine(line);
			}
			cb();
		},
		final(cb) {
			if (pending.trim()) onLine(pending.trim());
			cb();
		},
	});
}

module.exports = { makeLineWriter };
