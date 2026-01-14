@echo off
setlocal EnableDelayedExpansion

:: ============================================================================
:: StorageMover - Windows One-Click Deploy Script
:: ============================================================================
:: This script handles the complete deployment process including:
:: - Node.js validation
:: - Dependency installation
:: - Build process
:: - Server startup
:: ============================================================================

title StorageMover Deployment

:: Configuration
set "PORT=3001"
set "MIN_NODE_VERSION=18"
set "STARTUP_WAIT=5"
set "MAX_RETRIES=3"

:: Colors (Windows 10+)
set "RED=[91m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "BLUE=[94m"
set "RESET=[0m"

:: ============================================================================
:: Main Script
:: ============================================================================

echo.
echo %BLUE%============================================================================%RESET%
echo %BLUE%                    StorageMover Deployment Script                         %RESET%
echo %BLUE%============================================================================%RESET%
echo.

:: Check for help flag
if "%1"=="--help" goto :ShowHelp
if "%1"=="-h" goto :ShowHelp
if "%1"=="/?" goto :ShowHelp

:: Check for clean flag
if "%1"=="--clean" goto :CleanOnly
if "%1"=="clean" goto :CleanOnly

:: Step 1: Check Node.js
echo %BLUE%[1/7]%RESET% Checking Node.js installation...
call :CheckNodeJS
if errorlevel 1 goto :NodeJSError

:: Step 2: Check and kill existing processes on port
echo %BLUE%[2/7]%RESET% Checking port %PORT%...
call :CheckPort

:: Step 3: Clean previous installation (if needed)
echo %BLUE%[3/7]%RESET% Preparing workspace...
call :CleanWorkspace

:: Step 4: Install backend dependencies
echo %BLUE%[4/7]%RESET% Installing backend dependencies...
call :InstallBackend
if errorlevel 1 goto :InstallError

:: Step 5: Install frontend dependencies
echo %BLUE%[5/7]%RESET% Installing frontend dependencies...
call :InstallFrontend
if errorlevel 1 goto :InstallError

:: Step 6: Create environment file
echo %BLUE%[6/7]%RESET% Configuring environment...
call :CreateEnvFile

:: Step 7: Build application
echo %BLUE%[7/7]%RESET% Building application...
call :BuildApp
if errorlevel 1 goto :BuildError

:: Start server
echo.
echo %GREEN%============================================================================%RESET%
echo %GREEN%                         Starting StorageMover                             %RESET%
echo %GREEN%============================================================================%RESET%
echo.
call :StartServer

goto :End

:: ============================================================================
:: Functions
:: ============================================================================

:CheckNodeJS
:: Verify Node.js is installed and meets minimum version
where node >nul 2>&1
if errorlevel 1 (
    echo %RED%ERROR: Node.js is not installed or not in PATH%RESET%
    exit /b 1
)

for /f "tokens=1" %%v in ('node --version') do set "NODE_VERSION=%%v"
set "NODE_VERSION=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"

if %NODE_MAJOR% LSS %MIN_NODE_VERSION% (
    echo %RED%ERROR: Node.js version %NODE_VERSION% is too old.%RESET%
    echo %RED%       Minimum required version is %MIN_NODE_VERSION%.0.0%RESET%
    exit /b 1
)

echo   %GREEN%✓%RESET% Node.js %NODE_VERSION% detected
where npm >nul 2>&1
if errorlevel 1 (
    echo %RED%ERROR: npm is not available%RESET%
    exit /b 1
)
for /f "tokens=1" %%v in ('npm --version') do set "NPM_VERSION=%%v"
echo   %GREEN%✓%RESET% npm %NPM_VERSION% detected
exit /b 0

:CheckPort
:: Check if port is in use and offer to kill the process
netstat -ano 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo   %YELLOW%!%RESET% Port %PORT% is in use

    :: Find the PID
    for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
        set "PID=%%p"
    )

    if defined PID (
        echo   %YELLOW%!%RESET% Killing process %PID% on port %PORT%...
        taskkill /PID !PID! /F >nul 2>&1
        timeout /t 2 /nobreak >nul
        echo   %GREEN%✓%RESET% Port %PORT% is now available
    )
) else (
    echo   %GREEN%✓%RESET% Port %PORT% is available
)
exit /b 0

