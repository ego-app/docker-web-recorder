'use strict';

const { timingSafeEqual } = require('crypto');
const { UI_USERNAME, UI_PASSWORD } = require('../config');

function safeEqual(a, b) {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA); // dummy compare to avoid timing leak on length
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
	if (!UI_USERNAME || !UI_PASSWORD) return next();

	const authHeader = req.headers.authorization || '';
	if (authHeader.startsWith('Basic ')) {
		const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
		const colon = decoded.indexOf(':');
		if (colon !== -1) {
			const user = decoded.slice(0, colon);
			const pass = decoded.slice(colon + 1);
			if (safeEqual(user, UI_USERNAME) && safeEqual(pass, UI_PASSWORD)) {
				return next();
			}
		}
	}

	res.set('WWW-Authenticate', 'Basic realm="Web Recorder"');
	res.status(401).send('Autenticazione richiesta.');
}

module.exports = basicAuth;
