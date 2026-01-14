# ============================================================================
# StorageMover - Windows PowerShell Deployment Script
# ============================================================================
# Run with: powershell -ExecutionPolicy Bypass -File deploy.ps1
# ============================================================================

param(
    [switch]$Clean,
    [switch]$Help,
    [int]$Port = 3001
)

$ErrorActionPreference = "Stop"

# Configuration
$MIN_NODE_VERSION = 18
$MAX_RETRIES = 3
$STARTUP_WAIT = 5

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host "[$Step] " -ForegroundColor Blue -NoNewline
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "  ✓ " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warning {
    param([string]$Message)
    Write-Host "  ! " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Error {
    param([string]$Message)
    Write-Host "  ✗ " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Show-Banner {
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "                    StorageMover Deployment Script                         " -ForegroundColor Blue
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
}

function Show-Help {
    Write-Host ""
    Write-Host "StorageMover Deployment Script" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Usage: .\deploy.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Help              Show this help message"
    Write-Host "  -Clean             Remove all generated files and dependencies"
    Write-Host "  -Port <number>     Specify port (default: 3001)"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\deploy.ps1                  Full deployment"
    Write-Host "  .\deploy.ps1 -Clean           Clean all generated files"
    Write-Host "  .\deploy.ps1 -Port 8080       Deploy on port 8080"
    Write-Host ""
}

function Test-NodeJS {
    Write-Step "1/7" "Checking Node.js installation..."

    try {
        $nodeVersion = node --version 2>$null
        if (-not $nodeVersion) { throw "Node.js not found" }

        $versionNumber = $nodeVersion -replace 'v', ''
        $majorVersion = [int]($versionNumber.Split('.')[0])

        if ($majorVersion -lt $MIN_NODE_VERSION) {
            throw "Node.js version $nodeVersion is too old. Minimum required: v$MIN_NODE_VERSION.0.0"
        }

        Write-Success "Node.js $nodeVersion detected"

        $npmVersion = npm --version 2>$null
        if (-not $npmVersion) { throw "npm not found" }
        Write-Success "npm $npmVersion detected"

        return $true
    }
    catch {
        Write-Error $_.Exception.Message
        Write-Host ""
        Write-Host "Please install Node.js version $MIN_NODE_VERSION or higher:" -ForegroundColor Red
        Write-Host "  1. Go to https://nodejs.org" -ForegroundColor Yellow
        Write-Host "  2. Download the LTS version (v20 or higher)"
        Write-Host "  3. Run the installer with 'Add to PATH' checked"
        Write-Host "  4. Restart PowerShell and run this script again"
        return $false
    }
}

function Stop-PortProcess {
    Write-Step "2/7" "Checking port $Port..."

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

    if ($connection) {
        Write-Warning "Port $Port is in use"
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue

        if ($process) {
            Write-Warning "Stopping process $($process.Name) (PID: $($process.Id))..."
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        Write-Success "Port $Port is now available"
    }
    else {
        Write-Success "Port $Port is available"
    }
}

function Remove-NodeModulesSafe {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return }

    # Try normal removal first
    try {
        Remove-Item -Path $Path -Recurse -Force -ErrorAction Stop
        return
    }
    catch {
        # If fails (long paths), use robocopy trick
        Write-Warning "Using robocopy method for long paths..."
        $emptyDir = Join-Path $env:TEMP "empty_sm_$(Get-Random)"
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        robocopy $emptyDir $Path /mir /r:1 /w:1 2>&1 | Out-Null
        Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $emptyDir -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-Workspace {
    Write-Step "3/7" "Preparing workspace..."

    # Clean old builds
    if (Test-Path "dist") {
        Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path "client\dist") {
        Remove-Item -Path "client\dist" -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Check for corrupted node_modules
    if ((Test-Path "node_modules") -and -not (Test-Path "node_modules\.package-lock.json")) {
        Write-Warning "Detected potentially corrupted node_modules, cleaning..."
        Remove-NodeModulesSafe "node_modules"
    }
    if ((Test-Path "client\node_modules") -and -not (Test-Path "client\node_modules\.package-lock.json")) {
        Write-Warning "Detected potentially corrupted client node_modules, cleaning..."
        Remove-NodeModulesSafe "client\node_modules"
    }

    # Create required directories
    if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" | Out-Null }
    if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

    Write-Success "Workspace ready"
}

function Install-BackendDependencies {
    Write-Step "4/7" "Installing backend dependencies..."

    for ($retry = 1; $retry -le $MAX_RETRIES; $retry++) {
        try {
            npm install --loglevel=error 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
            Write-Success "Backend dependencies installed"
            return $true
        }
        catch {
            if ($retry -lt $MAX_RETRIES) {
                Write-Warning "Install failed, clearing cache and retrying ($retry/$MAX_RETRIES)..."
                npm cache clean --force 2>&1 | Out-Null
                Remove-NodeModulesSafe "node_modules"
                Start-Sleep -Seconds 2
            }
            else {
                Write-Error "Backend install failed after $MAX_RETRIES attempts"
                return $false
            }
        }
    }
}

function Install-FrontendDependencies {
    Write-Step "5/7" "Installing frontend dependencies..."

    Push-Location client
    try {
        for ($retry = 1; $retry -le $MAX_RETRIES; $retry++) {
            try {
                npm install --loglevel=error 2>&1 | Out-Host
                if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
                Write-Success "Frontend dependencies installed"
                return $true
            }
            catch {
                if ($retry -lt $MAX_RETRIES) {
                    Write-Warning "Install failed, clearing cache and retrying ($retry/$MAX_RETRIES)..."
                    npm cache clean --force 2>&1 | Out-Null
                    Pop-Location
                    Remove-NodeModulesSafe "client\node_modules"
                    Push-Location client
                    Start-Sleep -Seconds 2
                }
                else {
                    Write-Error "Frontend install failed after $MAX_RETRIES attempts"
                    return $false
                }
            }
        }
    }
    finally {
        Pop-Location
    }
}

function New-EnvFile {
    Write-Step "6/7" "Configuring environment..."

    if (-not (Test-Path ".env")) {
        if (Test-Path ".env.example") {
            Copy-Item ".env.example" ".env"
        }
        else {
            $randomSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_})
            $randomKey = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_})

            @"
NODE_ENV=production
PORT=$Port
JWT_SECRET=$randomSecret
JWT_EXPIRES_IN=24h
ENCRYPTION_KEY=$randomKey
DB_PATH=./data/storagemover.db
LOG_LEVEL=info
"@ | Set-Content ".env"
        }
        Write-Success "Environment file created"
    }
    else {
        Write-Success "Environment file exists"
    }
}

function Build-Application {
    Write-Step "7/7" "Building application..."

    # Build backend
    Write-Host "  Building backend..."
    npm run build:server 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Backend build failed"
        return $false
    }
    Write-Success "Backend built successfully"

    # Build frontend
    Write-Host "  Building frontend..."
    Push-Location client
    try {
        npm run build 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Frontend build failed"
            return $false
        }
        Write-Success "Frontend built successfully"
    }
    finally {
        Pop-Location
    }

    return $true
}

