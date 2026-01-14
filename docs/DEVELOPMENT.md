# Development Guide

## Prerequisites

- Node.js 20+
- npm 9+
- Git

---

## Getting Started

### Clone Repository

```bash
git clone <repository-url>
cd StorageMover
```

### Install Dependencies

```bash
# Backend dependencies
npm install

# Frontend dependencies
cd client && npm install && cd ..
```

### Configure Environment

```bash
cp .env.example .env
```

Edit `.env` for development:

```env
NODE_ENV=development
PORT=3001
JWT_SECRET=dev-secret-key
ENCRYPTION_KEY=dev-encryption-key-32bytes!
LOG_LEVEL=debug
```

### Start Development Server

```bash
npm run dev
```

This starts:
- Backend server with hot reload on port 3001
- Frontend dev server with HMR on port 5173

Access the app at `http://localhost:5173` (Vite proxy forwards API calls to 3001)

---

## Project Structure

```
StorageMover/
├── src/                    # Backend source
│   ├── server.ts          # Entry point
│   ├── database/          # Database initialization
│   ├── routes/            # API route handlers
│   ├── services/          # Business logic & device clients
│   ├── utils/             # Utility functions
│   └── websocket/         # WebSocket handlers
├── client/                 # Frontend source
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── contexts/      # React contexts
│   │   └── pages/         # Page components
│   └── index.html
├── dist/                   # Compiled backend (generated)
├── client/dist/           # Built frontend (generated)
├── data/                   # SQLite database (generated)
├── logs/                   # Log files (generated)
└── docs/                   # Documentation
```

---

## Available Scripts

### Root Directory

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both servers in development mode |
| `npm run dev:server` | Start backend only with hot reload |
| `npm run dev:client` | Start frontend only |
| `npm run build` | Build both backend and frontend |
| `npm run build:server` | Build backend only |
| `npm run build:client` | Build frontend only |
| `npm start` | Start production server |
| `npm run lint` | Lint backend code |

### Client Directory

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Lint frontend code |

---

## API Development

### Adding a New Route

1. Create route file in `src/routes/`:

```typescript
// src/routes/newfeature.ts
import { Router } from 'express';
import { authenticateToken } from './auth';

export const newFeatureRouter = Router();
newFeatureRouter.use(authenticateToken);

newFeatureRouter.get('/', async (req, res) => {
  res.json({ message: 'Hello' });
});
```

2. Register in `src/server.ts`:

```typescript
import { newFeatureRouter } from './routes/newfeature';
app.use('/api/newfeature', newFeatureRouter);
```

### Database Changes

Modify schema in `src/database/init.ts`:

```typescript
CREATE TABLE IF NOT EXISTS new_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Frontend Development

### Adding a New Page

1. Create page component in `client/src/pages/`:

```tsx
// client/src/pages/NewPage.tsx
function NewPage() {
  return (
    <div>
      <h1>New Page</h1>
    </div>
  );
}

export default NewPage;
```

2. Add route in `client/src/App.tsx`:

```tsx
import NewPage from './pages/NewPage';

// In Routes:
<Route path="newpage" element={<NewPage />} />
```

3. Add navigation in `client/src/components/Layout.tsx`

### Using the API

```tsx
import axios from 'axios';

// GET request
const response = await axios.get('/api/devices');

// POST request
await axios.post('/api/devices', { name: 'Test' });
```

---

## Testing

### Manual Testing

1. Start dev server: `npm run dev`
2. Open `http://localhost:5173`
3. Register a test user
4. Add a test device

### API Testing with curl

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}' | jq -r '.token')

# Use token
curl http://localhost:3001/api/devices \
  -H "Authorization: Bearer $TOKEN"
```

---

## Debugging

### Backend Debugging

Set `LOG_LEVEL=debug` in `.env` for verbose logging.

### VSCode Launch Config

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Server",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["ts-node-dev", "--respawn", "src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

---

## Code Style

- Use TypeScript strict mode
- Follow existing patterns
- Add proper error handling
- Use async/await over callbacks
- Prefix private methods with underscore

### Linting

```bash
npm run lint
```

---

## Building for Production

```bash
# Full build
npm run build

# Test production build locally
npm start
```

Access at `http://localhost:3001`
