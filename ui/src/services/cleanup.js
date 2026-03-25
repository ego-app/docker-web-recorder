'use strict';

const fs = require('fs');
const path = require('path');
const { RECORDINGS_DIR } = require('../config');
const { jobs } = require('./jobStore');

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupOldRecordings() {
	let files;
	try {
		files = fs.readdirSync(RECORDINGS_DIR);
	} catch {
		return; // directory not accessible yet
	}

	const now = Date.now();
	for (const file of files) {
		// Only consider .mp4 files to avoid accidentally deleting non-recording files
		if (!file.endsWith('.mp4')) continue;

		const filePath = path.join(RECORDINGS_DIR, file);
		try {
			const stat = fs.statSync(filePath);

			// If the file is older than one month, delete it
			if (now - stat.mtimeMs > ONE_MONTH_MS) {
				fs.unlinkSync(filePath);
				console.log(`Auto-deleted old recording: ${file}`);

				// Remove any associated job from the job store
				for (const [id, job] of jobs.entries()) {
					if (job.output === file) { jobs.delete(id); break; }
				}
			}
		} catch (err) {
			console.error(`Failed to auto-delete ${file}: ${err.message}`);
		}
	}
}

function startCleanupScheduler() {
	cleanupOldRecordings();
	setInterval(cleanupOldRecordings, 60 * 60 * 1000);
}

module.exports = { startCleanupScheduler };
