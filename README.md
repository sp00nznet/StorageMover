# StorageMover

Enterprise storage migration tool for Dell EMC Isilon to PowerScale and PowerStore devices.

## Features

- **Device Management**: Connect to and authenticate with Dell EMC Isilon, PowerScale, and PowerStore storage devices
- **Export Discovery**: Automatically catalog all NFS exports and SMB shares from Isilon systems
- **Configuration Generation**: Create migration scripts for PowerScale devices
- **Data Migration**: Execute data migrations from Isilon to PowerScale with real-time progress tracking
- **PowerStore Support**: Export and import configurations to/from PowerStore devices
- **Web Interface**: Modern React-based UI for managing all migration tasks
- **Real-time Updates**: WebSocket support for live migration progress updates

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     StorageMover                             │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React + TypeScript)                               │
│  - Dashboard, Device Management, Export Browser              │
│  - Migration Control, Configuration Generator                │
├─────────────────────────────────────────────────────────────┤
│  Backend (Node.js + Express + TypeScript)                    │
│  - REST API, WebSocket Server                                │
│  - Device Clients (Isilon, PowerScale, PowerStore)           │
│  - Migration Service, Configuration Export                   │
├─────────────────────────────────────────────────────────────┤
│  Database (SQLite)                                           │
│  - Devices, Exports, Migrations, Configurations              │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository
git clone <repository-url>
cd StorageMover

# Start with Docker Compose
docker-compose up -d

# Access the application at http://localhost:3001
```

### Manual Setup

```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd client && npm install && cd ..

# Create environment file
cp .env.example .env

# Start development server
npm run dev
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
# Server Configuration
NODE_ENV=development
PORT=3001

# Security (CHANGE IN PRODUCTION!)
JWT_SECRET=your-secure-jwt-secret
ENCRYPTION_KEY=your-32-byte-encryption-key

# Database
DB_PATH=./data/storagemover.db

# Logging
LOG_LEVEL=info
```

## Usage

### 1. Add Storage Devices

Navigate to **Devices** and add your storage systems:
- **Isilon**: Source devices for migration
- **PowerScale**: Target devices for migration
- **PowerStore**: For configuration export/import

### 2. Discover Exports

Click **Discover** on any Isilon device to scan for:
- NFS exports
- SMB shares

### 3. Create Migration

Go to **Migrations** and create a new job:
1. Select source Isilon device
2. Select target PowerScale device
3. Choose exports to migrate
4. Start the migration

### 4. Generate Configuration Scripts

Use **Configuration** to:
- Generate shell scripts for PowerScale
- Apply configurations directly via API
- Export/import PowerStore configurations

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/verify` - Verify token

### Devices
- `GET /api/devices` - List all devices
- `POST /api/devices` - Add device
- `POST /api/devices/:id/test` - Test connection
- `POST /api/devices/:id/discover` - Discover exports

### Exports
- `GET /api/exports` - List discovered exports
- `GET /api/exports?deviceId=:id` - Filter by device

### Migrations
- `GET /api/migrations` - List migrations
- `POST /api/migrations` - Create migration
- `POST /api/migrations/:id/start` - Start migration
- `POST /api/migrations/:id/pause` - Pause migration
- `POST /api/migrations/:id/cancel` - Cancel migration

### Configuration
- `POST /api/config/powerscale/generate` - Generate script
- `POST /api/config/powerscale/apply` - Apply directly
- `POST /api/config/powerstore/export` - Export config
- `POST /api/config/powerstore/import` - Import config

## Technology Stack

### Backend
- Node.js 20+
- TypeScript
- Express.js
- SQLite3
- WebSocket (ws)
- Axios for API calls
- bcryptjs for password hashing
- JWT for authentication

### Frontend
- React 18
- TypeScript
- Vite
- Tailwind CSS
- React Router
- Lucide Icons

### Infrastructure
- Docker & Docker Compose
- Health checks
- Volume persistence

## Security Considerations

- All device passwords are encrypted at rest using AES-256
- JWT tokens for API authentication
- HTTPS recommended for production deployment
- Change default secrets in production

## Development

```bash
# Run in development mode (hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Lint code
npm run lint
```

## License

MIT License
