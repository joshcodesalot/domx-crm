const MODES = {
  OFF: 'off',
  SHADOW: 'shadow',
  SUGGEST_ONLY: 'suggest_only',
  AUTO_LOW_RISK: 'auto_low_risk',
  AUTO: 'auto',
  HUMAN_TAKEOVER: 'human_takeover',
};

const MODE_VALUES = Object.values(MODES);

const ROUTES = {
  AUTO_SEND: 'AUTO_SEND',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
};

const OUTPUT_SCHEMA_VERSION = 1;

const OUTPUT_ACTIONS = {
  TEXT_REPLY: 'TEXT_REPLY',
  SEND_PPV: 'SEND_PPV',
};

const OUTPUT_INTENTS = {
  RAPPORT: 'rapport',
  UPSELL: 'upsell',
  QUESTION: 'question',
  CLOSE: 'close',
  OTHER: 'other',
};

const CONVERSATION_STATES = {
  NEW: 'NEW',
  DISCOVERY: 'DISCOVERY',
  KINK_DISCOVERY: 'KINK_DISCOVERY',
  WARMUP: 'WARMUP',
  INTENSE_WARMUP: 'INTENSE_WARMUP',
  SALES_READY: 'SALES_READY',
  OFFERED: 'OFFERED',
  PURCHASED: 'PURCHASED',
  FULFILLMENT: 'FULFILLMENT',
  RETENTION: 'RETENTION',
};

const CONVERSATION_STATE_VALUES = Object.values(CONVERSATION_STATES);

function isConversationState(value) {
  return CONVERSATION_STATE_VALUES.includes(value);
}

const RULE_SCOPES = {
  GLOBAL: 'GLOBAL',
  PLATFORM: 'PLATFORM',
  CREATOR: 'CREATOR',
  FAN: 'FAN',
};

const RULE_SCOPE_VALUES = Object.values(RULE_SCOPES);

function isRuleScope(value) {
  return RULE_SCOPE_VALUES.includes(value);
}

const OUTPUT_FIELDS = {
  SCHEMA_VERSION: 'schemaVersion',
  REPLY: 'reply',
  REPLY_ENGLISH: 'replyEnglish',
  INTENT: 'intent',
  RECOMMENDED_STATE: 'recommendedState',
  ACTION: 'action',
  MEDIA_ID: 'mediaId',
  PRICE: 'price',
  CONFIDENCE: 'confidence',
  REQUIRES_HUMAN_REVIEW: 'requiresHumanReview',
  SUGGESTED_ROUTE: 'suggestedRoute',
  FLAGS: 'flags',
};

const AI_SETTING_KEYS = {
  enabled: 'ai.enabled',
  shadowAllowed: 'ai.shadow_allowed',
  suggestAllowed: 'ai.suggest_allowed',
  autoSendAllowed: 'ai.auto_send_allowed',
};

function isAiMode(value) {
  return MODE_VALUES.includes(value);
}

function defaultCreatorAiSettings() {
  return {
    mode: MODES.OFF,
    paused: false,
    takeoverByUserId: null,
    takeoverAt: null,
  };
}

module.exports = {
  MODES,
  MODE_VALUES,
  ROUTES,
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_ACTIONS,
  OUTPUT_INTENTS,
  OUTPUT_FIELDS,
  CONVERSATION_STATES,
  CONVERSATION_STATE_VALUES,
  RULE_SCOPES,
  RULE_SCOPE_VALUES,
  AI_SETTING_KEYS,
  isAiMode,
  isConversationState,
  isRuleScope,
  defaultCreatorAiSettings,
};
