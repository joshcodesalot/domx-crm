function isNightTheme(theme) {
  return theme === 'night' || theme === 'dark' || theme === true;
}

const MALOUM_ADD_LIST_PATH = '/lists/add/member';
const MALOUM_VAULT_PATH = '/vault';

const ADD_LIST_SIDEBAR_SELECTOR = '#root > div > section';
const ADD_LIST_MAIN_DIV_SELECTOR = '#root > div > div';
const NEW_LIST_BUTTON_SELECTOR =
  '#root > div > div > div > header > div > div.-mr-2.flex.basis-1\\/2.justify-end > button';
const CREATE_NEW_LIST_DIV_SELECTOR =
  '#root > div > div > div > div.mx-auto.flex.w-full.max-w-xl.flex-col.px-4.grow > div:nth-child(1) > div.relative.flex.flex-col.gap-1\\.5.pb-16 > div.flex.h-full.w-full.grow.flex-col.items-center.justify-center.gap-3.py-12.text-center';

const VAULT_SIDEBAR_SELECTOR = '#root > div > section';
const VAULT_PANEL_SELECTOR = '#root > div > div';
const VAULT_NEW_FOLDER_BUTTON_SELECTOR =
  '#leftColumn > div > header > div > div.-mr-2.flex.basis-1\\/2.justify-end.mr-0.min-w-fit.md\\:-mr-4';
const VAULT_ADD_CONTENT_BUTTON_SELECTOR =
  '#rightColumn > div > div:nth-child(1) > div.relative.flex.h-full.flex-col > div > button';

const MEMBER_NOTES_BUTTON_SELECTOR =
  '#rightColumn > div > div:nth-child(4) > div.mt-2 > button';

const SEND_MESSAGE_BUTTON_SELECTOR =
  '#headlessui-tabs-panel-\\:rg\\: > div.md\\:max-w-chat.sticky.bottom-0.z-\\[51\\].mx-auto.w-full.max-w-xl > div > div > div > button';

const SEND_MESSAGE_BUTTON_STRUCTURE_SELECTOR =
  '[id^="headlessui-tabs-panel"] > div.md\\:max-w-chat.sticky.bottom-0.z-\\[51\\].mx-auto.w-full.max-w-xl > div > div > div > button';

const { getApiUrl } = require('./apiConfig');

const DOMX_API_BASE = getApiUrl();
const DOMX_TRANSLATE_TO_GERMAN_URL = `${DOMX_API_BASE}/api/translate-to-german`;

const DOMX_SENT_BY_LABEL_CSS = `
  .domx-sent-by-label {
    display: block;
    margin-top: 4px;
    padding: 2px 8px;
    width: fit-content;
    max-width: 100%;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: 0.01em;
    color: #4f46e5;
    background: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.22);
    pointer-events: none;
    user-select: none;
  }

  .domx-night-mode .domx-sent-by-label {
    color: #a5b4fc;
    background: rgba(99, 102, 241, 0.2);
    border-color: rgba(129, 140, 248, 0.35);
  }
`;

const DOMX_TRANSLATION_CSS = `
  .domx-translation-box {
    display: block;
    margin-top: 6px;
    padding: 7px 9px;
    width: fit-content;
    max-width: 100%;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.35;
    white-space: pre-wrap;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    color: #374151;
    pointer-events: none;
    user-select: text;
  }

  .domx-translation-box.domx-error {
    padding: 0;
    border: none;
    background: transparent;
    color: #ef4444;
    font-size: 12px;
  }

  .domx-translate-button {
    display: block;
    margin-top: 6px;
    padding: 4px 8px;
    width: fit-content;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.3;
    cursor: pointer;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #374151;
  }

  .domx-translate-button:hover:not(:disabled) {
    background: #f3f4f6 !important;
    border-color: #9ca3af !important;
  }

  .domx-translate-button:disabled {
    opacity: 0.65;
    cursor: wait;
  }

  .domx-night-mode .domx-translation-box {
    border-color: #374151;
    background: #111827;
    color: #d1d5db;
  }

  .domx-night-mode .domx-translation-box.domx-error {
    border: none;
    background: transparent;
    color: #ef4444;
  }

  .domx-night-mode .domx-translate-button {
    border-color: #374151;
    background: #1f2937;
    color: #e5e7eb;
  }

  .domx-night-mode .domx-translate-button:hover:not(:disabled) {
    background: #374151 !important;
    border-color: #4b5563 !important;
  }
`;

const MEMBER_NOTES_TEMPLATE = `😈 Fetishes / Kinks:
🎓 Experience Level:
🚫 Hard Limits:
🧸 Toys Owned:
👑 VIP Status:
📦 Ongoing Sessions / Tasks:
✅ Progress / Completed:
🫶 Aftercare Needs:
📝 Last Session Notes:
🎂 Age:
📍 Location:
💍 Relationship Status:`;

const MALOUM_NIGHT_MODE_CSS = `
  html.domx-night-mode,
  body.domx-night-mode {
    background: #0f1115 !important;
    color: #e5e7eb !important;
  }

  .domx-night-mode #root,
  .domx-night-mode #root > div,
  .domx-night-mode #root > div > div,
  .domx-night-mode #root > div > div > div,
  .domx-night-mode #leftColumn,
  .domx-night-mode #rightColumn,
  .domx-night-mode main,
  .domx-night-mode section,
  .domx-night-mode header,
  .domx-night-mode footer {
    background: #0f1115 !important;
    color: #e5e7eb !important;
  }

  .domx-night-mode .bg-white,
  .domx-night-mode .bg-gray-50,
  .domx-night-mode .bg-gray-100,
  .domx-night-mode .bg-beige-300,
  .domx-night-mode .bg-beige-400 {
    background-color: #161a22 !important;
  }

  .domx-night-mode .text-gray-900,
  .domx-night-mode .text-gray-800,
  .domx-night-mode .text-gray-700,
  .domx-night-mode .text-black {
    color: #f3f4f6 !important;
  }

  .domx-night-mode .text-gray-600,
  .domx-night-mode .text-gray-500 {
    color: #9ca3af !important;
  }

  .domx-night-mode .border-gray-100,
  .domx-night-mode .border-gray-200,
  .domx-night-mode .border-gray-300 {
    border-color: #2a2f3a !important;
  }

  .domx-night-mode input,
  .domx-night-mode textarea,
  .domx-night-mode [contenteditable="true"] {
    background-color: #111827 !important;
    color: #f9fafb !important;
    border-color: #374151 !important;
  }

  .domx-night-mode input::placeholder,
  .domx-night-mode textarea::placeholder {
    color: #6b7280 !important;
  }

  .domx-night-mode a:hover,
  .domx-night-mode button:hover {
    background-color: #202634 !important;
  }

  .domx-night-mode .hover\\:bg-beige-400:hover,
  .domx-night-mode .hover\\:bg-beige-300:hover,
  .domx-night-mode .active\\:bg-beige-300:active,
  .domx-night-mode .active\\:bg-beige-400:active {
    background-color: #202634 !important;
  }

  .domx-night-mode svg {
    color: inherit;
  }

  .domx-night-mode img {
    filter: brightness(0.9);
  }
`;

function getMaloumPageKind(url) {
  if (!url) return null;
  if (url.includes(MALOUM_ADD_LIST_PATH)) return 'addList';
  if (url.includes(MALOUM_VAULT_PATH)) return 'vault';
  if (url.includes('/chat') && !url.includes('/login')) return 'chat';
  return null;
}

function isMaloumAppUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('maloum.com') && !parsed.pathname.includes('/login');
  } catch {
    return url.includes('maloum.com') && !url.includes('/login');
  }
}

function getAddListDomUtilsScript() {
  return `
      const hideAddListEmptyState = (emptyStateSelector) => {
        const emptyState = document.querySelector(emptyStateSelector);
        if (!emptyState) return false;
        emptyState.style.display = 'none';
        return true;
      };
  `;
}

function getDomxSentByLabelUtilsScript() {
  return `
      const ensureDomxSentByStyles = () => {
        if (document.getElementById('domx-sent-by-label-styles')) return;

        const style = document.createElement('style');
        style.id = 'domx-sent-by-label-styles';
        style.textContent = ${JSON.stringify(DOMX_SENT_BY_LABEL_CSS)};
        document.head.appendChild(style);
      };

      const TIMESTAMP_TEXT_PATTERN = /^\\d{1,2}:\\d{2}$/;

      const findMessageTimestampElement = (messageEl) => {
        if (!messageEl) return null;

        const candidates = messageEl.querySelectorAll(
          'span, div, p, time, small, [class*="text-gray"], [class*="text-xs"]'
        );

        for (const el of candidates) {
          if (
            el.classList.contains('domx-translation-box') ||
            el.classList.contains('domx-translate-button') ||
            el.classList.contains('domx-sent-by-label') ||
            el.closest('.domx-translation-box, .domx-translate-button, .domx-sent-by-label')
          ) {
            continue;
          }

          const text = el.textContent?.trim() || '';
          if (TIMESTAMP_TEXT_PATTERN.test(text)) {
            return el;
          }
        }

        return null;
      };

      const applyDomxSentByLabel = (element) => {
        if (!element) return false;

        const tracked = element.getAttribute('data-domx-tracked') === 'true';
        const userName = element.getAttribute('data-domx-sent-by-user-name');
        if (!tracked || !userName) return false;

        ensureDomxSentByStyles();

        let label = element.querySelector('.domx-sent-by-label');
        if (!label) {
          label = document.createElement('span');
          label.className = 'domx-sent-by-label';
        }

        const nextText = 'Sent by ' + userName;
        if (label.textContent !== nextText) {
          label.textContent = nextText;
        }

        const timestampEl = findMessageTimestampElement(element);
        if (timestampEl && timestampEl.parentElement) {
          if (label.nextElementSibling !== timestampEl) {
            timestampEl.parentElement.insertBefore(label, timestampEl);
          }
        } else if (!label.parentElement) {
          element.appendChild(label);
        }

        return true;
      };

      const applyDomxSentByLabels = () => {
        document
          .querySelectorAll('[data-domx-tracked="true"][data-domx-sent-by-user-name]')
          .forEach(applyDomxSentByLabel);
      };
  `;
}

