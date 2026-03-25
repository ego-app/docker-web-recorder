'use strict';

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/recordings';
const RECORDER_IMAGE = process.env.RECORDER_IMAGE || 'docker-web-recorder:latest';
const RECORDINGS_VOLUME_NAME = process.env.RECORDINGS_VOLUME_NAME || null;
const VOLUME_SOURCE = RECORDINGS_VOLUME_NAME || RECORDINGS_DIR;
const UI_USERNAME = process.env.UI_USERNAME || null;
const UI_PASSWORD = process.env.UI_PASSWORD || null;

module.exports = { RECORDINGS_DIR, RECORDER_IMAGE, RECORDINGS_VOLUME_NAME, VOLUME_SOURCE, UI_USERNAME, UI_PASSWORD };
