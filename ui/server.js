'use strict';

const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/recordings';
const RECORDER_IMAGE = process.env.RECORDER_IMAGE || 'docker-web-recorder:latest';
// Named volume used by docker-compose — must match the actual Docker volume name
// so spawned recorder containers can share the same recordings directory.
const RECORDINGS_VOLUME_NAME = process.env.RECORDINGS_VOLUME_NAME || null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory job store — resets on container restart
const jobs = new Map();

function jobView(job) {
  const filePath = path.join(RECORDINGS_DIR, job.output);
  return {
    id: job.id,
    url: job.url,
    duration: job.duration,
    output: job.output,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    downloadable: job.status === 'completed' && fs.existsSync(filePath),
  };
}

// List all recordings
app.get('/api/recordings', (_req, res) => {
  const list = Array.from(jobs.values())
    .map(jobView)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

// Start a new recording
app.post('/api/recordings', async (req, res) => {
  const { url, duration } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const id = randomUUID();
  const filename = `${id}.mp4`;

  const env = [`URL=${url}`, `OUTPUT=${filename}`];
  if (duration) env.push(`DURATION=${duration}`);

  // Bind either the named Docker volume or the local path into the recorder container
  const volumeSource = RECORDINGS_VOLUME_NAME || RECORDINGS_DIR;
  const volumeBinding = `${volumeSource}:/app/recordings`;

  let container;
  try {
    container = await docker.createContainer({
      Image: RECORDER_IMAGE,
      Env: env,
      HostConfig: {
        Binds: [volumeBinding],
        ShmSize: 1073741824, // 1 GB — Chromium needs this
      },
    });
    await container.start();
  } catch (err) {
    return res.status(500).json({ error: `Failed to start recorder: ${err.message}` });
  }

  const job = {
    id,
    url,
    duration: duration || null,
    output: filename,
    containerId: container.id,
    status: 'recording',
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);

  // Watch for container exit in the background
  container.wait().then(({ StatusCode }) => {
    const j = jobs.get(id);
    if (!j || j.status === 'completed' || j.status === 'failed') return;
    // Treat graceful stop (SIGTERM) or clean exit as completed
    const graceful = j.status === 'stopping' || StatusCode === 0 || StatusCode === null;
    j.status = graceful ? 'completed' : 'failed';
    j.completedAt = new Date().toISOString();
  }).catch(() => {
    const j = jobs.get(id);
    if (j && (j.status === 'recording' || j.status === 'stopping')) {
      j.status = 'failed';
      j.completedAt = new Date().toISOString();
    }
  });

  res.status(201).json(jobView(job));
});

// Stop an in-progress recording
app.delete('/api/recordings/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Recording not found' });
  if (job.status !== 'recording') {
    return res.status(400).json({ error: `Cannot stop a recording with status "${job.status}"` });
  }

  try {
    job.status = 'stopping';
    // SIGTERM triggers graceful shutdown in the recorder (finalizes the export)
    await docker.getContainer(job.containerId).kill({ signal: 'SIGTERM' });
    res.json({ ok: true });
  } catch (err) {
    job.status = 'failed';
    res.status(500).json({ error: err.message });
  }
});

// Download a completed recording
app.get('/api/recordings/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Recording not found' });
  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Recording is not complete yet' });
  }

  const filePath = path.join(RECORDINGS_DIR, job.output);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.download(filePath, `recording-${job.id.slice(0, 8)}.mp4`);
});

app.listen(3000, () => {
  console.log('Web Recorder UI listening on http://localhost:3000');
  console.log(`Recorder image : ${RECORDER_IMAGE}`);
  console.log(`Recordings dir : ${RECORDINGS_DIR}`);
  if (RECORDINGS_VOLUME_NAME) {
    console.log(`Volume name    : ${RECORDINGS_VOLUME_NAME}`);
  }
});