function getSendButtonUtilsScript() {
  return `
      const SEND_MESSAGE_BUTTON_SELECTORS = [
        ${JSON.stringify(SEND_MESSAGE_BUTTON_SELECTOR)},
        ${JSON.stringify(SEND_MESSAGE_BUTTON_STRUCTURE_SELECTOR)},
      ];

      const getButtonLabel = (button) => {
        if (!button) return '';
        return (button.textContent || button.getAttribute('aria-label') || '').trim().slice(0, 120);
      };

      const isLikelySendMessageButton = (button) => {
        if (!button || button.tagName !== 'BUTTON') return false;

        const label = getButtonLabel(button).toLowerCase();
        if (!label) return true;

        if (
          /add price|price for your media|delete this message|to mass message|mass message/.test(
            label
          )
        ) {
          return false;
        }

        return true;
      };

      const resolveSendMessageButton = () => {
        for (const selector of SEND_MESSAGE_BUTTON_SELECTORS) {
          const buttons = document.querySelectorAll(selector);

          for (const button of buttons) {
            if (isLikelySendMessageButton(button)) return button;
          }
        }

        return null;
      };

      const findSendMessageButton = (target) => {
        if (!target) return null;

        const sendButton = resolveSendMessageButton();
        if (!sendButton) return null;

        if (target === sendButton || sendButton.contains(target)) {
          return sendButton;
        }

        for (const selector of SEND_MESSAGE_BUTTON_SELECTORS) {
          const match = target.closest(selector);
          if (match && isLikelySendMessageButton(match)) return match;
        }

        return null;
      };

      const findMaloumMessageInput = () => {
        return (
          document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('input[type="text"]')
        );
      };

      const dispatchEnterOnMessageInput = (input) => {
        if (!input) return false;

        input.focus();

        const eventInit = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        };

        input.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        input.dispatchEvent(new KeyboardEvent('keypress', eventInit));
        input.dispatchEvent(new KeyboardEvent('keyup', eventInit));

        return true;
      };

      const triggerMaloumSend = () => {
        const input = findMaloumMessageInput();

        if (input) {
          return dispatchEnterOnMessageInput(input);
        }

        return false;
      };
  `;
}

function getSentMessageTrackingScript(activeChatter) {
  const chatter = activeChatter || { userId: null, userName: null };

  return `
      const DOMX_ACTIVE_CHATTER = ${JSON.stringify(chatter)};

      ${getDomxSentByLabelUtilsScript()}
      ${getSendButtonUtilsScript()}

      const syncActiveChatterSnapshot = () => {
        if (DOMX_ACTIVE_CHATTER.userId) {
          window.__domxActiveChatter = {
            userId: DOMX_ACTIVE_CHATTER.userId,
            userName: DOMX_ACTIVE_CHATTER.userName || 'Unknown',
          };
        }
      };

      const installSendButtonClickTracking = () => {
        if (window.__domxSendButtonClickTrackingInstalled) return;
        window.__domxSendButtonClickTrackingInstalled = true;

        syncActiveChatterSnapshot();

        document.addEventListener('click', (event) => {
          const button = findSendMessageButton(event.target);
          if (!button) return;

          syncActiveChatterSnapshot();

          window.__domxLastSendButtonClickAt = Date.now();
          window.__domxSendClickAttribution = window.__domxActiveChatter
            ? { ...window.__domxActiveChatter }
            : null;
        }, true);
      };

      const installMaloumMessageDomObserver = () => {
        if (window.__domxMessageObserverInstalled) return;
        window.__domxMessageObserverInstalled = true;

        const observer = new MutationObserver(() => {
          applyDomxSentByLabels();
          window.dispatchEvent(new CustomEvent('domx-maloum-messages-mutated'));
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'data-message-id',
            'data-domx-tracked',
            'data-domx-sent-by-user-name',
          ],
        });

        window.__domxMaloumMessageObserver = observer;
        applyDomxSentByLabels();
      };
  `;
}

