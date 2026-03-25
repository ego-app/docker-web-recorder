'use strict';

const fs = require('fs');
const app = require('./src/app');
const { RECORDINGS_DIR, RECORDER_IMAGE, VOLUME_SOURCE, RECORDINGS_VOLUME_NAME } = require('./src/config');
const { startCleanupScheduler } = require('./src/services/cleanup');

app.listen(3000, () => {
	console.log('Web Recorder UI listening on http://localhost:3000');
	console.log(`Recorder image : ${RECORDER_IMAGE}`);
	console.log(`Recordings dir : ${RECORDINGS_DIR}`);
	console.log(`Volume source  : ${VOLUME_SOURCE}`);
	if (RECORDINGS_VOLUME_NAME) {
		console.log(`Volume name    : ${RECORDINGS_VOLUME_NAME}`);
	}

	fs.access(RECORDINGS_DIR, fs.constants.W_OK, (err) => {
		if (err) {
			console.error(
				`Error: Recordings directory "${RECORDINGS_DIR}" is not writable. Please ensure it exists and has the correct permissions.`,
			);
		} else {
			console.log(`Recordings directory "${RECORDINGS_DIR}" is writable.`);
		}
	});

	startCleanupScheduler();
});
