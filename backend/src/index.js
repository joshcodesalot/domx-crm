require('dotenv').config();
const { dataPath, ensureDataDirs } = require('./services/dataDir');
ensureDataDirs();
require('./services/jwtSecret').resolveJwtSecret();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const rolesRoutes = require('./routes/roles');
const creatorsRoutes = require('./routes/creators');
const maloumFanScrapeRoutes = require('./routes/maloumFanScrape');
const maloumCommentGuardRoutes = require('./routes/maloumCommentGuard');
const fourbasedFanScrapeRoutes = require('./routes/fourbasedFanScrape');
const maloumSentMessagesRoutes = require('./routes/maloumSentMessages');
const messagingDashboardRoutes = require('./routes/messagingDashboard');
const saleReconciliationRoutes = require('./routes/saleReconciliation');
const translateRoutes = require('./routes/translate');
const eventsRoutes = require('./routes/events');
const moderationRoutes = require('./routes/moderation');
const activityRoutes = require('./routes/activity');
const contentScheduleRoutes = require('./routes/contentSchedule');
const telegramRoutes = require('./routes/telegram');
const telegramListRoutes = require('./routes/telegramLists');
const telegramMassMessageRoutes = require('./routes/telegramMassMessages');
const telegramSextingSessionRoutes = require('./routes/telegramSextingSessions');
const throneWebhookRoutes = require('./routes/throneWebhook');
const throneRoutes = require('./routes/throne');
const {
  startMaloumTokenRefreshScheduler,
} = require('./services/maloumTokenRefresh');
const { startContentScheduleRunner } = require('./services/contentScheduleRunner');

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
app.use(
  '/api/webhooks/throne',
  express.raw({ type: 'application/json' }),
  throneWebhookRoutes
);
const browserProfileRoutes = require('./routes/browserProfiles');
app.put(
  '/api/browser-profiles/:creatorId/archive',
  express.raw({ limit: '200mb', type: () => true }),
  (req, res, next) => {
    browserProfileRoutes.uploadBrowserProfileArchive(req, res).catch(next);
  }
);
app.use(express.json({ limit: '6mb' }));

app.use(
  '/uploads/avatars',
  (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(dataPath('avatars'))
);
app.use(
  '/uploads/telegram-fans',
  (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(dataPath('telegram-fans'))
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
app.use('/api/creators', telegramRoutes);
app.use('/api/creators', telegramListRoutes);
app.use('/api/creators', telegramMassMessageRoutes);
app.use('/api/creators', creatorsRoutes);
app.use('/api/creators', maloumFanScrapeRoutes);
app.use('/api/creators', maloumCommentGuardRoutes);
app.use('/api/creators', fourbasedFanScrapeRoutes);
app.use('/api/maloum-sent-messages', maloumSentMessagesRoutes);
app.use('/api/messaging-dashboard', messagingDashboardRoutes);
app.use('/api/sale-reconciliation', saleReconciliationRoutes);
app.use('/api/translate-to-german', translateRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/scheduled-content', contentScheduleRoutes);
app.use('/api/telegram-sexting-sessions', telegramSextingSessionRoutes);
app.use('/api/throne', throneRoutes);
app.use('/api/browser-profiles', browserProfileRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    const tooLargeProfile =
      req.method === 'PUT' && /\/api\/browser-profiles\/[^/]+\/archive$/.test(req.path);
    return res.status(413).json({
      error: tooLargeProfile ? 'Profile archive is too large' : 'Request is too large',
    });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`DomX API running on http://localhost:${PORT}`);
  startMaloumTokenRefreshScheduler();
  const {
    startFourBasedSocketManager,
  } = require('./services/fourBasedSocket');
  startFourBasedSocketManager();
  const { startTelegramManager } = require('./services/telegramWorker');
  void startTelegramManager();
  const {
    resumeRunningJobs: resumeMaloumFanScrapeJobs,
  } = require('./services/maloumFanScrapeRunner');
  void resumeMaloumFanScrapeJobs();
  const {
    resumeRunningJobs: resumeFourBasedFanScrapeJobs,
  } = require('./services/fourbasedFanScrapeRunner');
  void resumeFourBasedFanScrapeJobs();
  startContentScheduleRunner();
  const {
    startMaloumCommentGuard,
  } = require('./services/maloumCommentGuard');
  startMaloumCommentGuard();
});