function getMaloumTranslationScript(historyEnabled = true) {
  return `
      const TRANSLATE_API_URL = 'https://translate.low7labs.cloud/translate';
      const MALOUM_MESSAGE_SELECTOR = '#messages-list-container [data-message-id]';

      window.__domxHistoryTranslateEnabled = ${historyEnabled ? 'true' : 'false'};

      const ensureDomxTranslationStyles = () => {
        if (document.getElementById('domx-translation-styles')) return;

        const style = document.createElement('style');
        style.id = 'domx-translation-styles';
        style.textContent = ${JSON.stringify(DOMX_TRANSLATION_CSS)};
        document.head.appendChild(style);
      };

      const MESSAGE_META_TEXT_PATTERN =
        /^(?:\\d{1,2}:\\d{2}|\\d{1,2}[\\/\\.]\\d{1,2}[\\/\\.]\\d{2,4}(?:\\s+\\d{1,2}:\\d{2})?|(?:yesterday|today|gestern|heute)(?:\\s+\\d{1,2}:\\d{2})?)$/i;

      const MESSAGE_META_TOKEN_PATTERNS = [
        /(?:^|[\\s,.;:!?\\u00a0])(?:\\d{1,2}[\\/\\.]\\d{1,2}[\\/\\.]\\d{2,4})(?:\\s+\\d{1,2}:\\d{2})?(?=$|[\\s,.;:!?\\u00a0])/gi,
        /(?:^|[\\s,.;:!?\\u00a0])\\d{1,2}:\\d{2}(?=$|[\\s,.;:!?\\u00a0])/g,
      ];

      const MESSAGE_META_PREFIX_PATTERNS = [
        /^(?:\\d{1,2}[\\/\\.]\\d{1,2}[\\/\\.]\\d{2,4})(?:\\s+\\d{1,2}:\\d{2})?[\\s\\u00a0]+/i,
        /^(?:yesterday|today|gestern|heute)(?:\\s+\\d{1,2}:\\d{2})?[\\s\\u00a0]+/i,
        /^\\d{1,2}:\\d{2}[\\s\\u00a0]+/,
      ];

      const MESSAGE_META_SUFFIX_PATTERNS = [
        /[\\s\\u00a0]+(?:\\d{1,2}[\\/\\.]\\d{1,2}[\\/\\.]\\d{2,4})(?:\\s+\\d{1,2}:\\d{2})?\\s*$/i,
        /[\\s\\u00a0]+(?:yesterday|today|gestern|heute)(?:\\s+\\d{1,2}:\\d{2})?\\s*$/i,
        /[\\s\\u00a0]+\\d{1,2}:\\d{2}\\s*$/,
        /(?:^|[\\s,.;:!?\\u00a0])(?:\\d{1,2}[\\/\\.]\\d{1,2}[\\/\\.]\\d{2,4})\\s*$/i,
        /(?:^|[\\s,.;:!?\\u00a0])(?:yesterday|today|gestern|heute)\\s*$/i,
      ];

      const isMessageMetaText = (text) => {
        if (!text) return false;
        return MESSAGE_META_TEXT_PATTERN.test(text.trim());
      };

      const removeMetaTokensFromText = (text) => {
        if (!text) return '';

        let cleaned = text;
        for (const pattern of MESSAGE_META_TOKEN_PATTERNS) {
          cleaned = cleaned.replace(pattern, ' ');
        }

        return cleaned.replace(/\\s+/g, ' ').trim();
      };

      const stripMessageMetaFromText = (text) => {
        if (!text) return '';

        let cleaned = removeMetaTokensFromText(text.trim());
        let changed = true;

        while (changed) {
          changed = false;

          for (const pattern of MESSAGE_META_PREFIX_PATTERNS) {
            const next = cleaned.replace(pattern, '').trim();
            if (next !== cleaned) {
              cleaned = next;
              changed = true;
            }
          }

          for (const pattern of MESSAGE_META_SUFFIX_PATTERNS) {
            const next = cleaned.replace(pattern, '').trim();
            if (next !== cleaned) {
              cleaned = next;
              changed = true;
            }
          }
        }

        return removeMetaTokensFromText(cleaned);
      };

      const isLeafMessageElement = (messageEl) => {
        return !messageEl.querySelector('[data-message-id]');
      };

      const CONTROL_REMOVE_SELECTOR = [
        '.domx-translation-box',
        '.domx-translate-button',
        '.domx-sent-by-label',
        'button',
        'svg',
        '[data-domx-ignore]',
        '[aria-hidden="true"]',
      ].join(',');

      const getMessageBubbleText = (el) => {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll(CONTROL_REMOVE_SELECTOR).forEach((node) => node.remove());
        return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
      };

      const findMessageContentElement = (messageEl) => {
        if (!messageEl) return null;

        const skipSelector =
          '.domx-translation-box, .domx-translate-button, .domx-sent-by-label, button, svg, [data-domx-ignore]';

        const bubbleCandidates = Array.from(
          messageEl.querySelectorAll(
            'div[class*="rounded"], p[class*="rounded"], span[class*="rounded"]'
          )
        ).filter((el) => {
          if (el.matches(skipSelector) || el.closest(skipSelector)) return false;

          const className = typeof el.className === 'string' ? el.className : '';
          return /(?:^|\\s)(?:bg-|beige|gray)/.test(className);
        });

        const textCandidates = bubbleCandidates.length
          ? bubbleCandidates
          : Array.from(messageEl.querySelectorAll('div, p, span')).filter((el) => {
              if (el.matches(skipSelector) || el.closest(skipSelector)) return false;
              if (el.querySelector('div, p, span')) return false;
              return true;
            });

        let best = null;
        let bestScore = 0;

        for (const el of textCandidates) {
          const text = stripMessageMetaFromText(getMessageBubbleText(el));
          if (!text || isMessageMetaText(text)) continue;

          if (text.length > bestScore) {
            bestScore = text.length;
            best = el;
          }
        }

        return best || messageEl;
      };

      const removeMessageMetaElements = (root) => {
        const candidates = Array.from(
          root.querySelectorAll(
            'span, div, p, time, small, [class*="text-gray"], [class*="text-xs"]'
          )
        ).sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length);

        for (const el of candidates) {
          if (!el.isConnected) continue;

          if (
            el.classList.contains('domx-translation-box') ||
            el.classList.contains('domx-translate-button') ||
            el.classList.contains('domx-sent-by-label') ||
            el.closest('.domx-translation-box, .domx-translate-button, .domx-sent-by-label')
          ) {
            continue;
          }

          const text = el.textContent?.trim() || '';
          if (isMessageMetaText(text)) {
            el.remove();
          }
        }
      };

      const findMessageTimestampElement = (messageEl) => {
        if (!messageEl) return null;

        const candidates = messageEl.querySelectorAll(
          'span, div, p, time, small, [class*="text-gray"], [class*="text-xs"]'
        );

        for (const el of candidates) {
          if (
            el.classList.contains('domx-translation-box') ||
            el.classList.contains('domx-translate-button') ||
            el.classList.contains('domx-sent-by-label') ||
            el.closest('.domx-translation-box, .domx-translate-button, .domx-sent-by-label')
          ) {
            continue;
          }

          const text = el.textContent?.trim() || '';
          if (isMessageMetaText(text)) {
            return el;
          }
        }

        return null;
      };

      const insertDomxElementBeforeTimestamp = (messageEl, element) => {
        if (!messageEl || !element) return;

        const timestampEl = findMessageTimestampElement(messageEl);

        if (timestampEl && timestampEl.parentElement) {
          timestampEl.parentElement.insertBefore(element, timestampEl);
          return;
        }

        if (!element.parentElement) {
          messageEl.appendChild(element);
        }
      };

      const extractMessageText = (messageEl) => {
        if (!messageEl) return '';

        const contentEl = findMessageContentElement(messageEl);
        const cloned = contentEl.cloneNode(true);

        cloned.querySelectorAll(CONTROL_REMOVE_SELECTOR).forEach((el) => el.remove());

        removeMessageMetaElements(cloned);

        const text = cloned.innerText?.trim() || cloned.textContent?.trim() || '';
        if (!text) return '';

        const ignoredTexts = [
          'Media',
          'Exclusive content',
          'Translate',
          'Translating...',
          'Translation failed',
        ];

        if (ignoredTexts.includes(text)) return '';

        const lines = text
          .split('\\n')
          .map((line) => stripMessageMetaFromText(line.trim()))
          .filter(Boolean)
          .filter((line) => !ignoredTexts.includes(line))
          .filter((line) => !isMessageMetaText(line));

        return stripMessageMetaFromText(lines.join(' ').trim());
      };

      const translateTextToEnglish = async (text) => {
        if (!text || !text.trim()) return null;

        const response = await fetch(TRANSLATE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: text,
            source: 'de',
            target: 'en',
            format: 'text',
          }),
        });

        if (!response.ok) {
          throw new Error('Translation API failed with status ' + response.status);
        }

        const data = await response.json();
        return data?.translatedText || null;
      };

      const insertTranslationBox = (messageEl, translatedText) => {
        if (!messageEl || !translatedText) return;

        const cleanedText = stripMessageMetaFromText(translatedText);
        if (!cleanedText) return;

        let box = messageEl.querySelector(':scope > .domx-translation-box, :scope .domx-translation-box');

        if (!box) {
          box = document.createElement('div');
          box.className = 'domx-translation-box';
          box.setAttribute('data-domx-ignore', 'true');
        }

        box.classList.remove('domx-error');
        box.textContent = cleanedText;
        insertDomxElementBeforeTimestamp(messageEl, box);
        messageEl.setAttribute('data-domx-translated', 'true');
      };

      const insertTranslationError = (messageEl) => {
        if (!messageEl) return;

        let box = messageEl.querySelector(':scope > .domx-translation-box, :scope .domx-translation-box');

        if (!box) {
          box = document.createElement('div');
          box.className = 'domx-translation-box domx-error';
          box.setAttribute('data-domx-ignore', 'true');
        } else {
          box.classList.add('domx-error');
        }

        box.textContent = 'Translation failed';
        insertDomxElementBeforeTimestamp(messageEl, box);
      };

      const clearHistoryTranslations = () => {
        document.querySelectorAll('.domx-translation-box').forEach((box) => box.remove());

        document.querySelectorAll(MALOUM_MESSAGE_SELECTOR).forEach((messageEl) => {
          messageEl.removeAttribute('data-domx-translated');
          messageEl.removeAttribute('data-domx-translating');
          messageEl.removeAttribute('data-domx-skip-translation');
        });
      };

      window.__domxSetHistoryTranslateEnabled = (enabled) => {
        const next = Boolean(enabled);
        window.__domxHistoryTranslateEnabled = next;

        if (!next) {
          clearHistoryTranslations();
          return;
        }

        if (typeof window.__domxRefreshMaloumTranslations === 'function') {
          window.__domxRefreshMaloumTranslations();
        }
      };

      const translateMessageElement = async (messageEl) => {
        if (!messageEl) return;
        if (!window.__domxHistoryTranslateEnabled) return;
        if (messageEl.getAttribute('data-domx-translating') === 'true') return;
        if (messageEl.getAttribute('data-domx-translated') === 'true') return;

        const messageText = stripMessageMetaFromText(extractMessageText(messageEl));

        if (!messageText) {
          messageEl.setAttribute('data-domx-skip-translation', 'true');
          return;
        }

        try {
          messageEl.setAttribute('data-domx-translating', 'true');

          const translatedText = await translateTextToEnglish(messageText);

          if (!translatedText) {
            insertTranslationError(messageEl);
            return;
          }

          insertTranslationBox(messageEl, translatedText);
        } catch (error) {
          console.warn('DomX translation failed:', error);
          insertTranslationError(messageEl);
        } finally {
          messageEl.removeAttribute('data-domx-translating');
        }
      };

      const processVisibleMaloumTranslations = () => {
        if (!window.location.href.includes('/chat') || window.location.href.includes('/login')) {
          return;
        }

        if (!window.__domxHistoryTranslateEnabled) {
          return;
        }

        ensureDomxTranslationStyles();

        const messages = Array.from(document.querySelectorAll(MALOUM_MESSAGE_SELECTOR)).filter(
          (el) => {
            if (!isLeafMessageElement(el)) return false;

            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
        );

        messages.forEach((messageEl) => {
          const existingBox = messageEl.querySelector('.domx-translation-box');
          if (existingBox) {
            if (!existingBox.classList.contains('domx-error')) {
              existingBox.textContent = stripMessageMetaFromText(existingBox.textContent || '');
            }
            insertDomxElementBeforeTimestamp(messageEl, existingBox);
          }

          const existingButton = messageEl.querySelector('.domx-translate-button');
          if (existingButton) {
            insertDomxElementBeforeTimestamp(messageEl, existingButton);
          }

          translateMessageElement(messageEl);
        });
      };

      const installDomXMaloumTranslationSystem = () => {
        ensureDomxTranslationStyles();
        processVisibleMaloumTranslations();

        if (window.__domxMaloumTranslationInstalled) {
          window.__domxRefreshMaloumTranslations = processVisibleMaloumTranslations;
          return;
        }

        window.__domxMaloumTranslationInstalled = true;
        window.__domxRefreshMaloumTranslations = processVisibleMaloumTranslations;

        const container =
          document.querySelector('#messages-list-container') || document.body;

        const observer = new MutationObserver(() => {
          clearTimeout(window.__domxTranslationScanTimeout);

          window.__domxTranslationScanTimeout = setTimeout(() => {
            processVisibleMaloumTranslations();
          }, 300);
        });

        observer.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-message-id', 'class', 'style'],
        });

        window.__domxMaloumTranslationObserver = observer;
      };

      const MAX_TRANSLATION_HISTORY = 8;

      const CREATOR_ALIGNMENT_CLASS_PATTERN =
        /\\b(?:justify-end|items-end|ml-auto|self-end|flex-row-reverse)\\b/;

      const FAN_ALIGNMENT_CLASS_PATTERN =
        /\\b(?:justify-start|items-start|mr-auto|self-start)\\b/;

      const isCreatorMessage = (messageEl) => {
        if (!messageEl) return false;

        if (messageEl.getAttribute('data-domx-tracked') === 'true') {
          return true;
        }

        let node = messageEl;

        while (node && node !== document.body) {
          const className = typeof node.className === 'string' ? node.className : '';

          if (CREATOR_ALIGNMENT_CLASS_PATTERN.test(className)) {
            return true;
          }

          if (FAN_ALIGNMENT_CLASS_PATTERN.test(className)) {
            return false;
          }

          node = node.parentElement;
        }

        const contentEl = findMessageContentElement(messageEl);

        if (contentEl) {
          const className = typeof contentEl.className === 'string' ? contentEl.className : '';

          if (/\\bbeige/i.test(className)) {
            return true;
          }

          if (/\\bgray/i.test(className)) {
            return false;
          }
        }

        const container = document.querySelector('#messages-list-container');
        const rect = messageEl.getBoundingClientRect();

        if (container && rect.width > 0 && rect.height > 0) {
          const containerRect = container.getBoundingClientRect();
          const messageCenterX = rect.left + rect.width / 2;
          const containerCenterX = containerRect.left + containerRect.width / 2;

          return messageCenterX >= containerCenterX;
        }

        return false;
      };

      const collectTranslationHistory = () => {
        const messages = Array.from(document.querySelectorAll(MALOUM_MESSAGE_SELECTOR)).filter(
          (messageEl) => {
            if (!isLeafMessageElement(messageEl)) return false;

            const rect = messageEl.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
        );

        const history = [];

        for (const messageEl of messages) {
          const content = stripMessageMetaFromText(extractMessageText(messageEl));
          if (!content) continue;

          history.push({
            role: isCreatorMessage(messageEl) ? 'assistant' : 'user',
            content,
          });
        }

        return history.slice(-MAX_TRANSLATION_HISTORY);
      };

      window.__domxCollectTranslationHistory = collectTranslationHistory;
  `;
}

