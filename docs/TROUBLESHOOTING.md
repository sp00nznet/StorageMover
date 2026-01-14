# Troubleshooting Guide

## Common Issues

### Installation Issues

#### "node is not recognized" / Node.js not found

**Problem:** Node.js is not installed or not in PATH.

**Solution:**
1. Download Node.js 20+ from https://nodejs.org
2. Run installer with "Add to PATH" option checked
3. Restart terminal/command prompt
4. Verify: `node --version`

#### npm install fails with ENOENT

**Problem:** Long file paths on Windows.

**Solution:**
```bash
# Enable long paths (run as Administrator)
npm config set cache C:\npm-cache --global

# Or use shorter project path
# Move project to C:\projects\StorageMover
```

#### npm install fails with permission errors

**Problem:** Permission denied writing to node_modules.

**Solution:**
```bash
# Windows: Run terminal as Administrator
# Linux/Mac:
sudo chown -R $USER:$USER node_modules
```

#### node_modules won't delete (Windows)

**Problem:** Path too long error.

**Solution:**
```batch
:: Use robocopy to delete
mkdir empty_dir
robocopy empty_dir node_modules /mir
rmdir node_modules
rmdir empty_dir
```

---

### Build Issues

#### TypeScript compilation errors

**Problem:** Type errors during build.

**Solution:**
```bash
# Clear TypeScript cache
rm -rf dist/
npx tsc --build --clean
npm run build:server
```

#### Vite build fails

**Problem:** Frontend build errors.

**Solution:**
```bash
cd client
rm -rf node_modules dist
npm install
npm run build
```

#### "Cannot find module" errors

**Problem:** Missing dependencies after pull.

**Solution:**
```bash
rm -rf node_modules client/node_modules
npm install
cd client && npm install
```

---

### Runtime Issues

#### Port already in use

**Problem:** Error: `listen EADDRINUSE :::3001`

**Solution:**
```bash
# Find and kill process (Windows)
netstat -ano | findstr :3001
taskkill /PID <pid> /F

# Find and kill process (Linux/Mac)
lsof -i :3001
kill -9 <pid>

# Or change port in .env
PORT=3002
```

#### Database locked error

**Problem:** SQLite database is locked.

**Solution:**
1. Stop all running instances
2. Check for zombie processes
3. Delete `data/storagemover.db-journal` if exists
4. Restart application

#### "ECONNREFUSED" when connecting to devices

**Problem:** Cannot reach storage device.

**Solution:**
1. Verify device hostname/IP is correct
2. Check firewall allows connection
3. Verify device API port (usually 8080)
4. Test with: `curl -k https://<hostname>:<port>/session/1/session`

---

### Authentication Issues

#### "Invalid token" after server restart

**Problem:** JWT secret changed or token expired.

**Solution:**
1. Log out and log back in
2. Ensure `JWT_SECRET` in `.env` doesn't change between restarts

#### "Unauthorized" on all API calls

**Problem:** Token not being sent with requests.

**Solution:**
1. Clear browser local storage
2. Log out and log back in
3. Check browser console for errors

---

### Device Connection Issues

#### Isilon authentication fails

**Problem:** Cannot authenticate with Isilon.

**Solution:**
1. Verify username has API access
2. Check user is in "Platform API" role
3. Try credentials in Isilon web UI first
4. Ensure HTTPS is enabled on Isilon

#### PowerScale discovery returns no exports

**Problem:** No exports found on PowerScale.

**Solution:**
1. Verify exports exist in web UI
2. Check user has read permissions on /platform/... APIs
3. Try with admin account first

#### PowerStore connection timeout

**Problem:** Connection to PowerStore times out.

**Solution:**
1. PowerStore uses different API path (`/api/rest`)
2. Verify port (usually 443 for PowerStore)
3. Check network connectivity
4. Verify API user credentials

---

### Docker Issues

#### Container won't start

**Problem:** Docker container exits immediately.

**Solution:**
```bash
# Check logs
docker-compose logs

# Common fixes:
# 1. Ensure .env exists
# 2. Check volume permissions
# 3. Verify port not in use
```

#### "Permission denied" on volume

**Problem:** Container cannot write to volume.

**Solution:**
```bash
# Fix volume permissions
docker-compose down
sudo chown -R 1001:1001 ./data
docker-compose up -d
```

#### Health check failing

**Problem:** Container marked unhealthy.

**Solution:**
```bash
# Check if app is actually running
docker-compose exec storagemover wget -q -O- http://localhost:3001/api/health

# Check logs for errors
docker-compose logs -f
```

---

### Performance Issues

#### Slow migration speeds

**Problem:** Data transfer is slow.

**Solution:**
1. Check network bandwidth between devices
2. Verify no other heavy traffic
3. Consider migrating during off-hours
4. Check storage device I/O load

#### High memory usage

**Problem:** Application using too much memory.

**Solution:**
1. Restart application
2. Limit concurrent migrations
3. Check for memory leaks in logs

---

### Windows-Specific Issues

#### Script execution disabled

**Problem:** Cannot run deploy.bat or PowerShell scripts.

**Solution:**
```powershell
# Run PowerShell as Administrator
Set-ExecutionPolicy RemoteSigned
```

#### Antivirus blocking npm

**Problem:** Antivirus quarantines npm packages.

**Solution:**
1. Add project folder to antivirus exclusions
2. Add `%APPDATA%\npm-cache` to exclusions
3. Temporarily disable real-time protection during install

---

## Getting Help

### Collect Debug Information

```bash
# System info
node --version
npm --version

# Application logs
cat logs/error.log

# Database status
sqlite3 data/storagemover.db "SELECT COUNT(*) FROM devices;"
```

### Log Locations

| Log | Location |
|-----|----------|
| Error logs | `logs/error.log` |
| Combined logs | `logs/combined.log` |
| Docker logs | `docker-compose logs` |

### Reset Everything

Nuclear option - start fresh:

```bash
# Stop everything
docker-compose down 2>/dev/null
pkill -f "node.*server" 2>/dev/null

# Remove all generated files
rm -rf node_modules client/node_modules
rm -rf dist client/dist
rm -rf data logs
rm -f .env

# Start fresh
cp .env.example .env
npm install
cd client && npm install && cd ..
npm run build
npm start
```