:CleanWorkspace
:: Clean old installations that might cause issues
if exist "dist" (
    echo   Removing old build files...
    rmdir /s /q "dist" 2>nul
)
if exist "client\dist" (
    rmdir /s /q "client\dist" 2>nul
)

:: Check for corrupted node_modules
if exist "node_modules" (
    if not exist "node_modules\.package-lock.json" (
        echo   %YELLOW%!%RESET% Detected potentially corrupted node_modules, cleaning...
        call :SafeDeleteNodeModules "node_modules"
    )
)
if exist "client\node_modules" (
    if not exist "client\node_modules\.package-lock.json" (
        echo   %YELLOW%!%RESET% Detected potentially corrupted client node_modules, cleaning...
        call :SafeDeleteNodeModules "client\node_modules"
    )
)

:: Create data directory
if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"

echo   %GREEN%✓%RESET% Workspace ready
exit /b 0

:SafeDeleteNodeModules
:: Safely delete node_modules handling long path issues on Windows
set "TARGET=%~1"
if not exist "%TARGET%" exit /b 0

:: Try normal delete first
rmdir /s /q "%TARGET%" 2>nul
if not exist "%TARGET%" exit /b 0

:: If normal delete fails, use robocopy trick for long paths
echo   Using robocopy method for long paths...
set "EMPTY_DIR=%TEMP%\empty_storagemover_%RANDOM%"
mkdir "%EMPTY_DIR%" 2>nul
robocopy "%EMPTY_DIR%" "%TARGET%" /mir /r:1 /w:1 >nul 2>&1
rmdir /s /q "%TARGET%" 2>nul
rmdir "%EMPTY_DIR%" 2>nul
exit /b 0

:InstallBackend
:: Install backend dependencies with retries
set "RETRY=0"
:BackendRetry
npm install --loglevel=error 2>&1
if errorlevel 1 (
    set /a RETRY+=1
    if !RETRY! LSS %MAX_RETRIES% (
        echo   %YELLOW%!%RESET% Install failed, clearing cache and retrying ^(!RETRY!/%MAX_RETRIES%^)...
        npm cache clean --force >nul 2>&1
        call :SafeDeleteNodeModules "node_modules"
        timeout /t 2 /nobreak >nul
        goto :BackendRetry
    )
    echo   %RED%✗%RESET% Backend install failed after %MAX_RETRIES% attempts
    exit /b 1
)
echo   %GREEN%✓%RESET% Backend dependencies installed
exit /b 0

:InstallFrontend
:: Install frontend dependencies with retries
pushd client
set "RETRY=0"
:FrontendRetry
call npm install --loglevel=error 2>&1
if errorlevel 1 (
    set /a RETRY+=1
    if !RETRY! LSS %MAX_RETRIES% (
        echo   %YELLOW%!%RESET% Install failed, clearing cache and retrying ^(!RETRY!/%MAX_RETRIES%^)...
        call npm cache clean --force >nul 2>&1
        popd
        call :SafeDeleteNodeModules "client\node_modules"
        pushd client
        timeout /t 2 /nobreak >nul
        goto :FrontendRetry
    )
    echo   %RED%✗%RESET% Frontend install failed after %MAX_RETRIES% attempts
    popd
    exit /b 1
)
popd
echo   %GREEN%✓%RESET% Frontend dependencies installed
exit /b 0

:CreateEnvFile
:: Create .env file if it doesn't exist
if not exist ".env" (
    echo   Creating .env file from template...
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
    ) else (
        (
            echo NODE_ENV=production
            echo PORT=%PORT%
            echo JWT_SECRET=storagemover-secret-%RANDOM%%RANDOM%
            echo JWT_EXPIRES_IN=24h
            echo ENCRYPTION_KEY=storagemover-encrypt-%RANDOM%%RANDOM%
            echo DB_PATH=./data/storagemover.db
            echo LOG_LEVEL=info
        ) > ".env"
    )
    echo   %GREEN%✓%RESET% Environment file created
) else (
    echo   %GREEN%✓%RESET% Environment file exists
)
exit /b 0

:BuildApp
:: Build TypeScript backend
echo   Building backend...
call npm run build:server 2>&1
if errorlevel 1 (
    echo   %RED%✗%RESET% Backend build failed
    exit /b 1
)
echo   %GREEN%✓%RESET% Backend built successfully