function getPreSendTranslationScript(endpointUrl, preSendTranslateEnabled = true) {
  return `
      const DOMX_TRANSLATE_TO_GERMAN_URL = ${JSON.stringify(endpointUrl)};

      ${getSendButtonUtilsScript()}

      window.__domxPreSendTranslateEnabled = ${preSendTranslateEnabled ? 'true' : 'false'};

      window.__domxSetPreSendTranslateEnabled = (enabled) => {
        window.__domxPreSendTranslateEnabled = Boolean(enabled);
      };

      window.__domxApplyTranslationSettings = (settings) => {
        if (!settings || typeof settings !== 'object') return;

        if (typeof settings.preSendEnabled === 'boolean') {
          window.__domxSetPreSendTranslateEnabled(settings.preSendEnabled);
        }

        if (
          typeof settings.historyEnabled === 'boolean' &&
          typeof window.__domxSetHistoryTranslateEnabled === 'function'
        ) {
          window.__domxSetHistoryTranslateEnabled(settings.historyEnabled);
        }
      };

      const getInputText = (input) => {
        if (!input) return '';

        if (input.isContentEditable) {
          return input.innerText || input.textContent || '';
        }

        return input.value || '';
      };

      const setInputText = (input, text) => {
        if (!input) return;

        input.focus();

        if (input.isContentEditable) {
          input.innerText = text;

          input.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: 'insertText',
              data: text,
            })
          );

          return;
        }

        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set;

        const nativeInputValueSetterInput = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set;

        if (input.tagName === 'TEXTAREA' && nativeInputValueSetter) {
          nativeInputValueSetter.call(input, text);
        } else if (input.tagName === 'INPUT' && nativeInputValueSetterInput) {
          nativeInputValueSetterInput.call(input, text);
        } else {
          input.value = text;
        }

        input.dispatchEvent(
          new Event('input', {
            bubbles: true,
          })
        );

        input.dispatchEvent(
          new Event('change', {
            bubbles: true,
          })
        );
      };

      const showDomXTranslationStatus = (message) => {
        let status = document.querySelector('#domx-translation-status');

        if (!status) {
          status = document.createElement('div');
          status.id = 'domx-translation-status';
          status.setAttribute('data-domx-ignore', 'true');

          status.style.position = 'fixed';
          status.style.bottom = '80px';
          status.style.left = '50%';
          status.style.transform = 'translateX(-50%)';
          status.style.zIndex = '999999';
          status.style.padding = '8px 12px';
          status.style.borderRadius = '999px';
          status.style.fontSize = '12px';
          status.style.fontWeight = '600';
          status.style.background = '#111827';
          status.style.color = '#f9fafb';
          status.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';

          document.body.appendChild(status);
        }

        status.textContent = message;
        status.style.display = 'block';
      };

      const hideDomXTranslationStatus = (delay = 800) => {
        setTimeout(() => {
          const status = document.querySelector('#domx-translation-status');
          if (status) status.style.display = 'none';
        }, delay);
      };

      const translateBeforeSend = async () => {
        if (window.__domxTranslatingBeforeSend) return;

        const input = findMaloumMessageInput();
        const originalText = getInputText(input).trim();

        if (!originalText) return;

        try {
          window.__domxTranslatingBeforeSend = true;

          showDomXTranslationStatus('Translating to German...');

          const history =
            typeof window.__domxCollectTranslationHistory === 'function'
              ? window.__domxCollectTranslationHistory()
              : [];

          const response = await fetch(DOMX_TRANSLATE_TO_GERMAN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: originalText,
              history,
            }),
          });

          if (!response.ok) {
            throw new Error('Translation failed with status ' + response.status);
          }

          const data = await response.json();
          const translatedText = data.translatedText?.trim();

          if (!translatedText) {
            throw new Error('Empty translated text');
          }

          window.__domxLastOriginalEnglishText = originalText;
          window.__domxLastTranslatedGermanText = translatedText;
          window.__domxLastTranslationAt = Date.now();

          const chatIdMatch = window.location.pathname.match(/\\/chat\\/([^/]+)/i);
          const chatId = chatIdMatch ? chatIdMatch[1] : null;

          console.log(
            '__DOMX_TRANSLATION__:' +
              JSON.stringify({
                chatId,
                originalEnglishText: originalText,
                translatedGermanText: translatedText,
                translatedAt: window.__domxLastTranslationAt,
              })
          );

          setInputText(input, translatedText);

          window.__domxAllowNextMaloumSend = true;
          showDomXTranslationStatus('Sending German message...');

          await new Promise((resolve) => setTimeout(resolve, 120));

          const sendInput = findMaloumMessageInput();

          if (!sendInput || !dispatchEnterOnMessageInput(sendInput)) {
            throw new Error('Message input not found');
          }

          hideDomXTranslationStatus(900);
        } catch (error) {
          console.error('DomX pre-send translation failed:', error);

          showDomXTranslationStatus('Translation failed. Message was not sent.');

          window.dispatchEvent(
            new CustomEvent('domx-translation-send-error', {
              detail: {
                message: error.message,
              },
            })
          );

          hideDomXTranslationStatus(2500);
        } finally {
          setTimeout(() => {
            window.__domxTranslatingBeforeSend = false;
            window.__domxAllowNextMaloumSend = false;
          }, 600);
        }
      };

      const installPreSendTranslationInterceptor = () => {
        if (window.__domxPreSendTranslationListenersInstalled) return;
        window.__domxPreSendTranslationListenersInstalled = true;

        document.addEventListener(
          'click',
          async (event) => {
            if (!window.__domxPreSendTranslateEnabled) return;

            const sendButton = window.__domxFindSendMessageButton(event.target);

            if (!sendButton) return;

            if (window.__domxAllowNextMaloumSend) {
              return;
            }

            const inputText = getInputText(findMaloumMessageInput()).trim();
            if (!inputText) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            if (typeof window.__domxTranslateBeforeSend === 'function') {
              await window.__domxTranslateBeforeSend();
            }
          },
          true
        );

        document.addEventListener(
          'keydown',
          async (event) => {
            if (!window.__domxPreSendTranslateEnabled) return;

            if (event.key !== 'Enter') return;
            if (event.shiftKey) return;

            const input = findMaloumMessageInput();

            if (!input) return;

            const isInsideInput =
              event.target === input ||
              input.contains?.(event.target);

            if (!isInsideInput) return;

            if (window.__domxAllowNextMaloumSend) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            if (typeof window.__domxTranslateBeforeSend === 'function') {
              await window.__domxTranslateBeforeSend();
            }
          },
          true
        );
      };

      window.__domxFindSendMessageButton = findSendMessageButton;
      window.__domxResolveSendMessageButton = resolveSendMessageButton;
      window.__domxTriggerMaloumSend = triggerMaloumSend;
      window.__domxTranslateBeforeSend = translateBeforeSend;

      installPreSendTranslationInterceptor();
  `;
}

function buildMarkRenderedMessageScript(record) {
  return `
    (function(record) {
      ${getDomxSentByLabelUtilsScript()}

      const selector = '[data-message-id="' + record.maloumMessageId + '"]';
      const element = document.querySelector(selector);

      if (!element) {
        return false;
      }

      element.setAttribute('data-domx-tracked', 'true');
      element.setAttribute('data-domx-dashboard-tracked', 'true');
      element.setAttribute('data-domx-sent-by-user-id', record.sentByUserId);
      element.setAttribute('data-domx-sent-by-user-name', record.sentByUserName);
      element.setAttribute('data-domx-message-id', record.maloumMessageId);
      element.setAttribute('data-domx-creator-id', record.creatorId || '');
      element.setAttribute('data-domx-chat-id', record.chatId || '');
      applyDomxSentByLabel(element);

      return true;
    })(${JSON.stringify({
      maloumMessageId: record.maloumMessageId,
      sentByUserId: record.sentByUserId,
      sentByUserName: record.sentByUserName,
      creatorId: record.creatorId,
      chatId: record.chatId,
    })})
  `;
}

