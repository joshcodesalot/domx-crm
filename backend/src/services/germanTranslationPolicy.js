function skipsGermanTranslation(platform) {
  return String(platform || '').trim().toLowerCase() === 'fansly';
}

module.exports = {
  skipsGermanTranslation,
};
