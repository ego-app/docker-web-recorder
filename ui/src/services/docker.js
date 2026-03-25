'use strict';

const Docker = require('dockerode');
const { RECORDER_IMAGE, VOLUME_SOURCE } = require('../config');
const { jobs, broadcastToJob, closeJobSse } = require('./jobStore');
const { makeLineWriter } = require('../utils/lineWriter');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function streamContainerLogs(container, job) {
	container
		.logs({ follow: true, stdout: true, stderr: true, timestamps: false })
		.then((logStream) => {
			function onLine(line) {
				job.logs.push(line);
				if (job.logs.length > 300) job.logs.shift();

				if (!job.ffmpegStartedAt && line.includes('Starting FFmpeg')) {
					job.ffmpegStartedAt = new Date().toISOString();
					broadcastToJob(job.id, { type: 'ffmpegStarted', timestamp: job.ffmpegStartedAt });
				}

				broadcastToJob(job.id, { type: 'log', line });
			}

			const writer = makeLineWriter(onLine);
			docker.modem.demuxStream(logStream, writer, writer);
		})
		.catch(() => {
			/* container may have already exited */
		});
}

function watchContainer(container, job) {
	container
		.wait()
		.then(({ StatusCode }) => {
			const j = jobs.get(job.id);
			if (!j || j.status === 'completed' || j.status === 'failed') return;
			// Treat graceful stop (SIGTERM) or clean exit as completed
			const graceful = j.status === 'stopping' || StatusCode === 0 || StatusCode === null;
			j.status = graceful ? 'completed' : 'failed';
			j.completedAt = new Date().toISOString();
			closeJobSse(job.id);
			container.remove().catch(() => { /* already removed */ });
		})
		.catch(() => {
			const j = jobs.get(job.id);
			if (j && (j.status === 'recording' || j.status === 'stopping')) {
				j.status = 'failed';
				j.completedAt = new Date().toISOString();
				closeJobSse(job.id);
			}
			container.remove().catch(() => { /* already removed */ });
		});
}

async function createAndStartContainer(env) {
	const volumeBinding = `${VOLUME_SOURCE}:/app/recordings`;
	const container = await docker.createContainer({
		Image: RECORDER_IMAGE,
		Env: env,
		HostConfig: {
			Binds: [volumeBinding],
			ShmSize: 1073741824, // 1 GB — Chromium needs this
		},
	});
	await container.start();
	return container;
}

async function sendSigterm(containerId) {
	await docker.getContainer(containerId).kill({ signal: 'SIGTERM' });
}

module.exports = { streamContainerLogs, watchContainer, createAndStartContainer, sendSigterm };