function getMessagingDashboardHelpersScript() {
  return `
      const MALOUM_MESSAGE_SELECTOR = '#messages-list-container [data-message-id]';

      const CREATOR_ALIGNMENT_CLASS_PATTERN =
        /\\b(?:justify-end|items-end|ml-auto|self-end|flex-row-reverse)\\b/;

      const FAN_ALIGNMENT_CLASS_PATTERN =
        /\\b(?:justify-start|items-start|mr-auto|self-start)\\b/;

      const isCreatorMessageForDashboard = (messageEl) => {
        if (!messageEl) return false;

        if (messageEl.getAttribute('data-domx-tracked') === 'true') {
          return true;
        }

        if (messageEl.getAttribute('data-domx-dashboard-tracked') === 'true') {
          return true;
        }

        let node = messageEl;

        while (node && node !== document.body) {
          const className = typeof node.className === 'string' ? node.className : '';

          if (CREATOR_ALIGNMENT_CLASS_PATTERN.test(className)) {
            return true;
          }

          if (FAN_ALIGNMENT_CLASS_PATTERN.test(className)) {
            return false;
          }

          node = node.parentElement;
        }

        const contentCandidates = messageEl.querySelectorAll('[class*="beige"], [class*="gray"]');

        for (const contentEl of contentCandidates) {
          const className = typeof contentEl.className === 'string' ? contentEl.className : '';

          if (/beige/i.test(className)) {
            return true;
          }

          if (/gray/i.test(className)) {
            return false;
          }
        }

        const container = document.querySelector('#messages-list-container');
        const rect = messageEl.getBoundingClientRect();

        if (container && rect.width > 0 && rect.height > 0) {
          const containerRect = container.getBoundingClientRect();
          const messageCenterX = rect.left + rect.width / 2;
          const containerCenterX = containerRect.left + containerRect.width / 2;

          return messageCenterX >= containerCenterX;
        }

        return false;
      };

      const TIMESTAMP_TEXT_PATTERN = /^\\d{1,2}:\\d{2}$/;

      const isDomxInjectedElement = (el) => {
        if (!el) return true;

        return (
          el.classList.contains('domx-translation-box') ||
          el.classList.contains('domx-translate-button') ||
          el.classList.contains('domx-sent-by-label') ||
          Boolean(el.closest('.domx-translation-box, .domx-translate-button, .domx-sent-by-label'))
        );
      };

      const extractTimestampTextFromElement = (el) => {
        if (!el || isDomxInjectedElement(el)) return null;

        const text = el.textContent?.trim() || '';
        return TIMESTAMP_TEXT_PATTERN.test(text) ? text : null;
      };

      const findMessageTimestampElement = (messageEl) => {
        if (!messageEl) return null;

        let lastMatch = null;

        for (const el of messageEl.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          if (extractTimestampTextFromElement(el)) {
            lastMatch = el;
          }
        }

        if (lastMatch) {
          return lastMatch;
        }

        for (const el of messageEl.querySelectorAll('span, div, p, time, small')) {
          if (extractTimestampTextFromElement(el)) {
            lastMatch = el;
          }
        }

        return lastMatch;
      };

      const getMessageRowRoot = (messageEl) => {
        const container = document.querySelector('#messages-list-container');
        let rowRoot = messageEl;
        let parent = messageEl.parentElement;

        while (parent && parent !== container) {
          const messageIds = Array.from(parent.querySelectorAll('[data-message-id]'));

          if (messageIds.length === 1 && messageIds[0] === messageEl) {
            rowRoot = parent;
            parent = parent.parentElement;
            continue;
          }

          break;
        }

        return rowRoot;
      };

      const collectTimestampTextsInScope = (scopeEl) => {
        const results = [];

        if (!scopeEl) return results;

        for (const el of scopeEl.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          const text = extractTimestampTextFromElement(el);
          if (text) {
            results.push(text);
          }
        }

        const scopeText = extractTimestampTextFromElement(scopeEl);
        if (scopeText) {
          results.push(scopeText);
        }

        return results;
      };

      const collectSiblingTimestampTexts = (messageEl, direction) => {
        const results = [];
        let sibling =
          direction === 'next'
            ? messageEl.nextElementSibling
            : messageEl.previousElementSibling;

        while (sibling) {
          if (sibling.hasAttribute('data-message-id')) {
            break;
          }

          results.push(...collectTimestampTextsInScope(sibling));

          sibling =
            direction === 'next'
              ? sibling.nextElementSibling
              : sibling.previousElementSibling;
        }

        return results;
      };

      const collectTimestampTextsNearMessage = (messageEl) => {
        const rowRoot = getMessageRowRoot(messageEl);
        const combined = [
          ...collectTimestampTextsInScope(messageEl),
          ...collectSiblingTimestampTexts(messageEl, 'next'),
          ...collectSiblingTimestampTexts(messageEl, 'previous'),
          ...(rowRoot !== messageEl ? collectTimestampTextsInScope(rowRoot) : []),
        ];

        return combined.filter((text, index) => combined.indexOf(text) === index);
      };

      const pickBestTimestampCandidate = (timestampTexts, nowMs = Date.now()) => {
        let bestIso = null;
        let bestText = null;
        let bestMs = -1;

        for (const text of timestampTexts) {
          const iso = parseTimeTextToIso(text);
          if (!iso) continue;

          const ms = new Date(iso).getTime();
          if (Number.isNaN(ms) || ms > nowMs) continue;

          if (ms > bestMs) {
            bestMs = ms;
            bestIso = iso;
            bestText = text;
          }
        }

        return { iso: bestIso, text: bestText };
      };

      const getFanMessageTimestampForResponseTime = (messageEl) => {
        if (!messageEl) {
          return { value: null, source: null, debug: null };
        }

        const visibleTime = parseVisibleMessageTime(messageEl);
        if (visibleTime) {
          return {
            value: visibleTime,
            source: 'visible',
            debug: {
              timestampCandidates: collectTimestampTextsNearMessage(messageEl),
            },
          };
        }

        const attrTime =
          messageEl.getAttribute('data-created-at') ||
          messageEl.getAttribute('data-time') ||
          null;

        if (attrTime) {
          return {
            value: attrTime,
            source: 'attr',
            debug: {
              timestampCandidates: collectTimestampTextsNearMessage(messageEl),
            },
          };
        }

        const observedAt = messageEl.getAttribute('data-domx-observed-at');
        if (observedAt) {
          return {
            value: observedAt,
            source: messageEl.getAttribute('data-domx-observed-source') || 'observed',
            debug: {
              timestampCandidates: collectTimestampTextsNearMessage(messageEl),
            },
          };
        }

        return {
          value: null,
          source: null,
          debug: {
            timestampCandidates: collectTimestampTextsNearMessage(messageEl),
          },
        };
      };

      const getMessageTimestamp = (messageEl) => {
        if (!messageEl) return null;

        const attrTime =
          messageEl.getAttribute('data-created-at') ||
          messageEl.getAttribute('data-time') ||
          messageEl.querySelector('time')?.getAttribute('datetime') ||
          null;

        if (attrTime) {
          return attrTime;
        }

        const visibleTime = parseVisibleMessageTime(messageEl);
        if (visibleTime) {
          return visibleTime;
        }

        return messageEl.getAttribute('data-domx-observed-at') || null;
      };

      const parseTimeTextToIso = (timeText) => {
        const match = String(timeText).trim().match(/^(\\d{1,2}):(\\d{2})$/);
        if (!match) return null;

        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);

        if (hours > 23 || minutes > 59) return null;

        const now = new Date();
        const today = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hours,
          minutes,
          0,
          0
        );
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const candidates = [today, yesterday].filter(
          (candidate) => candidate.getTime() <= now.getTime()
        );

        if (candidates.length === 0) {
          return yesterday.toISOString();
        }

        return candidates
          .reduce((latest, candidate) =>
            candidate.getTime() > latest.getTime() ? candidate : latest
          )
          .toISOString();
      };

      const parseVisibleMessageTime = (messageEl) => {
        const timestampCandidates = collectTimestampTextsNearMessage(messageEl);
        const best = pickBestTimestampCandidate(timestampCandidates);

        if (best.iso) {
          return best.iso;
        }

        const timeEl = messageEl.querySelector('time');

        if (timeEl) {
          const text = timeEl.textContent?.trim();
          const parsedFromText = parseTimeTextToIso(text);
          if (parsedFromText) {
            return parsedFromText;
          }

          const datetime = timeEl.getAttribute('datetime');
          if (datetime) {
            return datetime;
          }
        }

        return null;
      };

      const isLeafMessageElement = (messageEl) => {
        return !messageEl.querySelector('[data-message-id]');
      };

      const getVisibleChatMessages = () => {
        const container = document.querySelector('#messages-list-container');
        if (!container) return [];

        const all = Array.from(container.querySelectorAll('[data-message-id]'));
        const messageSet = new Set(all);

        return all.filter((messageEl) => {
          let parent = messageEl.parentElement;

          while (parent && parent !== container) {
            if (parent.hasAttribute('data-message-id') && messageSet.has(parent)) {
              return false;
            }
            parent = parent.parentElement;
          }

          const rect = messageEl.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      };

      const isPendingOptimisticCreatorMessage = (messageEl) => {
        if (!messageEl) return false;

        if (!isCreatorMessageForDashboard(messageEl)) {
          return false;
        }

        if (messageEl.getAttribute('data-domx-tracked') === 'true') {
          return false;
        }

        if (messageEl.getAttribute('data-domx-dashboard-tracked') === 'true') {
          return false;
        }

        return true;
      };

      window.__domxGetResponseTimeSnapshot = (optimisticMessageId) => {
        let messages = getVisibleChatMessages();

        if (optimisticMessageId) {
          messages = messages.filter(
            (messageEl) => messageEl.getAttribute('data-message-id') !== optimisticMessageId
          );
        }

        while (messages.length > 0 && isPendingOptimisticCreatorMessage(messages[messages.length - 1])) {
          messages.pop();
        }

        if (!messages.length) {
          return { previousFanMessageAt: null, responseTimeSeconds: null };
        }

        let latestFanAtMs = null;
        let latestCreatorAtMs = null;

        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const messageEl = messages[index];
          const isCreator = isCreatorMessageForDashboard(messageEl);
          const timestamp = getMessageTimestamp(messageEl);

          if (!timestamp) {
            continue;
          }

          const timestampMs = new Date(timestamp).getTime();

          if (Number.isNaN(timestampMs)) {
            continue;
          }

          if (isCreator) {
            if (latestCreatorAtMs == null || timestampMs > latestCreatorAtMs) {
              latestCreatorAtMs = timestampMs;
            }
            continue;
          }

          if (latestFanAtMs == null || timestampMs > latestFanAtMs) {
            latestFanAtMs = timestampMs;
          }
        }

        if (latestFanAtMs == null) {
          return { previousFanMessageAt: null, responseTimeSeconds: null };
        }

        if (latestCreatorAtMs != null && latestFanAtMs <= latestCreatorAtMs) {
          return { previousFanMessageAt: null, responseTimeSeconds: null };
        }

        const sentAtMs = Date.now();
        const responseTimeSeconds = Math.max(0, Math.floor((sentAtMs - latestFanAtMs) / 1000));

        return {
          previousFanMessageAt: new Date(latestFanAtMs).toISOString(),
          responseTimeSeconds,
        };
      };

      window.__domxResolveConfirmedMessageId = (optimisticMessageId, actualSentText) => {
        const REAL_ID_PATTERN = /^[a-f0-9]{24}$/i;
        const container = document.querySelector('#messages-list-container');

        if (!container) {
          return null;
        }

        const messages = Array.from(container.querySelectorAll('[data-message-id]')).filter(
          (messageEl) => !messageEl.querySelector('[data-message-id]')
        );

        const normalizedSentText = String(actualSentText || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();

        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const messageEl = messages[index];

          if (!isCreatorMessageForDashboard(messageEl)) {
            continue;
          }

          const messageId = messageEl.getAttribute('data-message-id');

          if (!messageId || messageId === optimisticMessageId) {
            continue;
          }

          if (!REAL_ID_PATTERN.test(messageId)) {
            continue;
          }

          if (normalizedSentText) {
            const messageText = String(messageEl.innerText || '')
              .replace(/\\s+/g, ' ')
              .trim()
              .toLowerCase();

            if (!messageText.includes(normalizedSentText.slice(0, 60))) {
              continue;
            }
          }

          return messageId;
        }

        return null;
      };

      window.__domxGetCurrentMaloumFanInfo = () => {
        if (window.__domxCachedFanInfo?.fanUsername) {
          return window.__domxCachedFanInfo;
        }

        const chatIdMatch = window.location.pathname.match(/\\/chat\\/([^/]+)/i);
        const chatId = chatIdMatch ? chatIdMatch[1] : null;

        const header = document.querySelector('header');
        if (header) {
          const img = header.querySelector('img[alt]');
          const alt = img?.getAttribute('alt')?.trim();

          if (alt && alt.length > 0 && alt.length < 80) {
            return {
              fanId: chatId,
              fanUsername: alt.replace(/^@/, ''),
            };
          }

          const textCandidates = Array.from(
            header.querySelectorAll('h1, h2, h3, span, p, a, [class*="username"], [class*="name"]')
          )
            .map((element) => element.textContent?.trim() || '')
            .filter((text) => text.length > 0 && text.length < 80);

          for (const text of textCandidates) {
            if (/^(messages?|chat|inbox|vault|settings)$/i.test(text)) {
              continue;
            }

            return {
              fanId: chatId,
              fanUsername: text.replace(/^@/, ''),
            };
          }
        }

        const headerSelectors = [
          '[class*="chat-header"] h1',
          '[class*="chat-header"] h2',
          '[class*="ChatHeader"]',
          'main h1',
        ];

        for (const selector of headerSelectors) {
          const element = document.querySelector(selector);
          const text = element?.textContent?.trim();

          if (text && text.length > 0 && text.length < 80) {
            return {
              fanId: chatId,
              fanUsername: text.replace(/^@/, ''),
            };
          }
        }

        return null;
      };

      const tagObservedMessages = (source = 'initial') => {
        const messages = document.querySelectorAll(MALOUM_MESSAGE_SELECTOR);

        messages.forEach((message) => {
          if (!message.getAttribute('data-domx-observed-at')) {
            message.setAttribute('data-domx-observed-at', new Date().toISOString());
            message.setAttribute('data-domx-observed-source', source);
          }
        });
      };

      const installObservedTimeTracker = () => {
        tagObservedMessages('initial');

        if (window.__domxObservedTimeTrackerInstalled) return;
        window.__domxObservedTimeTrackerInstalled = true;

        const observer = new MutationObserver(() => {
          tagObservedMessages('live');
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-message-id'],
        });

        window.__domxObservedTimeTracker = observer;
      };

      installObservedTimeTracker();
  `;
}

