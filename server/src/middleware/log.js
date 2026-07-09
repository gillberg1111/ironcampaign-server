export function requestLogger(req, res, next) {
  if (process.env.LOG_REQUESTS !== '1') return next();

  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const ms = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
    // req.path deliberately excludes the query string, so credentials can never appear here.
    const { method, path: url } = res.req;
    console.log(`${method} ${url} ${res.statusCode} ${ms}`);
  });

  next();
}
