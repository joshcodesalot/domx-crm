async function createResponse({ outputText } = {}) {
  return { outputText: outputText == null ? '' : String(outputText) };
}

module.exports = {
  createResponse,
};