async function installMessageObservedTimeTracker(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  await webContents.executeJavaScript(`
    (function() {
      ${getMessagingDashboardHelpersScript()}
    })()
  `);
}

async function resolveConfirmedMessageIdFromDom(
  webContents,
  optimisticMessageId = null,
  actualSentText = null
) {
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }

  try {
    await installMessageObservedTimeTracker(webContents);

    return await webContents.executeJavaScript(`
      (function() {
        if (typeof window.__domxResolveConfirmedMessageId === 'function') {
          return window.__domxResolveConfirmedMessageId(
            ${JSON.stringify(optimisticMessageId)},
            ${JSON.stringify(actualSentText)}
          );
        }
        return null;
      })()
    `);
  } catch {
    return null;
  }
}

async function getResponseTimeSnapshot(webContents, optimisticMessageId = null) {
  if (!webContents || webContents.isDestroyed()) {
    return { previousFanMessageAt: null, responseTimeSeconds: null };
  }

  try {
    await installMessageObservedTimeTracker(webContents);

    return await webContents.executeJavaScript(`
      (function() {
        if (typeof window.__domxGetResponseTimeSnapshot === 'function') {
          return window.__domxGetResponseTimeSnapshot(${JSON.stringify(optimisticMessageId)});
        }
        return { previousFanMessageAt: null, responseTimeSeconds: null };
      })()
    `);
  } catch {
    return { previousFanMessageAt: null, responseTimeSeconds: null };
  }
}

async function getCurrentMaloumFanInfo(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }

  try {
    return await webContents.executeJavaScript(`
      (function() {
        if (typeof window.__domxGetCurrentMaloumFanInfo === 'function') {
          return window.__domxGetCurrentMaloumFanInfo();
        }
        return null;
      })()
    `);
  } catch {
    return null;
  }
}

async function setCachedFanInfo(webContents, fanInfo) {
  if (!webContents || webContents.isDestroyed() || !fanInfo) {
    return;
  }

  try {
    await webContents.executeJavaScript(`
      (function() {
        window.__domxCachedFanInfo = ${JSON.stringify(fanInfo)};
      })()
    `);
  } catch {
    // Page may be navigating
  }
}

function getMemberNotesPrefillScript() {
  return `
      const MEMBER_NOTES_BUTTON_SELECTOR = ${JSON.stringify(MEMBER_NOTES_BUTTON_SELECTOR)};
      const MEMBER_NOTES_TEMPLATE = ${JSON.stringify(MEMBER_NOTES_TEMPLATE)};

      const setNativeTextareaValue = (element, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        );
        descriptor.set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const findMemberNotesTextarea = () => {
        const panelTextarea = document.querySelector(
          '[id^="headlessui-dialog-panel"] form textarea'
        );
        if (panelTextarea) return panelTextarea;

        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          return dialog.querySelector('form textarea') || dialog.querySelector('textarea');
        }

        return null;
      };

      const prefillMemberNotesIfNeeded = () => {
        const textarea = findMemberNotesTextarea();
        if (!textarea || textarea.value.trim()) {
          return false;
        }

        setNativeTextareaValue(textarea, MEMBER_NOTES_TEMPLATE);
        return true;
      };

      const installMemberNotesButtonListener = () => {
        if (!window.location.href.includes('/chat') || window.location.href.includes('/login')) {
          return;
        }

        const button = document.querySelector(MEMBER_NOTES_BUTTON_SELECTOR);
        if (!button || button.dataset.domxNotesListener) {
          return;
        }

        button.dataset.domxNotesListener = '1';
        button.addEventListener('click', () => {
          [0, 50, 100, 200, 400].forEach((delay) => {
            setTimeout(prefillMemberNotesIfNeeded, delay);
          });
        });
      };
  `;
}

