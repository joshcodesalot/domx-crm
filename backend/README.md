For production hosting on Debian (nginx, systemd, `api.low7labs.cloud`), see [DEPLOY.md](./DEPLOY.md).

## Setup
Create the database (if needed):

createdb domx
Configure backend .env — update backend/.env with your PostgreSQL credentials:

DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/domx
JWT_SECRET=your-secret-here
ENCRYPTION_KEY=base64-encoded-32-byte-key
Generate an encryption key:

node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
Migrate and seed roles/permissions:

cd backend
npm run migrate
npm run seed
npm run dev
Start the Electron app (separate terminal):

cd frontend
npm run dev
On first launch, the app will prompt you to create the owner account. This one-time setup registers the first user with the `owner` role and signs you in automatically. After that, use the login page for all subsequent sign-ins.

## Translate to German API

`POST /api/translate-to-german`

Translates a message into natural German using xAI Grok. Existing callers that send only `text` continue to work unchanged.

### Request body

```json
{
  "text": "Message to translate",
  "history": [
    { "role": "user", "content": "Earlier fan message" },
    { "role": "assistant", "content": "Earlier creator reply" }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `text` | Yes | The current message to translate. |
| `history` | No | Up to the last 15 prior chat messages for conversation context. Invalid entries are ignored. |

### History message shape

Each history item must include:

- `role`: `"user"` or `"assistant"`
- `content`: non-empty string

The server keeps only the last 15 valid history messages, in chronological order, and includes them as read-only context in the translation prompt (not as chat turns, so the model translates instead of replying).

### Response

```json
{
  "translatedText": "Translated German message"
}
```

### Example (with context)

```json
POST /api/translate-to-german
{
  "text": "I missed you today",
  "history": [
    { "role": "user", "content": "Hey, are you free tonight?" },
    { "role": "assistant", "content": "Maybe. What do you want?" }
  ]
}
```

If `history` is omitted, the endpoint behaves the same as before and translates only the provided `text`.

The Electron chat UI (`frontend/electron/maloumChatUi.js`) automatically collects the last 15 visible Maloum messages before send, maps fan messages to `user` and creator messages to `assistant`, and uses the original German bubble text (not the English translation overlay).