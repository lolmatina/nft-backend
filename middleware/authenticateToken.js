const jwt = require('jsonwebtoken');
require('dotenv').config(); // Ensure dotenv is configured

function authenticateToken(req, res, next) {
  let token = req.cookies.token;
  let tokenSource = 'cookie';

  if (!token) {
    const authHeader = req.header('Authorization');
    if (authHeader) {
      console.log('[AuthMiddleware] Authorization header found:', authHeader); // Log the raw header
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
        tokenSource = 'Bearer';
        console.log('[AuthMiddleware] Token extracted from Bearer header:', token);
      } else {
        console.log('[AuthMiddleware] Malformed Bearer token');
        return res.status(401).json({ msg: 'Token is not in Bearer format, authorization denied' });
      }
    } else {
      console.log('[AuthMiddleware] No Authorization header found');
    }
  }

  if (!token) {
    console.log('[AuthMiddleware] No token found from any source.');
    return res.status(401).json({ msg: 'No token (cookie or Bearer), authorization denied.' });
  }

  console.log(`[AuthMiddleware] Attempting to verify token from ${tokenSource}. Token: ${token}`);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('[AuthMiddleware] Token verified successfully. Decoded payload:', decoded);
    req.user = decoded.user;
    if (!req.user || !req.user.id) {
        console.error('[AuthMiddleware] JWT decoded, but user object or user.id is missing in token payload:', decoded);
        return res.status(401).json({ msg: 'Token payload is invalid (missing user or user.id).' });
    }
    next();
  } catch (err) {
    console.error(`[AuthMiddleware] Token verification error (source: ${tokenSource}):`, err.message, err.name);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token has expired.' });
    } else if (err.name === 'JsonWebTokenError') {
      // This includes 'invalid signature', 'jwt malformed', etc.
      return res.status(401).json({ msg: `Token is malformed or signature is invalid: ${err.message}` });
    }
    return res.status(401).json({ msg: 'Token is not valid.' });
  }
}

module.exports = authenticateToken; 