function getChatLayoutCleanupScript() {
  return `
      const mainWrapper = document.querySelector('#root > div > div > div');
      if (mainWrapper) {
        mainWrapper.classList.remove('ml-0', 'flex-col', 'sm:ml-20', 'sm:flex-row', 'lg:ml-60');
        mainWrapper.classList.add('ml-60', 'min-w-[1200px]', 'flex-row');
        mainWrapper.style.minWidth = '1200px';

        const chatColumn = mainWrapper.querySelector('.full-height.scrollbar-hide.w-80');
        if (chatColumn) {
          chatColumn.classList.remove('hidden', 'md:block');
          chatColumn.classList.add('block', 'min-w-80', 'overflow-y-auto');
          chatColumn.style.minWidth = '20rem';
          chatColumn.style.overflowY = 'auto';
        }
      }

      const chatMinWidthStyleId = 'domx-chat-min-width';
      if (!document.getElementById(chatMinWidthStyleId)) {
        const style = document.createElement('style');
        style.id = chatMinWidthStyleId;
        style.textContent = 'html, body, #root { min-width: 1200px; overflow-x: auto; }';
        document.head.appendChild(style);
      }
  `;
}

function buildAddListPageCleanupScript() {
  const addListDomUtils = getAddListDomUtilsScript();

  return `
    (function() {
      ${addListDomUtils}

      if (!window.location.href.includes('/lists/add/member')) {
        return;
      }

      const ADD_LIST_SIDEBAR_SELECTOR = ${JSON.stringify(ADD_LIST_SIDEBAR_SELECTOR)};
      const ADD_LIST_MAIN_DIV_SELECTOR = ${JSON.stringify(ADD_LIST_MAIN_DIV_SELECTOR)};
      const NEW_LIST_BUTTON_SELECTOR = ${JSON.stringify(NEW_LIST_BUTTON_SELECTOR)};
      const CREATE_NEW_LIST_DIV_SELECTOR = ${JSON.stringify(CREATE_NEW_LIST_DIV_SELECTOR)};

      const sidebar = document.querySelector(ADD_LIST_SIDEBAR_SELECTOR);
      if (sidebar) sidebar.style.display = 'none';

      const mainDiv = document.querySelector(ADD_LIST_MAIN_DIV_SELECTOR);
      if (mainDiv) {
        mainDiv.classList.remove('sm:ml-20', 'lg:ml-60');
        mainDiv.style.marginLeft = '0';
        mainDiv.style.width = '100%';
      }

      const newListButton = document.querySelector(NEW_LIST_BUTTON_SELECTOR);
      if (newListButton) newListButton.style.display = 'none';

      hideAddListEmptyState(CREATE_NEW_LIST_DIV_SELECTOR);
    })()
  `;
}

async function cleanMaloumChatUI(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  await webContents.executeJavaScript(`
    (function() {
      if (!window.location.href.includes('/chat')) return;

      const root = document.querySelector('#root');
      if (!root) return;

      const sidebar = document.querySelector('#root > div > div > section');
      if (sidebar) {
        sidebar.style.display = 'none';
      }

      const topMenu = document.querySelector(
        '#leftColumn > div > div.sticky.top-0.z-50.mx-auto.hidden.w-full.max-w-xl.flex-col.gap-2.bg-white.px-4.sm\\\\:flex > header > div > div'
      );
      if (topMenu) {
        topMenu.style.display = 'none';
      }

      ${getChatLayoutCleanupScript()}
    })()
  `);
}

async function cleanMaloumAddListUI(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  await webContents.executeJavaScript(buildAddListPageCleanupScript());
}

function buildVaultPageCleanupScript() {
  return `
    (function() {
      if (!window.location.href.includes('/vault')) {
        return;
      }

      const VAULT_SIDEBAR_SELECTOR = ${JSON.stringify(VAULT_SIDEBAR_SELECTOR)};
      const VAULT_PANEL_SELECTOR = ${JSON.stringify(VAULT_PANEL_SELECTOR)};
      const VAULT_NEW_FOLDER_BUTTON_SELECTOR = ${JSON.stringify(VAULT_NEW_FOLDER_BUTTON_SELECTOR)};
      const VAULT_ADD_CONTENT_BUTTON_SELECTOR = ${JSON.stringify(VAULT_ADD_CONTENT_BUTTON_SELECTOR)};

      const sidebar = document.querySelector(VAULT_SIDEBAR_SELECTOR);
      if (sidebar) sidebar.style.display = 'none';

      const vaultPanel = document.querySelector(VAULT_PANEL_SELECTOR);
      if (vaultPanel) {
        vaultPanel.classList.remove('sm:ml-20', 'lg:ml-60');
        vaultPanel.style.marginLeft = '0';
        vaultPanel.style.width = '100%';
      }

      const newFolderButton = document.querySelector(VAULT_NEW_FOLDER_BUTTON_SELECTOR);
      if (newFolderButton) newFolderButton.style.display = 'none';

      const addContentButton = document.querySelector(VAULT_ADD_CONTENT_BUTTON_SELECTOR);
      if (addContentButton) addContentButton.style.display = 'none';
    })()
  `;
}

async function cleanMaloumVaultUI(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  await webContents.executeJavaScript(buildVaultPageCleanupScript());
}

async function applyMaloumTheme(webContents, theme) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const isNightMode = isNightTheme(theme);
  const nightModeCss = JSON.stringify(MALOUM_NIGHT_MODE_CSS);

  await webContents.executeJavaScript(`
    (function(isNightMode) {
      const styleId = 'domx-maloum-night-mode';
      const existingStyle = document.getElementById(styleId);

      if (!isNightMode) {
        if (existingStyle) existingStyle.remove();
        document.documentElement.classList.remove('domx-night-mode');
        document.body.classList.remove('domx-night-mode');
        return;
      }

      document.documentElement.classList.add('domx-night-mode');
      document.body.classList.add('domx-night-mode');

      if (existingStyle) return;

      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = ${nightModeCss};
      document.head.appendChild(style);
    })(${isNightMode})
  `);
}

async function installMaloumDomObserver(webContents, theme, activeChatter, options = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const { fullBrowserAccess = false } = options;
  const isNightMode = isNightTheme(theme);

  await webContents.executeJavaScript(`
    (function(isNightMode, fullBrowserAccess) {
      window.__domxMaloumThemeEnabled = isNightMode;
      window.__domxFullBrowserAccess = fullBrowserAccess;

      ${getSentMessageTrackingScript(activeChatter)}

      const applyChatCleanup = () => {
        const chatMinWidthStyle = document.getElementById('domx-chat-min-width');
        if (!window.location.href.includes('/chat') || window.location.href.includes('/login')) {
          if (chatMinWidthStyle) chatMinWidthStyle.remove();
          return;
        }

        const sidebar = document.querySelector('#root > div > div > section');
        if (sidebar) sidebar.style.display = 'none';

        const topMenu = document.querySelector(
          '#leftColumn > div > div.sticky.top-0.z-50.mx-auto.hidden.w-full.max-w-xl.flex-col.gap-2.bg-white.px-4.sm\\\\:flex > header > div > div'
        );
        if (topMenu) topMenu.style.display = 'none';

        ${getChatLayoutCleanupScript()}
      };

      ${getAddListDomUtilsScript()}
      ${getMemberNotesPrefillScript()}

      const applyAddListCleanup = () => {
        if (!window.location.href.includes('/lists/add/member')) return;

        const ADD_LIST_SIDEBAR_SELECTOR = ${JSON.stringify(ADD_LIST_SIDEBAR_SELECTOR)};
        const ADD_LIST_MAIN_DIV_SELECTOR = ${JSON.stringify(ADD_LIST_MAIN_DIV_SELECTOR)};
        const NEW_LIST_BUTTON_SELECTOR = ${JSON.stringify(NEW_LIST_BUTTON_SELECTOR)};
        const CREATE_NEW_LIST_DIV_SELECTOR = ${JSON.stringify(CREATE_NEW_LIST_DIV_SELECTOR)};

        const sidebar = document.querySelector(ADD_LIST_SIDEBAR_SELECTOR);
        if (sidebar) sidebar.style.display = 'none';

        const mainDiv = document.querySelector(ADD_LIST_MAIN_DIV_SELECTOR);
        if (mainDiv) {
          mainDiv.classList.remove('sm:ml-20', 'lg:ml-60');
          mainDiv.style.marginLeft = '0';
          mainDiv.style.width = '100%';
        }

        const newListButton = document.querySelector(NEW_LIST_BUTTON_SELECTOR);
        if (newListButton) newListButton.style.display = 'none';

        hideAddListEmptyState(CREATE_NEW_LIST_DIV_SELECTOR);
      };

      const applyVaultCleanup = () => {
        if (!window.location.href.includes('/vault')) return;

        const VAULT_SIDEBAR_SELECTOR = ${JSON.stringify(VAULT_SIDEBAR_SELECTOR)};
        const VAULT_PANEL_SELECTOR = ${JSON.stringify(VAULT_PANEL_SELECTOR)};
        const VAULT_NEW_FOLDER_BUTTON_SELECTOR = ${JSON.stringify(VAULT_NEW_FOLDER_BUTTON_SELECTOR)};
        const VAULT_ADD_CONTENT_BUTTON_SELECTOR = ${JSON.stringify(VAULT_ADD_CONTENT_BUTTON_SELECTOR)};

        const sidebar = document.querySelector(VAULT_SIDEBAR_SELECTOR);
        if (sidebar) sidebar.style.display = 'none';

        const vaultPanel = document.querySelector(VAULT_PANEL_SELECTOR);
        if (vaultPanel) {
          vaultPanel.classList.remove('sm:ml-20', 'lg:ml-60');
          vaultPanel.style.marginLeft = '0';
          vaultPanel.style.width = '100%';
        }

        const newFolderButton = document.querySelector(VAULT_NEW_FOLDER_BUTTON_SELECTOR);
        if (newFolderButton) newFolderButton.style.display = 'none';

        const addContentButton = document.querySelector(VAULT_ADD_CONTENT_BUTTON_SELECTOR);
        if (addContentButton) addContentButton.style.display = 'none';
      };

      const applyTheme = () => {
        const styleId = 'domx-maloum-night-mode';
        const existingStyle = document.getElementById(styleId);

        if (!window.__domxMaloumThemeEnabled) {
          if (existingStyle) existingStyle.remove();
          document.documentElement.classList.remove('domx-night-mode');
          document.body.classList.remove('domx-night-mode');
          return;
        }

        document.documentElement.classList.add('domx-night-mode');
        document.body.classList.add('domx-night-mode');
      };

      const runApply = () => {
        if (!fullBrowserAccess) {
          applyChatCleanup();
          applyAddListCleanup();
          applyVaultCleanup();
        }
        applyTheme();

        const onChatPage =
          window.location.href.includes('/chat') &&
          !window.location.href.includes('/login');

        if (!fullBrowserAccess || onChatPage) {
          installMemberNotesButtonListener();
          installSendButtonClickTracking();
          installMaloumMessageDomObserver();
          syncActiveChatterSnapshot();
          applyDomxSentByLabels();
        }
      };

      runApply();

      if (window.__domxMaloumObserverInstalled) return;
      window.__domxMaloumObserverInstalled = true;

      let observer = null;
      let applyScheduled = false;
      const observerOptions = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      };

      const scheduleApply = () => {
        if (applyScheduled) return;
        applyScheduled = true;
        requestAnimationFrame(() => {
          applyScheduled = false;
          if (observer) {
            observer.disconnect();
          }
          runApply();
          if (observer && document.body) {
            observer.observe(document.body, observerOptions);
          }
        });
      };

      observer = new MutationObserver(scheduleApply);
      observer.observe(document.body, observerOptions);
      window.__domxMaloumObserver = observer;
    })(${isNightMode}, ${fullBrowserAccess})
  `);
}

