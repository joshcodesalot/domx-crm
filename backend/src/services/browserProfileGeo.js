const { ProxyAgent, fetch: undiciFetch } = require('undici');

const COUNTRY_LANG = {
  US: 'en-US,en',
  GB: 'en-GB,en',
  CA: 'en-CA,en',
  AU: 'en-AU,en',
  DE: 'de-DE,de',
  FR: 'fr-FR,fr',
  ES: 'es-ES,es',
  MX: 'es-MX,es',
  AR: 'es-AR,es',
  IT: 'it-IT,it',
  NL: 'nl-NL,nl',
  PT: 'pt-PT,pt',
  BR: 'pt-BR,pt',
  PL: 'pl-PL,pl',
  RU: 'ru-RU,ru',
  JP: 'ja-JP,ja',
  KR: 'ko-KR,ko',
  CN: 'zh-CN,zh',
  TW: 'zh-TW,zh',
  TR: 'tr-TR,tr',
  SE: 'sv-SE,sv',
  NO: 'nb-NO,nb',
  DK: 'da-DK,da',
  FI: 'fi-FI,fi',
};

async function lookupGeo(proxyUrl) {
  if (!proxyUrl) return null;
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const response = await undiciFetch(
      'http://ip-api.com/json/?fields=status,timezone,countryCode',
      { dispatcher, signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || body.status !== 'success' || !body.timezone) return null;
    const country = typeof body.countryCode === 'string' ? body.countryCode.toUpperCase() : '';
    return {
      timezone: body.timezone,
      acceptLanguage: COUNTRY_LANG[country] || 'en-US,en',
    };
  } catch {
    return null;
  } finally {
    try {
      await dispatcher.close();
    } catch {
      // The lookup already finished or failed.
    }
  }
}

module.exports = {
  lookupGeo,
};
