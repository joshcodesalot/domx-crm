require('dotenv').config();
const fs = require('fs');
const { dataPath, ensureDataDirs } = require('./services/dataDir');
ensureDataDirs();

function crashDetails(reason) {
  if (reason instanceof Error) {
    return {
      name: reason.name || 'Error',
      message: reason.message || '',
      stack: reason.stack || '',
    };
  }
  return {
    name: 'UnhandledRejection',
    message: String(reason),
    stack: '',
  };
}

function writeCrashLog(kind, reason) {
  const details = crashDetails(reason);
  const entry = [
    '---',
    new Date().toISOString(),
    kind,
    `${details.name}: ${details.message}`,
    details.stack,
    '',
  ].join('\n');
  try {
    fs.appendFileSync(dataPath('crash.log'), entry);
  } catch (err) {
    console.error('[crash] Failed to write crash log:', err.message || err);
  }
  console.error(`[crash] ${kind}: ${details.name}: ${details.message}`);
  if (details.stack) console.error(details.stack);
}

process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeCrashLog('unhandledRejection', reason);
});

require('./services/jwtSecret').resolveJwtSecret();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const rolesRoutes = require('./routes/roles');
const creatorsRoutes = require('./routes/creators');
const creators4basedRoutes = require('./routes/creators4based');
const creatorsMaloumRoutes = require('./routes/creatorsMaloum');
const fanslyRoutes = require('./routes/fansly');
const maloumFanScrapeRoutes = require('./routes/maloumFanScrape');
const maloumCommentGuardRoutes = require('./routes/maloumCommentGuard');
const fourbasedFanScrapeRoutes = require('./routes/fourbasedFanScrape');
const maloumSentMessagesRoutes = require('./routes/maloumSentMessages');
const messagingDashboardRoutes = require('./routes/messagingDashboard');
const fanCrmActivityRoutes = require('./routes/fanCrmActivity');
const chatArchiveRoutes = require('./routes/chatArchive');
const loginActivityRoutes = require('./routes/loginActivity');
const saleReconciliationRoutes = require('./routes/saleReconciliation');
const translateRoutes = require('./routes/translate');
const translateToEnglishRoutes = require('./routes/translateToEnglish');
const eventsRoutes = require('./routes/events');
const moderationRoutes = require('./routes/moderation');
const activityRoutes = require('./routes/activity');
const contentScheduleRoutes = require('./routes/contentSchedule');
const telegramRoutes = require('./routes/telegram');
const telegramListRoutes = require('./routes/telegramLists');
const telegramMassMessageRoutes = require('./routes/telegramMassMessages');
const massMessageLockRoutes = require('./routes/massMessageLocks');
const telegramSextingSessionRoutes = require('./routes/telegramSextingSessions');
const throneWebhookRoutes = require('./routes/throneWebhook');
const throneRoutes = require('./routes/throne');
const {
  startMaloumTokenRefreshScheduler,
} = require('./services/maloumTokenRefresh');
const { startContentScheduleRunner } = require('./services/contentScheduleRunner');
const logger = require('./services/logger');
const opsRoutes = require('./routes/ops');
const {
  recordRequest,
  recordHandlerError,
  routeSource,
  startOpsRetention,
} = require('./services/opsEvents');

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
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const fields = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    };
    if (req.user) fields.userId = req.user.id;
    logger.info('request', fields);
    recordRequest({
      method: fields.method,
      path: fields.path,
      status: fields.status,
      durationMs: fields.durationMs,
      source: routeSource(req),
    });
  });
  next();
});
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
app.use('/api/creators', massMessageLockRoutes);
app.use('/api/creators', fanslyRoutes);
app.use('/api/creators', creators4basedRoutes);
app.use('/api/creators', creatorsMaloumRoutes);
app.use('/api/creators', creatorsRoutes);
app.use('/api/creators', maloumFanScrapeRoutes);
app.use('/api/creators', maloumCommentGuardRoutes);
app.use('/api/creators', fourbasedFanScrapeRoutes);
app.use('/api/maloum-sent-messages', maloumSentMessagesRoutes);
app.use('/api/messaging-dashboard', messagingDashboardRoutes);
app.use('/api/fan-crm-activity', fanCrmActivityRoutes);
app.use('/api/chat-archive', chatArchiveRoutes);
app.use('/api/login-activity', loginActivityRoutes);
app.use('/api/sale-reconciliation', saleReconciliationRoutes);
app.use('/api/translate-to-german', translateRoutes);
app.use('/api/translate-to-english', translateToEnglishRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/scheduled-content', contentScheduleRoutes);
app.use('/api/telegram-sexting-sessions', telegramSextingSessionRoutes);
app.use('/api/throne', throneRoutes);
app.use('/api/browser-profiles', browserProfileRoutes);
app.use('/api/ops', opsRoutes);

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
  logger.error(err.message || 'Internal server error', { path: req.path });
  recordHandlerError(err, req);
  res.status(500).json({ error: 'Internal server error' });
});

function processRole() {
  const role = String(process.env.PROCESS_ROLE || '').trim().toLowerCase();
  if (role === 'api' || role === 'worker') return role;
  return 'all';
}

function startMovableWorkers() {
  startMaloumTokenRefreshScheduler();
  startContentScheduleRunner();
  const { startFanChatArchiveWorker } = require('./services/fanChatArchive');
  startFanChatArchiveWorker();
  const {
    startMaloumCommentGuard,
  } = require('./services/maloumCommentGuard');
  startMaloumCommentGuard();
  startOpsRetention();
}

function startInProcessWorkers() {
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
}

if (processRole() === 'worker') {
  startMovableWorkers();
  setInterval(() => {}, 60_000);
} else {
  app.listen(PORT, () => {
    console.log(`DomX API running on http://localhost:${PORT}`);
    if (processRole() !== 'api') startMaloumTokenRefreshScheduler();
    startInProcessWorkers();
    if (processRole() !== 'api') {
      startContentScheduleRunner();
      const { startFanChatArchiveWorker } = require('./services/fanChatArchive');
      startFanChatArchiveWorker();
      const {
        startMaloumCommentGuard,
      } = require('./services/maloumCommentGuard');
      startMaloumCommentGuard();
      startOpsRetention();
    }
  });
}