function Start-Application {
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Green
    Write-Host "                         Starting StorageMover                             " -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  → Application will be available at: " -ForegroundColor Blue -NoNewline
    Write-Host "http://localhost:$Port" -ForegroundColor Green
    Write-Host "  → Press Ctrl+C to stop the server" -ForegroundColor Blue
    Write-Host ""

    # Open browser after delay
    Start-Job -ScriptBlock {
        param($Port, $Wait)
        Start-Sleep -Seconds $Wait
        Start-Process "http://localhost:$Port"
    } -ArgumentList $Port, $STARTUP_WAIT | Out-Null

    # Start server
    $env:NODE_ENV = "production"
    node dist/server.js
}

function Invoke-Clean {
    Write-Host ""
    Write-Host "Performing full cleanup..." -ForegroundColor Yellow
    Write-Host ""

    # Kill Node processes
    Write-Host "Stopping any running servers..."
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Remove node_modules
    Write-Host "Removing node_modules..."
    Remove-NodeModulesSafe "node_modules"
    Remove-NodeModulesSafe "client\node_modules"

    # Remove build directories
    Write-Host "Removing build directories..."
    Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "client\dist" -Recurse -Force -ErrorAction SilentlyContinue

    # Remove logs
    Remove-Item -Path "logs" -Recurse -Force -ErrorAction SilentlyContinue

    # Clear npm cache
    Write-Host "Clearing npm cache..."
    npm cache clean --force 2>&1 | Out-Null

    Write-Host ""
    Write-Host "Cleanup complete!" -ForegroundColor Green
    Write-Host "Run " -NoNewline
    Write-Host ".\deploy.ps1" -ForegroundColor Blue -NoNewline
    Write-Host " to reinstall."
}

# ============================================================================
# Main Execution
# ============================================================================

if ($Help) {
    Show-Help
    exit 0
}

if ($Clean) {
    Show-Banner
    Invoke-Clean
    exit 0
}

Show-Banner

# Run deployment steps
if (-not (Test-NodeJS)) { exit 1 }
Stop-PortProcess
Initialize-Workspace
if (-not (Install-BackendDependencies)) { exit 1 }
if (-not (Install-FrontendDependencies)) { exit 1 }
New-EnvFile
if (-not (Build-Application)) { exit 1 }
Start-Application
