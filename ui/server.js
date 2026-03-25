'use strict';

const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { Writable } = require('stream');

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
    ffmpegStartedAt: null,
    completedAt: null,
    logs: [],
  };
  jobs.set(id, job);

  streamContainerLogs(container, job);

  // Watch for container exit in the background
  container
    .wait()
    .then(({ StatusCode }) => {
      const j = jobs.get(id);
      if (!j || j.status === 'completed' || j.status === 'failed') return;
      // Treat graceful stop (SIGTERM) or clean exit as completed
      const graceful = j.status === 'stopping' || StatusCode === 0 || StatusCode === null;
      j.status = graceful ? 'completed' : 'failed';
      j.completedAt = new Date().toISOString();
      closeJobSse(id);
    })
    .catch(() => {
      const j = jobs.get(id);
      if (j && (j.status === 'recording' || j.status === 'stopping')) {
        j.status = 'failed';
        j.completedAt = new Date().toISOString();
        closeJobSse(id);
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

// SSE endpoint: stream container logs in real time
app.get('/api/recordings/:id/logs', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Recording not found' });

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

app.listen(3000, () => {
  console.log('Web Recorder UI listening on http://localhost:3000');
  console.log(`Recorder image : ${RECORDER_IMAGE}`);
  console.log(`Recordings dir : ${RECORDINGS_DIR}`);
  if (RECORDINGS_VOLUME_NAME) {
    console.log(`Volume name    : ${RECORDINGS_VOLUME_NAME}`);
  }

  // Check if recordings directory is writable
  fs.access(RECORDINGS_DIR, fs.constants.W_OK, (err) => {
    if (err) {
      console.error(
        `Error: Recordings directory "${RECORDINGS_DIR}" is not writable. Please ensure it exists and has the correct permissions.`,
      );
    } else {
      console.log(`Recordings directory "${RECORDINGS_DIR}" is writable.`);
    }
  });
});
