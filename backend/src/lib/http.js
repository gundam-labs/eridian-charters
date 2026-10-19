const express = require('express');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** express.Router whose handlers may be async (rejections go to the error handler). */
function asyncRouter() {
  const r = express.Router();
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const orig = r[m].bind(r);
    r[m] = (path, ...fns) => orig(path, ...fns.map((f) => (typeof f === 'function' ? asyncHandler(f) : f)));
  }
  return r;
}

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

module.exports = { HttpError, asyncHandler, asyncRouter, isUuid };
