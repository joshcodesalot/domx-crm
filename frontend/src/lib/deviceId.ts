const DEVICE_ID_KEY = 'domx.deviceId';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return '';
  }
}
