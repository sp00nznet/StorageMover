# Configuration Guide

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Server Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode (`development`, `production`) |
| `PORT` | `3001` | Server port |

### Security Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required) | Secret key for JWT tokens - **CHANGE IN PRODUCTION** |
| `JWT_EXPIRES_IN` | `24h` | Token expiration time |
| `ENCRYPTION_KEY` | (required) | 32-byte key for password encryption - **CHANGE IN PRODUCTION** |

### Database Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/storagemover.db` | SQLite database file path |

### Logging Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level (`error`, `warn`, `info`, `debug`) |

---

## Example Configuration

### Development

```env
NODE_ENV=development
PORT=3001
JWT_SECRET=dev-secret-key
JWT_EXPIRES_IN=24h
ENCRYPTION_KEY=dev-encryption-key-32bytes!
DB_PATH=./data/storagemover.db
LOG_LEVEL=debug
```

### Production

```env
NODE_ENV=production
PORT=3001
JWT_SECRET=your-very-secure-random-secret-key-here
JWT_EXPIRES_IN=8h
ENCRYPTION_KEY=32-byte-secure-encryption-key!!
DB_PATH=/app/data/storagemover.db
LOG_LEVEL=info
```

---

## Docker Configuration

### Environment Variables in Docker Compose

```yaml
services:
  storagemover:
    environment:
      - NODE_ENV=production
      - PORT=3001
      - JWT_SECRET=${JWT_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
```

### Using .env with Docker Compose

Create a `.env` file in the same directory:

```env
JWT_SECRET=your-production-secret
ENCRYPTION_KEY=your-32-byte-encryption-key
```

Docker Compose will automatically load these variables.

---

## Generating Secure Keys

### JWT Secret

```bash
# Linux/Mac
openssl rand -base64 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

### Encryption Key

Must be exactly 32 characters:

```bash
# Linux/Mac
openssl rand -base64 24

# Windows PowerShell
-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

---

## Port Configuration

### Changing the Port

1. Update `.env`:
   ```env
   PORT=8080
   ```

2. Update Docker Compose if using:
   ```yaml
   ports:
     - "8080:8080"
   ```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name storagemover.example.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Database Configuration

### Custom Database Location

```env
DB_PATH=/var/lib/storagemover/database.db
```

Ensure the directory exists and has write permissions.

### Database Backup

```bash
# Simple backup
cp ./data/storagemover.db ./backups/storagemover-$(date +%Y%m%d).db

# With compression
sqlite3 ./data/storagemover.db .dump | gzip > ./backups/backup-$(date +%Y%m%d).sql.gz
```

---

## Logging Configuration

### Log Levels

| Level | Description |
|-------|-------------|
| `error` | Only errors |
| `warn` | Errors and warnings |
| `info` | General information (default) |
| `debug` | Detailed debugging info |

### Log Files

Logs are written to:
- `logs/error.log` - Error-level logs only
- `logs/combined.log` - All logs

Each file is limited to 5MB with 5 rotated copies.
