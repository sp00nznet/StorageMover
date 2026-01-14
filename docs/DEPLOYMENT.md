# Deployment Guide

## Quick Deployment Options

| Method | Best For | Command |
|--------|----------|---------|
| Windows Script | Windows servers | `deploy.bat` |
| Docker | Any OS with Docker | `docker-compose up -d` |
| Manual | Custom setups | See below |

---

## Windows Deployment

### One-Click Deploy

Simply run:

```batch
deploy.bat
```

The script automatically:
- Checks for Node.js installation
- Cleans previous builds
- Installs dependencies
- Creates environment file
- Builds the application
- Starts the server

### What the Script Does

1. **Validates Environment** - Checks Node.js version
2. **Cleans Old Files** - Removes node_modules and dist folders
3. **Installs Dependencies** - Runs `npm install` for backend and frontend
4. **Creates Config** - Generates `.env` if missing
5. **Builds Application** - Compiles TypeScript and React
6. **Starts Server** - Launches the application
7. **Opens Browser** - Opens `http://localhost:3001`

---

## Docker Deployment

### Basic Deployment

```bash
docker-compose up -d
```

### With Custom Environment

```bash
# Create .env file first
cp .env.example .env
# Edit .env with production values

# Then deploy
docker-compose up -d
```

### View Logs

```bash
docker-compose logs -f
```

### Stop Application

```bash
docker-compose down
```

### Update Application

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

---

## Manual Production Deployment

### Prerequisites

- Node.js 20 or higher
- npm 9 or higher

### Steps

```bash
# 1. Install dependencies
npm ci --only=production

# 2. Install client dependencies
cd client && npm ci && cd ..

# 3. Build server
npm run build:server

# 4. Build client
npm run build:client

# 5. Create environment file
cp .env.example .env
# Edit .env with production values

# 6. Start server
NODE_ENV=production node dist/server.js
```

---

## Process Management

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start application
pm2 start dist/server.js --name storagemover

# Enable startup script
pm2 startup
pm2 save

# View logs
pm2 logs storagemover

# Restart
pm2 restart storagemover
```

### Using systemd (Linux)

Create `/etc/systemd/system/storagemover.service`:

```ini
[Unit]
Description=StorageMover Application
After=network.target

[Service]
Type=simple
User=storagemover
WorkingDirectory=/opt/storagemover
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable storagemover
sudo systemctl start storagemover
```

---

## Health Checks

### HTTP Health Endpoint

```bash
curl http://localhost:3001/api/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Docker Health Check

Docker Compose includes automatic health checking every 30 seconds.

---

## SSL/HTTPS Setup

### Using Nginx as Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name storagemover.example.com;

    ssl_certificate /etc/ssl/certs/storagemover.crt;
    ssl_certificate_key /etc/ssl/private/storagemover.key;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Using Let's Encrypt

```bash
sudo certbot --nginx -d storagemover.example.com
```

---

## Firewall Configuration

### Required Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3001 | TCP | Application (or custom PORT) |
| 443 | TCP | HTTPS (with reverse proxy) |

### UFW (Ubuntu)

```bash
sudo ufw allow 3001/tcp
```

### Windows Firewall

The deploy script can optionally configure Windows Firewall.

---

## Backup Strategy

### Database Backup

```bash
# Daily backup cron job
0 2 * * * cp /app/data/storagemover.db /backups/storagemover-$(date +\%Y\%m\%d).db
```

### Docker Volume Backup

```bash
docker run --rm \
  -v storagemover-data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/data-$(date +%Y%m%d).tar.gz /data
```
