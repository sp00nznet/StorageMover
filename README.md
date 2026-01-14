# StorageMover

<div align="center">

![StorageMover](https://img.shields.io/badge/StorageMover-Enterprise%20Migration-007DB8?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)

**Enterprise storage migration tool for Dell EMC Isilon to PowerScale and PowerStore**

[Features](#features) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Screenshots](#screenshots)

</div>

---

## Features

| Feature | Description |
|---------|-------------|
| **Device Management** | Connect to Isilon, PowerScale, and PowerStore devices |
| **Export Discovery** | Auto-discover NFS exports and SMB shares |
| **Data Migration** | Transfer data with real-time progress tracking |
| **Config Generation** | Generate migration scripts for target devices |
| **Web Interface** | Modern, responsive UI for all operations |
| **Real-time Updates** | WebSocket-powered live status updates |

---

## Quick Start

### Windows (One-Click Deploy)

```batch
deploy.bat
```

That's it! The script handles everything automatically.

### Docker

```bash
docker-compose up -d
```

### Manual Setup

```bash
npm install
cd client && npm install && cd ..
cp .env.example .env
npm run dev
```

**Access the application at** → `http://localhost:3001`

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        StorageMover                            │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Frontend (React + TypeScript + Tailwind)                │  │
│  │  • Dashboard  • Devices  • Exports  • Migrations         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Backend (Node.js + Express + TypeScript)                │  │
│  │  • REST API  • WebSocket  • Device Clients               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Database (SQLite)                                       │  │
│  │  • Devices  • Exports  • Migrations  • Configs           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## Usage Overview

### 1. Add Devices
Connect to your Dell EMC storage systems (Isilon, PowerScale, PowerStore)

### 2. Discover Exports
Scan devices to find NFS exports and SMB shares

### 3. Create Migration
Select source exports and target device, then start migration

### 4. Monitor Progress
Track real-time progress with WebSocket updates

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API.md) | REST API endpoints and examples |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and settings |
| [Deployment](docs/DEPLOYMENT.md) | Production deployment guide |
| [Development](docs/DEVELOPMENT.md) | Local development setup |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common issues and solutions |

---

## Tech Stack

<table>
<tr>
<td align="center" width="33%">

**Backend**
- Node.js 20+
- TypeScript
- Express.js
- SQLite3
- WebSocket

</td>
<td align="center" width="33%">

**Frontend**
- React 18
- TypeScript
- Vite
- Tailwind CSS
- Lucide Icons

</td>
<td align="center" width="33%">

**Infrastructure**
- Docker
- Docker Compose
- Health Checks
- Volume Persistence

</td>
</tr>
</table>

---

## Security

- AES-256 encryption for stored passwords
- JWT authentication
- HTTPS recommended for production
- Non-root Docker user

---

## License

MIT License - see [LICENSE](LICENSE) for details

---

<div align="center">

**[⬆ Back to Top](#storagemover)**

</div>
