'use strict';

const fs = require('fs');
const path = require('path');
const { RECORDINGS_DIR } = require('../config');

// In-memory job store — resets on container restart
const jobs = new Map();
// SSE clients per job: jobId -> Set<res>
const jobSseClients = new Map();

function broadcastToJob(jobId, data) {
	const clients = jobSseClients.get(jobId);
	if (!clients || clients.size === 0) return;
	const msg = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of clients) res.write(msg);
}

function closeJobSse(jobId) {
	const clients = jobSseClients.get(jobId);
	if (!clients) return;
	for (const res of clients) {
		res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
		res.end();
	}
	clients.clear();
}

function jobView(job) {
	const filePath = path.join(RECORDINGS_DIR, job.output);
	return {
		id: job.id,
		name: job.name || null,
		url: job.url,
		duration: job.duration,
		output: job.output,
		status: job.status,
		startedAt: job.startedAt,
		ffmpegStartedAt: job.ffmpegStartedAt,
		completedAt: job.completedAt,
		downloadable: job.status === 'completed' && fs.existsSync(filePath),
	};
}

module.exports = { jobs, jobSseClients, broadcastToJob, closeJobSse, jobView };
