'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { RECORDINGS_DIR } = require('../config');
const { jobs, jobSseClients, jobView } = require('../services/jobStore');
const { streamContainerLogs, watchContainer, createAndStartContainer, sendSigterm } = require('../services/docker');

const router = express.Router();

// List all recordings
router.get('/', (_req, res) => {
	const list = Array.from(jobs.values())
		.map(jobView)
		.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
	res.json(list);
});

// Start a new recording
router.post('/', async (req, res) => {
	const { url, duration } = req.body;
	if (!url) return res.status(400).json({ error: 'url obbligatorio' });

	const id = randomUUID();
	const filename = `${id}.mp4`;

	const env = [`URL=${url}`, `OUTPUT=${filename}`];
	if (duration) env.push(`DURATION=${duration}`);

	let container;
	try {
		container = await createAndStartContainer(env);
	} catch (err) {
		return res.status(500).json({ error: `Avvio registratore non riuscito: ${err.message}` });
	}

	const job = {
		id,
		url,
		duration: duration || null,
		output: filename,
		containerId: container.id,
		status: 'recording',
		startedAt: new Date().toISOString(),
		ffmpegStartedAt: null,
		completedAt: null,
		logs: [],
	};
	jobs.set(id, job);

	streamContainerLogs(container, job);
	watchContainer(container, job);

	res.status(201).json(jobView(job));
});

// Stop an in-progress recording, or delete a completed/failed one
router.delete('/:id', async (req, res) => {
	const job = jobs.get(req.params.id);
	if (!job) return res.status(404).json({ error: 'Registrazione non trovata' });

	if (job.status === 'recording') {
		try {
			job.status = 'stopping';
			await sendSigterm(job.containerId);
			res.json({ ok: true });
		} catch (err) {
			job.status = 'failed';
			res.status(500).json({ error: err.message });
		}
	} else if (job.status === 'completed' || job.status === 'failed') {
		const filePath = path.join(RECORDINGS_DIR, job.output);
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch (err) {
			return res.status(500).json({ error: `Eliminazione file non riuscita: ${err.message}` });
		}
		jobs.delete(job.id);
		res.json({ ok: true });
	} else {
		return res.status(400).json({ error: `Impossibile eliminare una registrazione con stato "${job.status}"` });
	}
});

// Download a completed recording
router.get('/:id/download', (req, res) => {
	const job = jobs.get(req.params.id);
	if (!job) return res.status(404).json({ error: 'Registrazione non trovata' });
	if (job.status !== 'completed') {
		return res.status(400).json({ error: 'La registrazione non è ancora completata' });
	}

	const filePath = path.join(RECORDINGS_DIR, job.output);
	if (!fs.existsSync(filePath)) {
		return res.status(404).json({ error: 'File non trovato su disco' });
	}

	res.download(filePath, `recording-${job.id.slice(0, 8)}.mp4`);
});

// SSE endpoint: stream container logs in real time
router.get('/:id/logs', (req, res) => {
	const job = jobs.get(req.params.id);
	if (!job) return res.status(404).json({ error: 'Registrazione non trovata' });

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	// Send all buffered log lines first
	for (const line of job.logs) {
		res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
	}

	// Inform client if FFmpeg has already started
	if (job.ffmpegStartedAt) {
		res.write(
			`data: ${JSON.stringify({ type: 'ffmpegStarted', timestamp: job.ffmpegStartedAt })}\n\n`,
		);
	}

	// If the job is already finished, close immediately
	if (job.status === 'completed' || job.status === 'failed') {
		res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
		res.end();
		return;
	}

	// Register this response as a live SSE client
	if (!jobSseClients.has(job.id)) jobSseClients.set(job.id, new Set());
	jobSseClients.get(job.id).add(res);

	req.on('close', () => {
		const clients = jobSseClients.get(job.id);
		if (clients) clients.delete(res);
	});
});

module.exports = router;
