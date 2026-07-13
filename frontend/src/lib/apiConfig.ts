const PRODUCTION_API_URL = 'https://api.low7labs.cloud';
const LOCAL_API_URL = 'http://localhost:3001';

export function getApiUrl(): string {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  return import.meta.env.PROD ? PRODUCTION_API_URL : LOCAL_API_URL;
}
