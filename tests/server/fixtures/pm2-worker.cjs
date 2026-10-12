const fs = require('node:fs');
const https = require('node:https');
const express = require('express');
const { createServerDrain } = require('csar-ts/server-drain');
const drain = createServerDrain({service: 'fixture-http'});
const app = express();
app.use(drain.admission);
drain.instrumentRegistration(app);
const router = drain.instrumentRegistration(express.Router());
router.route('/held').get(async (_req, res) => {
  res.end(String(process.pid));
  // The real local TLS mock holds its mutation response after our HTTP response.
  await new Promise((resolve, reject) => {
    https.get({hostname: '127.0.0.1', servername: 'localhost', port: 18444, path: '/wb-mutation', ca: fs.readFileSync('/fixture/ca.pem'), agent: false}, response => {
      response.resume(); response.once('end', resolve); response.once('error', reject);
    }).once('error', reject);
  });
});
app.use(router);
const server = https.createServer({key: fs.readFileSync('/fixture/key.pem'), cert: fs.readFileSync('/fixture/ca.pem')}, app);
const listen = () => new Promise(resolve => server.listen(18443, '127.0.0.1', resolve));
drain.attachServer(server, {resume: listen});
(async () => {
  await drain.startControl(`/fixture/control/fixture-http-${process.pid}-${drain.status().linux_start_ticks}.sock`);
  await listen();
})().catch(error => { console.error(error.message); process.exit(1); });