:: Build React frontend
echo   Building frontend...
pushd client
call npm run build 2>&1
if errorlevel 1 (
    echo   %RED%✗%RESET% Frontend build failed
    popd
    exit /b 1
)
popd
echo   %GREEN%✓%RESET% Frontend built successfully
exit /b 0

:StartServer
:: Start the production server
echo Starting server on port %PORT%...
echo.
echo   %BLUE%→%RESET% Application will be available at: %GREEN%http://localhost:%PORT%%RESET%
echo   %BLUE%→%RESET% Press Ctrl+C to stop the server
echo.

:: Wait a moment then open browser
start "" cmd /c "timeout /t %STARTUP_WAIT% /nobreak >nul && start http://localhost:%PORT%"

:: Start server (this blocks)
set NODE_ENV=production
node dist/server.js
exit /b 0

:CleanOnly
:: Full cleanup mode
echo.
echo %YELLOW%Performing full cleanup...%RESET%
echo.

:: Kill any running server
echo Stopping any running servers...
taskkill /f /im node.exe 2>nul

:: Delete node_modules
echo Removing node_modules...
call :SafeDeleteNodeModules "node_modules"
call :SafeDeleteNodeModules "client\node_modules"

:: Delete build directories
echo Removing build directories...
if exist "dist" rmdir /s /q "dist" 2>nul
if exist "client\dist" rmdir /s /q "client\dist" 2>nul

:: Delete data (optional, uncomment to include)
:: if exist "data" rmdir /s /q "data" 2>nul

:: Delete logs
if exist "logs" rmdir /s /q "logs" 2>nul

:: Clear npm cache
echo Clearing npm cache...
npm cache clean --force >nul 2>&1

echo.
echo %GREEN%Cleanup complete!%RESET%
echo Run %BLUE%deploy.bat%RESET% to reinstall.
goto :End

:ShowHelp
echo.
echo %BLUE%StorageMover Deployment Script%RESET%
echo.
echo Usage: deploy.bat [options]
echo.
echo Options:
echo   --help, -h, /?    Show this help message
echo   --clean, clean    Remove all generated files and dependencies
echo.
echo Description:
echo   This script automates the complete deployment of StorageMover:
echo   1. Validates Node.js installation (v%MIN_NODE_VERSION%+ required)
echo   2. Checks and frees port %PORT% if needed
echo   3. Installs backend and frontend dependencies
echo   4. Creates environment configuration
echo   5. Builds the application
echo   6. Starts the production server
echo   7. Opens browser to http://localhost:%PORT%
echo.
echo Examples:
echo   deploy.bat              Full deployment
echo   deploy.bat --clean      Clean all generated files
echo.
goto :End

:NodeJSError
echo.
echo %RED%============================================================================%RESET%
echo %RED%                           Node.js Not Found                                %RESET%
echo %RED%============================================================================%RESET%
echo.
echo Please install Node.js version %MIN_NODE_VERSION% or higher:
echo.
echo   1. Go to %BLUE%https://nodejs.org%RESET%
echo   2. Download the LTS version (v20 or higher)
echo   3. Run the installer
echo   4. Make sure "Add to PATH" is checked during installation
echo   5. Restart this command prompt
echo   6. Run this script again
echo.
goto :End

:InstallError
echo.
echo %RED%============================================================================%RESET%
echo %RED%                        Installation Failed                                 %RESET%
echo %RED%============================================================================%RESET%
echo.
echo Possible solutions:
echo.
echo   1. Run %BLUE%deploy.bat --clean%RESET% and try again
echo   2. Check your internet connection
echo   3. Try running as Administrator
echo   4. Check antivirus isn't blocking npm
echo   5. See docs/TROUBLESHOOTING.md for more help
echo.
goto :End

:BuildError
echo.
echo %RED%============================================================================%RESET%
echo %RED%                           Build Failed                                     %RESET%
echo %RED%============================================================================%RESET%
echo.
echo Possible solutions:
echo.
echo   1. Run %BLUE%deploy.bat --clean%RESET% and try again
echo   2. Check for TypeScript errors in the output above
echo   3. Ensure all files are present (run git status)
echo   4. See docs/TROUBLESHOOTING.md for more help
echo.
goto :End

:End
echo.
endlocal
pause
