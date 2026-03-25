'use strict';

const express = require('express');
const path = require('path');
const recordingsRouter = require('./routes/recordings');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/recordings', recordingsRouter);

module.exports = app;
