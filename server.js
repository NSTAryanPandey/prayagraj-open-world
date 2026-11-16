// Prayagraj Open World: a real-map open-world game (three.js + Socket.IO).
// Start: npm install, then npm start, then open http://localhost:3000
// Optional: set MONGODB_URI so the prepared city map is saved between restarts (otherwise it's kept in data/).
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let db = null;
if (process.env.MONGODB_URI) {
  const { MongoClient } = require('mongodb');
  new MongoClient(process.env.MONGODB_URI).connect()
    .then((client) => { db = client.db(process.env.MONGODB_DB || 'prayagraj'); console.log('MongoDB connected'); })
    .catch((err) => console.warn('MongoDB not connected (map will be cached in data/):', err.message));
}

app.get('/health', (_req, res) => res.json({ ok: true, storage: db ? 'mongodb' : 'file' }));
require('./world.js').attach(app, io, () => db);     // game page, /world/map.json and multiplayer

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Prayagraj Open World running → http://localhost:${PORT}`));
