require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const rolesRoutes = require('./routes/roles');
const creatorsRoutes = require('./routes/creators');
const maloumSentMessagesRoutes = require('./routes/maloumSentMessages');
const messagingDashboardRoutes = require('./routes/messagingDashboard');
const translateRoutes = require('./routes/translate');
const eventsRoutes = require('./routes/events');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '6mb' }));

app.use(
  '/uploads/avatars',
  (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(path.join(__dirname, '../data/avatars'))
);

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/creators', creatorsRoutes);
app.use('/api/maloum-sent-messages', maloumSentMessagesRoutes);
app.use('/api/messaging-dashboard', messagingDashboardRoutes);
app.use('/api/translate-to-german', translateRoutes);
app.use('/api/events', eventsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`DomX API running on http://localhost:${PORT}`);
});