async function installMaloumMessageTranslationSystem(webContents, options = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const historyEnabled =
    typeof options.historyEnabled === 'boolean' ? options.historyEnabled : true;

  await webContents.executeJavaScript(`
    (function() {
      ${getMaloumTranslationScript(historyEnabled)}

      installDomXMaloumTranslationSystem();
    })()
  `);
}

async function installPreSendTranslator(webContents, options = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const endpointUrl = options.endpointUrl || DOMX_TRANSLATE_TO_GERMAN_URL;
  const preSendTranslateEnabled =
    typeof options.preSendTranslateEnabled === 'boolean'
      ? options.preSendTranslateEnabled
      : true;

  await webContents.executeJavaScript(`
    (function() {
      ${getPreSendTranslationScript(endpointUrl, preSendTranslateEnabled)}
    })()
  `);
}

async function refreshMaloumThemeOnly(webContents, theme) {
  await applyMaloumTheme(webContents, theme);
}

async function refreshMaloumChatUIFullAccess(
  webContents,
  theme,
  activeChatter,
  translationSettings = {}
) {
  const preSendEnabled =
    typeof translationSettings.preSendEnabled === 'boolean'
      ? translationSettings.preSendEnabled
      : true;
  const historyEnabled =
    typeof translationSettings.historyEnabled === 'boolean'
      ? translationSettings.historyEnabled
      : true;

  await applyMaloumTheme(webContents, theme);
  await installMaloumDomObserver(webContents, theme, activeChatter, {
    fullBrowserAccess: true,
  });
  await installMaloumMessageTranslationSystem(webContents, { historyEnabled });
  await installPreSendTranslator(webContents, { preSendTranslateEnabled: preSendEnabled });
  await installMessageObservedTimeTracker(webContents);
}

async function refreshMaloumChatUI(webContents, theme, activeChatter, translationSettings = {}) {
  const preSendEnabled =
    typeof translationSettings.preSendEnabled === 'boolean'
      ? translationSettings.preSendEnabled
      : true;
  const historyEnabled =
    typeof translationSettings.historyEnabled === 'boolean'
      ? translationSettings.historyEnabled
      : true;

  await cleanMaloumChatUI(webContents);
  await applyMaloumTheme(webContents, theme);
  await installMaloumDomObserver(webContents, theme, activeChatter);
  await installMaloumMessageTranslationSystem(webContents, { historyEnabled });
  await installPreSendTranslator(webContents, { preSendTranslateEnabled: preSendEnabled });
  await installMessageObservedTimeTracker(webContents);
}

async function refreshMaloumAddListUI(webContents, theme, activeChatter) {
  await cleanMaloumAddListUI(webContents);
  await applyMaloumTheme(webContents, theme);
  await installMaloumDomObserver(webContents, theme, activeChatter);
}

async function refreshMaloumVaultUI(webContents, theme, activeChatter) {
  await cleanMaloumVaultUI(webContents);
  await applyMaloumTheme(webContents, theme);
  await installMaloumDomObserver(webContents, theme, activeChatter);
}

async function refreshMaloumPageUI(
  webContents,
  theme,
  triggerUrl,
  activeChatter,
  translationSettings = {},
  options = {}
) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const { fullBrowserAccess = false } = options;
  const url = triggerUrl || webContents.getURL();

  if (fullBrowserAccess) {
    if (!isMaloumAppUrl(url)) {
      return;
    }

    const kind = getMaloumPageKind(url);
    if (kind === 'chat') {
      await refreshMaloumChatUIFullAccess(
        webContents,
        theme,
        activeChatter,
        translationSettings
      );
      return;
    }

    await refreshMaloumThemeOnly(webContents, theme);
    await installMaloumDomObserver(webContents, theme, activeChatter, {
      fullBrowserAccess: true,
    });
    return;
  }

  const kind = getMaloumPageKind(url);

  if (kind === 'addList') {
    await refreshMaloumAddListUI(webContents, theme, activeChatter);
    return;
  }
  if (kind === 'vault') {
    await refreshMaloumVaultUI(webContents, theme, activeChatter);
    return;
  }
  if (kind === 'chat') {
    await refreshMaloumChatUI(webContents, theme, activeChatter, translationSettings);
  }
}

async function resetMaloumPageObservers(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  await webContents.executeJavaScript(`
    (function() {
      if (window.__domxMaloumObserver) {
        window.__domxMaloumObserver.disconnect();
        window.__domxMaloumObserver = null;
      }
      window.__domxMaloumObserverInstalled = false;
    })()
  `);
}

async function applyTranslationSettings(webContents, settings = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const preSendEnabled =
    typeof settings.preSendEnabled === 'boolean' ? settings.preSendEnabled : true;
  const historyEnabled =
    typeof settings.historyEnabled === 'boolean' ? settings.historyEnabled : true;
  const payload = JSON.stringify({ preSendEnabled, historyEnabled });

  await webContents.executeJavaScript(`
    (function() {
      const settings = ${payload};

      if (typeof window.__domxApplyTranslationSettings === 'function') {
        window.__domxApplyTranslationSettings(settings);
        return;
      }

      if (typeof window.__domxSetPreSendTranslateEnabled === 'function') {
        window.__domxSetPreSendTranslateEnabled(settings.preSendEnabled);
      } else {
        window.__domxPreSendTranslateEnabled = settings.preSendEnabled;
      }

      if (typeof window.__domxSetHistoryTranslateEnabled === 'function') {
        window.__domxSetHistoryTranslateEnabled(settings.historyEnabled);
      } else {
        window.__domxHistoryTranslateEnabled = settings.historyEnabled;
      }
    })()
  `);
}

module.exports = {
  isNightTheme,
  isMaloumAppUrl,
  MALOUM_ADD_LIST_PATH,
  MALOUM_VAULT_PATH,
  getMaloumPageKind,
  cleanMaloumChatUI,
  cleanMaloumAddListUI,
  cleanMaloumVaultUI,
  applyMaloumTheme,
  installMaloumDomObserver,
  installMaloumMessageTranslationSystem,
  installPreSendTranslator,
  applyTranslationSettings,
  refreshMaloumThemeOnly,
  refreshMaloumChatUIFullAccess,
  refreshMaloumChatUI,
  refreshMaloumAddListUI,
  refreshMaloumVaultUI,
  refreshMaloumPageUI,
  resetMaloumPageObservers,
  buildMarkRenderedMessageScript,
  installMessageObservedTimeTracker,
  getResponseTimeSnapshot,
  resolveConfirmedMessageIdFromDom,
  getCurrentMaloumFanInfo,
  setCachedFanInfo,
};
